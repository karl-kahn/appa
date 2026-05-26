// pattern: imperative-shell
// The chat loop: validate, spawn, stream, dispatch tool calls, repeat.

import type { Request, Response, Router } from "express";
import type { ResolvedConfig } from "../core/config.js";
import type { MemoryStore } from "../core/memory.js";
import {
  type RateLimitState,
  canSpawn,
  createRateLimitState,
  snapshot as rateLimitSnapshot,
  recordSpawn,
} from "../core/rate-limit.js";
import { spawnClaude } from "../core/spawn.js";
import type { TeamReader } from "../core/team.js";
import {
  type ThreadStore,
  callerOwnsThread,
  newClaudeSessionId,
  sanitizeThreadId,
} from "../core/thread.js";
import { parseToolCalls, stripToolBlocks } from "../core/tools.js";
import type { TranscriptStore } from "../core/transcript.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { CallerIdentity } from "../modules/types.js";

/**
 * Per-caller rate-limit state. The kernel rate-limits per caller id,
 * not globally, so one rogue student can't lock out the rest of the
 * classroom. Keyed by `caller.id`; states are created lazily.
 */
export interface PerCallerRateState {
  byId: Map<string, RateLimitState>;
  hourlyLimit: number;
  dailyLimit: number;
}

export interface ChatDeps {
  config: ResolvedConfig;
  threads: ThreadStore;
  transcripts: TranscriptStore;
  memory: MemoryStore;
  team: TeamReader;
  registry: ModuleRegistry;
  rateState: PerCallerRateState;
  /**
   * Tutor persona text, loaded once at boot from `config.tutorPromptPath`.
   * Cached on the deps object so the chat hot path doesn't re-read it
   * per request — the file is stable across a server boot.
   */
  persona: string;
}

const MAX_MESSAGE = 5000;

export function createPerCallerRateState(hourly: number, daily: number): PerCallerRateState {
  return { byId: new Map(), hourlyLimit: hourly, dailyLimit: daily };
}

function getCallerRateState(state: PerCallerRateState, id: string): RateLimitState {
  let st = state.byId.get(id);
  if (!st) {
    st = createRateLimitState(state.hourlyLimit, state.dailyLimit);
    state.byId.set(id, st);
  }
  return st;
}

export function mountChat(router: Router, deps: ChatDeps): void {
  // Threads URL: /api/chat/threads/:threadId. The threadId is a stable
  // identifier (kid's name in the simple case, server-generated UUID
  // for shared/pair threads). Identity comes from caller, not from this slug.
  router.post("/api/chat/threads/:threadId", (req, res) => {
    handleChat(req, res, deps).catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
      } else {
        sse(res, "error", {
          error: err instanceof Error ? err.message : "internal error",
        });
        res.end();
      }
    });
  });

  router.get("/api/usage", async (req, res) => {
    const caller = await resolveOr403(req, res, deps);
    if (!caller) return;
    const st = getCallerRateState(deps.rateState, caller.id);
    res.json(rateLimitSnapshot(st));
  });
}

/**
 * Look up the caller via the configured resolver. If no resolver is
 * configured or it returns null, write a 403 to `res` and return null
 * so the caller can early-return. Centralizes the auth gate.
 */
export async function resolveOr403(
  req: Request,
  res: Response,
  deps: { config: ResolvedConfig },
): Promise<CallerIdentity | null> {
  const resolver = deps.config.resolveCaller;
  if (!resolver) {
    res.status(403).json({
      error:
        "appa: no resolveCaller configured. The kernel rejects requests by default; " +
        "supply config.resolveCaller (or devAuth() for local development).",
    });
    return null;
  }
  const caller = await resolver(req);
  if (!caller) {
    res.status(403).json({ error: "unknown caller" });
    return null;
  }
  return caller;
}

async function handleChat(req: Request, res: Response, deps: ChatDeps): Promise<void> {
  const { threads, transcripts, memory, team, registry, rateState, config } = deps;

  const rawId = typeof req.params.threadId === "string" ? req.params.threadId : "";
  const body = (req.body ?? {}) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "";

  if (!message || message.length > MAX_MESSAGE) {
    res.status(400).json({ error: "invalid message length" });
    return;
  }

  const caller = await resolveOr403(req, res, deps);
  if (!caller) return;

  let threadId: string;
  try {
    threadId = sanitizeThreadId(rawId);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid thread id" });
    return;
  }

  // Ownership: existing thread must include caller (or caller is coach).
  // New thread: id must equal caller.id (default convention) OR caller is coach.
  const existing = await threads.get(threadId);
  if (existing) {
    if (!callerOwnsThread(caller, existing)) {
      res.status(403).json({ error: "thread is owned by another participant" });
      return;
    }
  } else if (!caller.isCoach && threadId !== caller.id) {
    res.status(403).json({
      error: "thread id must equal caller id for non-coach callers (or caller must be coach)",
    });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Per-caller rate limit
  const callerState = getCallerRateState(rateState, caller.id);
  const check = canSpawn(callerState);
  if (!check.ok) {
    sse(res, "error", { error: check.reason ?? "rate limited" });
    res.end();
    return;
  }
  rateState.byId.set(caller.id, recordSpawn(check.state));

  // Thread: existing one if found above, else create with caller as owner.
  const thread = existing ?? (await threads.getOrCreate(threadId, { ownerId: caller.id }));
  if (!thread.claudeSessionId) {
    await threads.setClaudeId(thread.id, newClaudeSessionId());
  }
  // If the caller is in-coach-or-other capacity and not yet a participant,
  // record them so future ownership checks pass without re-deriving coach.
  if (caller.id !== thread.ownerId && !thread.coParticipantIds.includes(caller.id)) {
    await threads.addCoParticipant(thread.id, caller.id);
  }
  const refreshed = (await threads.get(thread.id)) ?? thread;
  if (!refreshed.claudeSessionId) {
    throw new Error("thread: claudeSessionId was not set after setClaudeId");
  }
  const claudeId = refreshed.claudeSessionId;
  const resumeFromStart = refreshed.hasMessages;

  // Build system prompt (persona cached at boot; memory + team cached in their stores)
  const persona = deps.persona;
  const memoryText = await memory.read();
  const member = await team.findById(caller.id);
  const threadBlock = `[Thread: ${thread.id} (owner: ${refreshed.ownerId}; caller: ${member?.name ?? caller.id} as ${member?.role ?? "member"})]\n`;
  const systemPrompt = [
    persona,
    registry.promptFragment,
    memoryText,
    threadBlock,
    config.extraSystemPrompt,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  await transcripts.append(thread.id, {
    at: new Date().toISOString(),
    role: "user",
    text: message,
    participantIds: [caller.id],
  });

  let round = 0;
  let nextInput = message;
  let assembledText = "";

  while (round < config.maxToolRounds) {
    round++;
    let roundText = "";

    try {
      for await (const ev of spawnClaude({
        message: nextInput,
        systemPromptAppend: round === 1 ? systemPrompt : "",
        claudeSessionId: claudeId,
        resume: resumeFromStart || round > 1,
        model: config.model,
      })) {
        if (ev.type === "text" && ev.text) {
          roundText += ev.text;
          const visible = ev.text.includes("|||TOOL_CALL|||") ? stripToolBlocks(ev.text) : ev.text;
          if (visible) sse(res, "text", { text: visible, round });
        } else if (ev.type === "error") {
          const msg = ev.error ?? "spawn error";
          logChatError({
            threadId: thread.id,
            callerId: caller.id,
            claudeSessionId: claudeId,
            round,
            phase: "stream",
            error: msg,
          });
          sse(res, "error", { error: msg });
          res.end();
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "spawn failed";
      logChatError({
        threadId: thread.id,
        callerId: caller.id,
        claudeSessionId: claudeId,
        round,
        phase: "spawn",
        error: msg,
      });
      sse(res, "error", { error: msg });
      res.end();
      return;
    }

    await threads.markHasMessages(thread.id);

    const calls = parseToolCalls(roundText);
    assembledText += stripToolBlocks(roundText);

    if (calls.length === 0) break;

    const threadRecord = (await threads.get(thread.id)) ?? refreshed;
    const results: Array<Record<string, unknown>> = [];
    for (const parsed of calls) {
      if (!parsed.call) {
        results.push({ error: parsed.parseError ?? "parse error" });
        continue;
      }
      const r = await registry.invoke(parsed.call.tool, {
        params: parsed.call.params,
        thread: threadRecord,
        caller,
      });
      if (r.ok) {
        await threads.recordMutation(thread.id, {
          tool: parsed.call.tool,
          params: parsed.call.params,
          sessionName: thread.id,
          at: new Date().toISOString(),
        });
        await transcripts.append(thread.id, {
          at: new Date().toISOString(),
          role: "tool",
          toolCall: parsed.call,
          toolResult: r.result,
        });
        results.push({ tool: parsed.call.tool, result: r.result });
        sse(res, "tool", { tool: parsed.call.tool, ok: true, result: r.result });
      } else {
        await transcripts.append(thread.id, {
          at: new Date().toISOString(),
          role: "tool",
          toolCall: parsed.call,
          toolResult: { error: r.error },
        });
        results.push({ tool: parsed.call.tool, error: r.error });
        sse(res, "tool", { tool: parsed.call.tool, ok: false, error: r.error });
      }
    }
    nextInput = JSON.stringify({ tool_results: results });
  }

  if (assembledText.trim().length > 0) {
    await transcripts.append(thread.id, {
      at: new Date().toISOString(),
      role: "assistant",
      text: assembledText,
    });
  }

  sse(res, "done", { rounds: round });
  res.end();
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Structured-log a spawn or chat-loop error to stderr. SSE drops the
 * error to the client and the body is gone; without this the IT desk
 * gets an "AI is broken" ticket with no way to look up what happened
 * for which thread/caller. /angel finding F72 (Blindspot Minor).
 *
 * Single JSON line per event so vector/loki/cloudwatch can ingest
 * without parsing prose. Stderr (not stdout) so it can't accidentally
 * land in a sibling tool's stdout-pipe consumer.
 */
function logChatError(payload: {
  threadId?: string;
  callerId?: string;
  claudeSessionId?: string | null;
  round?: number;
  phase: "spawn" | "loop" | "stream";
  error: string;
}): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      source: "appa/chat",
      ...payload,
      errorTail: payload.error.length > 500 ? `${payload.error.slice(0, 500)}…` : payload.error,
    }),
  );
}
