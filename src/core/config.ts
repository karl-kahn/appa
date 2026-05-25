// pattern: types-only + helper
import type { AppaModule } from "../modules/types.js";

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
}

/** Identity helper — gives type inference + future schema migration hook. */
export function defineConfig(c: AppaConfig): AppaConfig {
  return c;
}

export interface ResolvedConfig extends Required<Omit<AppaConfig, "extraSystemPrompt">> {
  extraSystemPrompt: string;
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
  };
}
