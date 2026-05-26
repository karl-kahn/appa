import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../core/memory.js";
import { type SessionRecord, createSessionStore } from "../core/session.js";
import { createStorage } from "../core/storage.js";
import { createTeamReader } from "../core/team.js";
import { createTranscriptStore } from "../core/transcript.js";
import { buildRegistry } from "./registry.js";
import type { AppaModule, CallerIdentity, ModuleContext } from "./types.js";

function fakeSession(name = "alice"): SessionRecord {
  return {
    name,
    claudeSessionId: null,
    participantIds: [],
    hasMessages: false,
    createdAt: "",
    lastUsedAt: "",
    toolMutations: [],
  };
}

function caller(id = "alice", isCoach = false): CallerIdentity {
  return { id, isCoach };
}

describe("buildRegistry", () => {
  let dir: string;
  let ctx: ModuleContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-reg-"));
    const storage = createStorage(dir);
    ctx = {
      projectDir: dir,
      storage,
      team: createTeamReader(storage),
      memory: createMemoryStore(dir),
      sessions: createSessionStore(storage, { persistDebounceMs: 0 }),
      transcripts: createTranscriptStore(dir),
      requireCaller: async () => null,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects tools and prompt fragments", () => {
    const mod: AppaModule = {
      name: "demo",
      promptFragment: "use get_demo to read demo data",
      tools: { get_demo: () => ({ items: [] }) },
    };
    const reg = buildRegistry([mod], ctx);
    expect([...reg.tools.keys()]).toEqual(["get_demo"]);
    expect(reg.promptFragment).toMatch(/get_demo/);
  });

  it("throws on duplicate tool names across modules", () => {
    const a: AppaModule = { name: "a", tools: { foo: () => 1 } };
    const b: AppaModule = { name: "b", tools: { foo: () => 2 } };
    expect(() => buildRegistry([a, b], ctx)).toThrow(/re-declares tool foo/);
  });

  it("invokes a tool with attribution based on caller id (not session name)", async () => {
    let seen: { attribution: string; callerId: string } | null = null;
    const mod: AppaModule = {
      name: "demo",
      tools: {
        log_thing: async ({ attribution, caller: c }) => {
          seen = { attribution, callerId: c.id };
          return "ok";
        },
      },
    };
    const reg = buildRegistry([mod], ctx);
    const r = await reg.invoke("log_thing", {
      params: {},
      // The session name is unrelated to the caller — attribution should
      // follow the caller, not the session slug.
      session: fakeSession("shared-room"),
      caller: caller("alice"),
    });
    expect(r).toEqual({ ok: true, result: "ok" });
    expect(seen).toEqual({ attribution: "tutor:alice", callerId: "alice" });
  });

  it("rejects unknown tools", async () => {
    const reg = buildRegistry([{ name: "empty" }], ctx);
    const r = await reg.invoke("ghost", {
      params: {},
      session: fakeSession(),
      caller: caller("alice", true),
    });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not in allowlist/) });
  });

  it("blocks coach-only tools for non-coach callers", async () => {
    const mod: AppaModule = {
      name: "admin",
      tools: { nuke: () => "boom" },
      coachOnlyTools: ["nuke"],
    };
    const reg = buildRegistry([mod], ctx);
    const blocked = await reg.invoke("nuke", {
      params: {},
      session: fakeSession(),
      caller: caller("alice", false),
    });
    expect(blocked.ok).toBe(false);
    const allowed = await reg.invoke("nuke", {
      params: {},
      session: fakeSession(),
      caller: caller("karl", true),
    });
    expect(allowed.ok).toBe(true);
  });

  it("catches thrown errors and reports them as failures", async () => {
    const mod: AppaModule = {
      name: "demo",
      tools: {
        bork: () => {
          throw new Error("nope");
        },
      },
    };
    const reg = buildRegistry([mod], ctx);
    const r = await reg.invoke("bork", {
      params: {},
      session: fakeSession(),
      caller: caller("alice"),
    });
    expect(r).toEqual({ ok: false, error: "nope" });
  });
});
