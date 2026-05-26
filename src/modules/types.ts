// pattern: types-only
// AppaModule interface — the contract every module implements.

import type { Request, Response, Router } from "express";
import type { AppaBus } from "../core/bus.js";
import type { MemoryStore } from "../core/memory.js";
import type { Storage } from "../core/storage.js";
import type { TeamReader } from "../core/team.js";
import type { ThreadRecord, ThreadStore } from "../core/thread.js";
import type { TranscriptStore } from "../core/transcript.js";

/** Context passed to tool handlers and route registration. Stable surface. */
export interface ModuleContext {
  /** Project data root — the directory holding team.json, transcripts/, etc. */
  projectDir: string;
  /** JSON KV scoped to projectDir. */
  storage: Storage;
  /** Team roster reader. */
  team: TeamReader;
  /** Shared memory file. */
  memory: MemoryStore;
  /** Thread store (was: `sessions`). Holds persisted conversation contexts. */
  threads: ThreadStore;
  /** Transcript reader/writer. Use this rather than constructing your own. */
  transcripts: TranscriptStore;
  /**
   * Cross-module event bus. Modules that need to react to events from
   * other modules (e.g., "assignment created → add task to board")
   * subscribe in `init()` and emit from their handlers. Topics are
   * loose strings; convention is `{module}.{event}` (e.g.
   * `tasks.created`, `chat.tool_dispatched`).
   */
  bus: AppaBus;
  /**
   * Resolve the caller for an Express request via the kernel's configured
   * resolver. On 403, the helper writes the status + body to `res` and
   * returns null — the route handler should just early-return. Modules
   * MUST call this before any side effect or attribution-bearing read.
   */
  requireCaller(req: Request, res: Response): Promise<CallerIdentity | null>;
}

/** Identity of the request author, resolved by the kernel before any tool fires. */
export interface CallerIdentity {
  /** Stable id from team.json. */
  id: string;
  /** True if the team-roster role is "coach". */
  isCoach: boolean;
}

/** Per-call context for a tutor tool invocation. */
export interface ToolInvocation<P extends Record<string, unknown> = Record<string, unknown>> {
  params: P;
  /** The thread the tool was invoked from. */
  thread: ThreadRecord;
  /**
   * The caller behind this tool invocation. Modules MUST use this for any
   * filter that depends on "whose data is this?" — never trust the thread
   * id or a body-supplied user id.
   */
  caller: CallerIdentity;
  /** Attribution string forced onto writes — "tutor:<callerId>". */
  attribution: string;
  ctx: ModuleContext;
}

/** Tool handler. Return value is JSON-serialized and sent back to the tutor via --resume. */
export type ToolHandler = (call: ToolInvocation) => Promise<unknown> | unknown;

/** UI tab definition. Paths are resolved relative to the module's `dir`. */
export interface TabDefinition {
  id: string;
  label: string;
  /** HTML fragment loaded by the UI shell into the tab body. */
  htmlPath: string;
  /** Optional JS bundle entry; the shell loads it as a module on tab activation. */
  jsPath?: string;
  /** Roles that may see this tab. Default: all. */
  visibleTo?: Array<"coach" | "member">;
}

export interface AppaModule {
  /** Unique stable id. Used for storage namespacing and logs. */
  name: string;
  /** Absolute path to the module's directory (where tab.html, tab.js, etc. live). */
  dir?: string;
  /** Optional one-time setup. Called once per server boot. */
  init?(ctx: ModuleContext): Promise<void> | void;
  /** Markdown appended to the tutor system prompt. Describe your tools here. */
  promptFragment?: string;
  /** Tutor tools. Keys are tool names exposed in the |||TOOL_CALL||| protocol. */
  tools?: Record<string, ToolHandler>;
  /** Tools the *coach* can invoke but students cannot. Enforced by the kernel. */
  coachOnlyTools?: string[];
  /** Express route registration. Mounted at root; namespace your routes (e.g. `/api/<module>`). */
  routes?(router: Router, ctx: ModuleContext): void;
  /** UI tab. */
  tab?: TabDefinition;
}
