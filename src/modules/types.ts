// pattern: types-only
// AppaModule interface — the contract every module implements.

import type { Router } from "express";
import type { MemoryStore } from "../core/memory.js";
import type { SessionRecord, SessionStore } from "../core/session.js";
import type { Storage } from "../core/storage.js";
import type { TeamReader } from "../core/team.js";
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
  /** Session bookkeeping (use for read-only queries; mutations go through kernel). */
  sessions: SessionStore;
  /** Transcript reader/writer. Use this rather than constructing your own. */
  transcripts: TranscriptStore;
}

/** Per-call context for a tutor tool invocation. */
export interface ToolInvocation<P extends Record<string, unknown> = Record<string, unknown>> {
  params: P;
  /** The session that invoked the tool. */
  session: SessionRecord;
  /** Attribution string forced onto writes — "tutor:<sessionName>". */
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
