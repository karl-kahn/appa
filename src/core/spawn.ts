// pattern: imperative-shell
// Spawn `claude -p` with a project-defined persona and stream events back.

import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { SpawnEvent } from "./types.js";

export interface SpawnOptions {
  message: string;
  systemPromptAppend?: string;
  claudeSessionId: string;
  resume?: boolean;
  model?: string;
  /**
   * Additional tools to disallow, ADDED to `DEFAULT_DISALLOWED_TOOLS`.
   * The defaults can never be removed via this knob — passing `[]`
   * does NOT lift the default ban. The polarity is opt-in (add-more),
   * not opt-out, to prevent a caller from accidentally re-enabling
   * Bash/Write/Edit/etc. /angel finding F6 (Adversarial Critical).
   */
  extraDisallowedTools?: string[];
  signal?: AbortSignal;
  /** Optional override for the executable path (mainly for tests). */
  claudeBinary?: string;
}

export const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(*)",
  "Write(*)",
  "Edit(*)",
  "NotebookEdit(*)",
  "Read(*)",
  "Glob(*)",
  "Grep(*)",
  "Agent(*)",
  "WebFetch(*)",
  "WebSearch(*)",
  "TodoRead(*)",
  "TodoWrite(*)",
  "mcp__*",
];

/** Build the env passed to the spawned child. Strips everything we don't whitelist. */
export function buildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = ["HOME", "PATH", "TERM", "LANG", "ANTHROPIC_API_KEY", "XDG_CONFIG_HOME"] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = parent[key];
    if (typeof v === "string") env[key] = v;
  }
  // CLAUDECODE / CLAUDE_CODE_ENTRYPOINT cause the spawned `claude` to exit silently.
  // We never inherit them; the whitelist above guarantees that, but be explicit.
  return env;
}

export function buildArgs(options: SpawnOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    options.model ?? "sonnet",
    "--setting-sources",
    "project",
  ];
  if (options.resume) {
    args.push("--resume", options.claudeSessionId);
  } else {
    args.push("--session-id", options.claudeSessionId);
  }
  if (options.systemPromptAppend && options.systemPromptAppend.trim().length > 0) {
    args.push("--append-system-prompt", options.systemPromptAppend);
  }
  // Defense in depth: always emit the full default disallow list. Callers
  // can only ADD bans via extraDisallowedTools; they cannot remove any.
  const disallowed = new Set([
    ...DEFAULT_DISALLOWED_TOOLS,
    ...(options.extraDisallowedTools ?? []),
  ]);
  for (const tool of disallowed) {
    args.push("--disallowed-tools", tool);
  }
  return args;
}

/** Spawn claude and yield SpawnEvents. Caller is responsible for piping the user message into stdin. */
export async function* spawnClaude(options: SpawnOptions): AsyncGenerator<SpawnEvent> {
  const bin = options.claudeBinary ?? "claude";
  const args = buildArgs(options);
  const env = buildEnv();

  const child: ChildProcessWithoutNullStreams = nodeSpawn(bin, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
  });

  child.stdin.write(options.message);
  child.stdin.end();

  const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const errChunks: string[] = [];
  child.stderr.on("data", (d) => errChunks.push(String(d)));

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Stream JSON lines should always be JSON; surface anomalies as text events
        yield { type: "text", text: trimmed };
        continue;
      }
      const event = mapStreamEvent(parsed);
      if (event) yield event;
    }
    const exit = await exitPromise;
    if (exit.code !== 0) {
      yield {
        type: "error",
        error: `claude exited with code ${exit.code}${exit.signal ? ` (signal ${exit.signal})` : ""}: ${errChunks.join("").slice(-500)}`,
      };
      return;
    }
    yield { type: "done" };
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Map raw stream-json events to SpawnEvent.
 *
 * Two shapes we handle:
 * - `stream_event` deltas (emitted because of --include-partial-messages):
 *   incremental `{event:{type:"content_block_delta",delta:{type:"text_delta",text}}}`
 * - Complete `assistant` messages (one per turn with full content array):
 *   `{type:"assistant",message:{content:[{type:"text",text}, ...]}}`
 *
 * We INTENTIONALLY ignore `tool_use` / `tool_result` blocks. Appa's tool
 * round-trip is text-embedded (`|||TOOL_CALL|||`) — it works because the
 * spawned `claude` runs with `--disallowed-tools` covering every native
 * tool, so the model has nothing to emit as a `tool_use` content block.
 * If a tool ever sneaks past the disallow list, the `tool_use` will arrive
 * here and we LOG LOUDLY rather than silently swallow it (the previous
 * behavior). Audited by /angel 2026-05-25 (RTFM/Test/Future-Me consensus).
 */
function mapStreamEvent(raw: unknown): SpawnEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  // Token-level delta from --include-partial-messages
  if (type === "stream_event" && typeof obj.event === "object" && obj.event !== null) {
    const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      return { type: "text", text: ev.delta.text, raw };
    }
    return null;
  }

  // Complete assistant message (one per turn). Includes the full content array;
  // we extract any text blocks and warn on any non-text content (invariant violation).
  if (type === "assistant" && typeof obj.message === "object" && obj.message !== null) {
    const msg = obj.message as {
      content?: Array<{ type?: string; text?: string; name?: string }>;
    };
    const blocks = msg.content ?? [];
    for (const c of blocks) {
      if (c.type === "tool_use" || c.type === "tool_result") {
        console.error(
          `appa/spawn: unexpected ${c.type} content block (tool name: ${c.name ?? "?"}). Appa's protocol is text-embedded |||TOOL_CALL|||; native tool_use blocks indicate a tool slipped past the disallow list. This event will not be dispatched.`,
        );
      }
    }
    const text = blocks
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text) return { type: "text", text, raw };
  }

  // `result` and `system` events are control-plane noise; ignore.
  return null;
}
