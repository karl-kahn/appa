// pattern: types-only
import type { Request } from "express";
import type { AppaModule, CallerIdentity } from "../modules/types.js";
import type { OnTranscriptAppend } from "./transcript.js";

/**
 * Identity resolver. The kernel calls this on every request that needs a
 * caller (chat, session-scoped routes, tool dispatch). Returning `null`
 * rejects the request with 403. Deployments MUST supply one in any
 * environment where the server is reachable by more than one user.
 *
 * The default (`null`) is deny-all — `appa` ships no identity guesser.
 * For local development, use `devAuth()` from "appa" — it trusts a
 * client-supplied `asUserId` body field and is intentionally not safe
 * for any deployment.
 */
export type ResolveCaller = (req: Request) => Promise<CallerIdentity | null>;

export interface AppaConfig {
  /** Where team.json, transcripts/, shared-memory.md live. Default: cwd. */
  projectDir?: string;
  /** Bind port. Default 3848. */
  port?: number;
  /** Bind host. Default 127.0.0.1. */
  host?: string;
  /** Path to tutor-prompt.md, relative to projectDir. Default: "tutor-prompt.md". */
  tutorPromptPath?: string;
  /** Path to shared-memory.md, relative to projectDir. Default: "shared-memory.md". */
  sharedMemoryPath?: string;
  /** Path to team.json, relative to projectDir. Default: "team.json". */
  teamPath?: string;
  /** Claude model. Default "sonnet". */
  model?: string;
  /** Spawn limits. Defaults: 20/hr, 100/day. */
  hourlyLimit?: number;
  dailyLimit?: number;
  /** Max tool rounds per user message. Default 3. */
  maxToolRounds?: number;
  /** Modules to load. */
  modules: AppaModule[];
  /** Extra system prompt appended after tutor-prompt.md and the module fragments. */
  extraSystemPrompt?: string;
  /**
   * Identity resolver — see `ResolveCaller` docs. If omitted, the kernel
   * denies every request that needs a caller and prints a loud warning
   * at server boot. Wire `devAuth()` for local development or write a
   * real resolver against your proxy / SSO / signed-cookie layer.
   */
  resolveCaller?: ResolveCaller;
  /**
   * Called after every transcript entry the kernel writes. Use for
   * content-safety alerting (classroom mandated-reporting), audit
   * logging, or live moderation feeds. Errors are logged + swallowed —
   * a broken alerting path won't break the chat. Best-effort hook;
   * not an integrity gate.
   */
  onTranscriptAppend?: OnTranscriptAppend;
}

/**
 * Identity helper that preserves the caller's literal type — so module
 * names and other inferable details survive into the returned value
 * (Vite/Vitest pattern). Also a future hook for schema migration.
 */
export function defineConfig<T extends AppaConfig>(c: T): T {
  return c;
}

export interface ResolvedConfig
  extends Required<Omit<AppaConfig, "extraSystemPrompt" | "resolveCaller" | "onTranscriptAppend">> {
  extraSystemPrompt: string;
  resolveCaller: ResolveCaller | null;
  onTranscriptAppend: OnTranscriptAppend | null;
}

export function resolveConfig(c: AppaConfig): ResolvedConfig {
  return {
    projectDir: c.projectDir ?? process.cwd(),
    port: c.port ?? 3848,
    host: c.host ?? "127.0.0.1",
    tutorPromptPath: c.tutorPromptPath ?? "tutor-prompt.md",
    sharedMemoryPath: c.sharedMemoryPath ?? "shared-memory.md",
    teamPath: c.teamPath ?? "team.json",
    model: c.model ?? "sonnet",
    hourlyLimit: c.hourlyLimit ?? 20,
    dailyLimit: c.dailyLimit ?? 100,
    maxToolRounds: c.maxToolRounds ?? 3,
    modules: c.modules,
    extraSystemPrompt: c.extraSystemPrompt ?? "",
    resolveCaller: c.resolveCaller ?? null,
    onTranscriptAppend: c.onTranscriptAppend ?? null,
  };
}
