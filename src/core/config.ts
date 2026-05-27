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
  /**
   * Retention window for transcript files (days). On server boot the
   * kernel sweeps the transcripts directory and deletes files older
   * than this. Unset = retain forever. Set in classrooms governed by
   * FERPA / IT retention schedules / district policy.
   * /angel finding F38 (Blindspot Important).
   */
  transcriptRetentionDays?: number;
  /** Modules to load. */
  modules: AppaModule[];
  /**
   * Override the path to the spawned binary. Defaults to "claude" (PATH
   * lookup). Useful for tests, sandboxes, or pinning a specific install
   * location. Don't accept this from caller-controlled input.
   */
  claudeBinary?: string;
  /**
   * Extra environment to forward to the spawned binary, merged on top of
   * the kernel's whitelist. Treat as trust-extending. Most deployments
   * leave this empty; tests use it to drive a mock CLI.
   */
  extraSpawnEnv?: NodeJS.ProcessEnv;
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
  extends Required<
    Omit<
      AppaConfig,
      | "extraSystemPrompt"
      | "resolveCaller"
      | "onTranscriptAppend"
      | "claudeBinary"
      | "extraSpawnEnv"
    >
  > {
  extraSystemPrompt: string;
  resolveCaller: ResolveCaller | null;
  onTranscriptAppend: OnTranscriptAppend | null;
  claudeBinary: string | null;
  extraSpawnEnv: NodeJS.ProcessEnv | null;
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
    transcriptRetentionDays: c.transcriptRetentionDays ?? 0,
    modules: c.modules,
    extraSystemPrompt: c.extraSystemPrompt ?? "",
    resolveCaller: c.resolveCaller ?? null,
    onTranscriptAppend: c.onTranscriptAppend ?? null,
    claudeBinary: c.claudeBinary ?? null,
    extraSpawnEnv: c.extraSpawnEnv ?? null,
  };
}
