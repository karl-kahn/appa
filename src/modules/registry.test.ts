import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../core/audit.js";
import { createBus } from "../core/bus.js";
import { createMemoryStore } from "../core/memory.js";
import { createScopedStorage } from "../core/storage.js";
import { type ThreadRecord, createThreadStore } from "../core/thread.js";
import { createStorage } from "../core/storage.js";
import { createTeamReader } from "../core/team.js";
import { createTranscriptStore } from "../core/transcript.js";
import { buildRegistry } from "./registry.js";
import type { AppaModule, CallerIdentity, ModuleContext } from "./types.js";

function fakeThread(id = "alice", ownerId = id): ThreadRecord {
  return {
    id,
    ownerId,
    coParticipantIds: [],
    claudeSessionId: null,
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
      threads: createThreadStore(storage, { persistDebounceMs: 0 }),
      transcripts: createTranscriptStore(dir),
      bus: createBus(),
      audit: createAuditLog(dir),
      storageFor: (id: string) => createScopedStorage(storage, id),
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

  it("invokes a tool with attribution based on caller id (not thread id)", async () => {
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
      // The thread id and its owner are unrelated to the caller — attribution
      // follows the caller, not the thread.
      thread: fakeThread("shared-room", "bob"),
      caller: caller("alice"),
    });
    expect(r).toEqual({ ok: true, result: "ok" });
    expect(seen).toEqual({ attribution: "tutor:alice", callerId: "alice" });
  });

  it("rejects unknown tools", async () => {
    const reg = buildRegistry([{ name: "empty" }], ctx);
    const r = await reg.invoke("ghost", {
      params: {},
      thread: fakeThread(),
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
      thread: fakeThread(),
      caller: caller("alice", false),
    });
    expect(blocked.ok).toBe(false);
    const allowed = await reg.invoke("nuke", {
      params: {},
      thread: fakeThread(),
      caller: caller("karl", true),
    });
    expect(allowed.ok).toBe(true);
  });

  it("provides a participantStorage scoped to caller.id", async () => {
    let seen: { key: string; storedAt: string } | null = null;
    const mod: AppaModule = {
      name: "scope-demo",
      tools: {
        write_private: async ({ participantStorage }) => {
          await participantStorage.write("notes.json", { v: 1 });
          seen = { key: "notes.json", storedAt: participantStorage.pathOf("notes.json") };
          return "ok";
        },
      },
    };
    const reg = buildRegistry([mod], ctx);
    const r = await reg.invoke("write_private", {
      params: {},
      thread: fakeThread(),
      caller: caller("alice"),
    });
    expect(r.ok).toBe(true);
    expect(seen?.storedAt).toContain("participants/alice/notes.json");
    // The same key written via team-shared ctx.storage does NOT collide
    // with the scoped write — different on-disk locations.
    await ctx.storage.write("notes.json", { v: 2 });
    const scoped = await ctx.storage.read<{ v: number }>("participants/alice/notes.json", {
      v: -1,
    });
    const team = await ctx.storage.read<{ v: number }>("notes.json", { v: -1 });
    expect(scoped.v).toBe(1);
    expect(team.v).toBe(2);
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
      thread: fakeThread(),
      caller: caller("alice"),
    });
    expect(r).toEqual({ ok: false, error: "nope" });
  });
});
