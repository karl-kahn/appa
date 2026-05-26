// pattern: imperative-shell
// Wire modules: build the tool dispatch table, system prompt, and Express router.

import type { Router } from "express";
import { createScopedStorage } from "../core/storage.js";
import type { ThreadRecord } from "../core/thread.js";
import { isAllowed } from "../core/tools.js";
import type { AppaModule, CallerIdentity, ModuleContext, ToolHandler } from "./types.js";

export interface ModuleRegistry {
  /** All tool handlers, flattened. Tool name → handler. */
  tools: Map<string, ToolHandler>;
  /** Tool names that may only be invoked by a coach session. */
  coachOnlyTools: Set<string>;
  /** Allowlist of all tool names. */
  allowlist: Set<string>;
  /** Concatenated promptFragments + extra system prompt. */
  promptFragment: string;
  /** Tabs the UI shell renders. */
  tabs: Array<{ moduleName: string; tab: NonNullable<AppaModule["tab"]> }>;
  /** Run a tool with kernel-enforced guards (allowlist, coach-only, attribution). */
  invoke(
    name: string,
    call: {
      params: Record<string, unknown>;
      thread: ThreadRecord;
      caller: CallerIdentity;
    },
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  /** Apply each module's `routes` to a router. */
  registerRoutes(router: Router): void;
  /** Call each module's `init` once. */
  init(): Promise<void>;
}

export function buildRegistry(
  modules: AppaModule[],
  ctx: ModuleContext,
  extraSystemPrompt = "",
): ModuleRegistry {
  const tools = new Map<string, ToolHandler>();
  const coachOnlyTools = new Set<string>();
  const fragments: string[] = [];
  const tabs: ModuleRegistry["tabs"] = [];

  for (const mod of modules) {
    if (mod.tools) {
      for (const [name, fn] of Object.entries(mod.tools)) {
        if (tools.has(name)) {
          throw new Error(
            `module ${mod.name} re-declares tool ${name} (already provided by another module)`,
          );
        }
        tools.set(name, fn);
      }
    }
    for (const name of mod.coachOnlyTools ?? []) coachOnlyTools.add(name);
    if (mod.promptFragment) {
      fragments.push(`### ${mod.name}\n\n${mod.promptFragment.trim()}\n`);
    }
    if (mod.tab) tabs.push({ moduleName: mod.name, tab: mod.tab });
  }

  const allowlist = new Set(tools.keys());

  async function invoke(
    name: string,
    call: {
      params: Record<string, unknown>;
      thread: ThreadRecord;
      caller: CallerIdentity;
    },
  ) {
    if (!isAllowed(name, allowlist)) {
      return { ok: false as const, error: `tool ${name} not in allowlist` };
    }
    if (coachOnlyTools.has(name) && !call.caller.isCoach) {
      return { ok: false as const, error: `tool ${name} is coach-only` };
    }
    const handler = tools.get(name);
    if (!handler) return { ok: false as const, error: `tool ${name} has no handler` };
    try {
      const result = await handler({
        params: call.params,
        thread: call.thread,
        caller: call.caller,
        participantStorage: createScopedStorage(ctx.storage, call.caller.id),
        attribution: `tutor:${call.caller.id}`,
        ctx,
      });
      // Cross-module visibility: every successful tool invocation fires a
      // generic "tool.invoked" event other modules can listen to. Specific
      // events (e.g., "tasks.created") are the module author's call to emit.
      await ctx.bus.emit("tool.invoked", {
        name,
        params: call.params,
        result,
        caller: call.caller,
      });
      return { ok: true as const, result };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function registerRoutes(router: Router): void {
    for (const mod of modules) {
      mod.routes?.(router, ctx);
    }
  }

  async function init(): Promise<void> {
    for (const mod of modules) {
      if (mod.init) await mod.init(ctx);
    }
  }

  const promptFragment = [...fragments, extraSystemPrompt].filter(Boolean).join("\n\n").trim();

  return {
    tools,
    coachOnlyTools,
    allowlist,
    promptFragment,
    tabs,
    invoke,
    registerRoutes,
    init,
  };
}
