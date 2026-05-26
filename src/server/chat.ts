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
import { type SessionStore, newClaudeSessionId, sanitizeSessionName } from "../core/session.js";
import { spawnClaude } from "../core/spawn.js";
import type { TeamReader } from "../core/team.js";
import { parseToolCalls, stripToolBlocks } from "../core/tools.js";
import type { TranscriptStore } from "../core/transcript.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { CallerIdentity } from "../modules/types.js";
import { callerOwnsSession } from "./auth.js";

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
  sessions: SessionStore;
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
  router.post("/api/chat/:sessionName", (req, res) => {
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
  const { sessions, transcripts, memory, team, registry, rateState, config } = deps;

  const rawName = typeof req.params.sessionName === "string" ? req.params.sessionName : "";
  const body = (req.body ?? {}) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "";

  if (!message || message.length > MAX_MESSAGE) {
    res.status(400).json({ error: "invalid message length" });
    return;
  }

  const caller = await resolveOr403(req, res, deps);
  if (!caller) return;

  let safeName: string;
  try {
    safeName = sanitizeSessionName(rawName);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "invalid session name" });
    return;
  }

  // Ownership: existing session must be owned by caller (or coach);
  // new session names must equal the caller's id (or caller is coach).
  const existing = await sessions.get(safeName);
  if (existing) {
    if (!callerOwnsSession(caller, existing)) {
      res.status(403).json({ error: "session is owned by another caller" });
      return;
    }
  } else if (!caller.isCoach && safeName !== caller.id) {
    res.status(403).json({ error: "session name must equal caller id (or caller must be coach)" });
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

  // Session
  const session = await sessions.getOrCreate(safeName);
  if (!session.claudeSessionId) {
    await sessions.setClaudeId(session.name, newClaudeSessionId());
  }
  await sessions.setParticipants(session.name, [
    ...new Set([...session.participantIds, caller.id]),
  ]);
  const refreshed = (await sessions.get(session.name)) ?? session;
  if (!refreshed.claudeSessionId) {
    throw new Error("session: claudeSessionId was not set after setClaudeId");
  }
  const claudeId = refreshed.claudeSessionId;
  const resumeFromStart = refreshed.hasMessages;

  // Build system prompt (persona cached at boot; memory + team cached in their stores)
  const persona = deps.persona;
  const memoryText = await memory.read();
  const member = await team.findById(caller.id);
  const sessionBlock = `[Session: ${session.name} (${member?.role ?? "member"})]\nParticipants: ${member?.name ?? caller.id}\n`;
  const systemPrompt = [
    persona,
    registry.promptFragment,
    memoryText,
    sessionBlock,
    config.extraSystemPrompt,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  await transcripts.append(session.name, {
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
          // Stream only the visible portion. Cheap gate before the regex —
          // most chunks have no TOOL_CALL marker, so skip the lazy-dotall
          // scan when we can. (perf F29)
          const visible = ev.text.includes("|||TOOL_CALL|||") ? stripToolBlocks(ev.text) : ev.text;
          if (visible) sse(res, "text", { text: visible, round });
        } else if (ev.type === "error") {
          sse(res, "error", { error: ev.error ?? "spawn error" });
          res.end();
          return;
        }
      }
    } catch (err) {
      sse(res, "error", {
        error: err instanceof Error ? err.message : "spawn failed",
      });
      res.end();
      return;
    }

    await sessions.markHasMessages(session.name);

    const calls = parseToolCalls(roundText);
    assembledText += stripToolBlocks(roundText);

    if (calls.length === 0) break;

    const sessionRecord = (await sessions.get(session.name)) ?? refreshed;
    const results: Array<Record<string, unknown>> = [];
    for (const parsed of calls) {
      if (!parsed.call) {
        results.push({ error: parsed.parseError ?? "parse error" });
        continue;
      }
      const r = await registry.invoke(parsed.call.tool, {
        params: parsed.call.params,
        session: sessionRecord,
        caller,
      });
      if (r.ok) {
        await sessions.recordMutation(session.name, {
          tool: parsed.call.tool,
          params: parsed.call.params,
          sessionName: session.name,
          at: new Date().toISOString(),
        });
        await transcripts.append(session.name, {
          at: new Date().toISOString(),
          role: "tool",
          toolCall: parsed.call,
          toolResult: r.result,
        });
        results.push({ tool: parsed.call.tool, result: r.result });
        sse(res, "tool", { tool: parsed.call.tool, ok: true, result: r.result });
      } else {
        await transcripts.append(session.name, {
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
    await transcripts.append(session.name, {
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
