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
  disallowedTools?: string[];
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
  const disallowed = options.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
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

/** Map raw stream-json events to SpawnEvent. Tolerant of schema drift. */
function mapStreamEvent(raw: unknown): SpawnEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  // assistant text delta
  if (type === "assistant" && typeof obj.message === "object" && obj.message !== null) {
    const msg = obj.message as { content?: Array<{ type?: string; text?: string }> };
    const text = (msg.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text) return { type: "text", text, raw };
  }
  if (type === "result" || type === "system") return null;
  return null;
}
