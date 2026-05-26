// pattern: types-only
// Main package entry — what consumers `import "appa"` for.

export { defineConfig, resolveConfig } from "./core/config.js";
export type { AppaConfig, ResolveCaller, ResolvedConfig } from "./core/config.js";
export { devAuth, callerOwnsSession } from "./server/auth.js";
export type {
  AppaModule,
  CallerIdentity,
  ModuleContext,
  ToolHandler,
  ToolInvocation,
  TabDefinition,
} from "./modules/types.js";
export type {
  Role,
  Team,
  TeamMember,
  SessionInfo,
  ToolCall,
  ToolMutation,
  TranscriptEntry,
  SpawnEvent,
  SpawnLimits,
  SpawnUsage,
} from "./core/types.js";
export { createStorage } from "./core/storage.js";
export type { Storage } from "./core/storage.js";
export { createBus } from "./core/bus.js";
export type { AppaBus, BusHandler } from "./core/bus.js";
export { createTeamReader } from "./core/team.js";
export type { TeamReader } from "./core/team.js";
export { createSessionStore, sanitizeSessionName, newClaudeSessionId } from "./core/session.js";
export type { SessionStore, SessionRecord } from "./core/session.js";
export { createTranscriptStore } from "./core/transcript.js";
export type {
  OnTranscriptAppend,
  TranscriptStore,
  TranscriptStoreOptions,
} from "./core/transcript.js";
export { createMemoryStore } from "./core/memory.js";
export type { MemoryStore } from "./core/memory.js";
export { parseToolCalls, stripToolBlocks, isAllowed } from "./core/tools.js";
export {
  canSpawn,
  recordSpawn,
  createRateLimitState,
  snapshot as rateLimitSnapshot,
} from "./core/rate-limit.js";
export type { RateLimitState } from "./core/rate-limit.js";
export { spawnClaude, buildArgs, buildEnv, DEFAULT_DISALLOWED_TOOLS } from "./core/spawn.js";
export type { SpawnOptions } from "./core/spawn.js";
export { buildRegistry } from "./modules/registry.js";
export type { ModuleRegistry } from "./modules/registry.js";
export { buildApp } from "./server/index.js";
export type { AppHandle } from "./server/index.js";
