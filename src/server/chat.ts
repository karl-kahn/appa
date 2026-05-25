// pattern: imperative-shell
// The chat loop: validate, spawn, stream, dispatch tool calls, repeat.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Response, Router } from "express";
import type { ResolvedConfig } from "../core/config.js";
import { canSpawn, type RateLimitState, recordSpawn } from "../core/rate-limit.js";
import { newClaudeSessionId, type SessionStore } from "../core/session.js";
import { spawnClaude } from "../core/spawn.js";
import type { TranscriptStore } from "../core/transcript.js";
import type { MemoryStore } from "../core/memory.js";
import type { TeamReader } from "../core/team.js";
import { parseToolCalls, stripToolBlocks } from "../core/tools.js";
import type { ModuleRegistry } from "../modules/registry.js";

export interface ChatDeps {
  config: ResolvedConfig;
  sessions: SessionStore;
  transcripts: TranscriptStore;
  memory: MemoryStore;
  team: TeamReader;
  registry: ModuleRegistry;
  rateState: { current: RateLimitState };
  /** A predicate so route layer can swap auth in. Default: must exist in team.json. */
  resolveCaller?(req: Request): Promise<{ id: string; isCoach: boolean } | null>;
}

const MAX_MESSAGE = 5000;

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

  router.get("/api/usage", (_req, res) => {
    const s = deps.rateState.current;
    res.json({
      hourly: s.timestamps.filter((t) => t >= Date.now() - 60 * 60 * 1000).length,
      daily: s.timestamps.length,
      hourlyLimit: s.hourlyLimit,
      dailyLimit: s.dailyLimit,
    });
  });
}

async function handleChat(req: Request, res: Response, deps: ChatDeps): Promise<void> {
  const { config, sessions, transcripts, memory, team, registry, rateState } = deps;

  const rawName = typeof req.params.sessionName === "string" ? req.params.sessionName : "";
  const body = (req.body ?? {}) as { message?: unknown; asUserId?: unknown };
  const message = typeof body.message === "string" ? body.message : "";
  const asUserId = typeof body.asUserId === "string" ? body.asUserId : "";

  if (!message || message.length > MAX_MESSAGE) {
    res.status(400).json({ error: "invalid message length" });
    return;
  }

  const caller = deps.resolveCaller
    ? await deps.resolveCaller(req)
    : await defaultResolveCaller(team, asUserId);
  if (!caller) {
    res.status(403).json({ error: "unknown caller" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Rate limit
  const check = canSpawn(rateState.current);
  if (!check.ok) {
    sse(res, "error", { error: check.reason ?? "rate limited" });
    res.end();
    return;
  }
  rateState.current = recordSpawn(check.state);

  // Session
  const session = await sessions.getOrCreate(rawName);
  if (!session.claudeSessionId) {
    await sessions.setClaudeId(session.name, newClaudeSessionId());
  }
  await sessions.setParticipants(session.name, [
    ...new Set([...session.participantIds, caller.id]),
  ]);
  const refreshed = (await sessions.get(session.name)) ?? session;
  const claudeId = refreshed.claudeSessionId ?? newClaudeSessionId();
  const resumeFromStart = refreshed.hasMessages;

  // Build system prompt
  const persona = await safeRead(join(config.projectDir, config.tutorPromptPath));
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
          // Stream only the visible portion (drop TOOL_CALL blocks)
          const visible = stripToolBlocks(ev.text);
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
        isCoach: caller.isCoach,
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

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function defaultResolveCaller(
  team: TeamReader,
  asUserId: string,
): Promise<{ id: string; isCoach: boolean } | null> {
  if (!asUserId) return null;
  const m = await team.findById(asUserId);
  if (!m) return null;
  return { id: m.id, isCoach: m.role === "coach" };
}
