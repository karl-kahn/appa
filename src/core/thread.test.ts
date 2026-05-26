import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage } from "./storage.js";
import {
  callerOwnsThread,
  createThreadStore,
  newClaudeSessionId,
  sanitizeThreadId,
} from "./thread.js";

describe("sanitizeThreadId", () => {
  it("lowercases + underscores spaces", () => {
    expect(sanitizeThreadId("Caleb Test")).toBe("caleb_test");
  });
  it("strips disallowed chars", () => {
    expect(sanitizeThreadId("ca/leb!")).toBe("caleb");
  });
  it("throws on empty after sanitize", () => {
    expect(() => sanitizeThreadId("///")).toThrow();
  });
});

describe("newClaudeSessionId", () => {
  it("returns a UUID v4-shape string", () => {
    expect(newClaudeSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("ThreadStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-thread-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a thread with owner; ownership check passes for owner + coach", async () => {
    const store = createThreadStore(createStorage(dir), { persistDebounceMs: 0 });
    const t = await store.create("alice", { ownerId: "alice" });
    expect(t.ownerId).toBe("alice");
    expect(t.coParticipantIds).toEqual([]);
    expect(callerOwnsThread({ id: "alice", isCoach: false }, t)).toBe(true);
    expect(callerOwnsThread({ id: "bob", isCoach: true }, t)).toBe(true);
    expect(callerOwnsThread({ id: "bob", isCoach: false }, t)).toBe(false);
  });

  it("create rejects duplicate ids", async () => {
    const store = createThreadStore(createStorage(dir), { persistDebounceMs: 0 });
    await store.create("alice", { ownerId: "alice" });
    await expect(store.create("alice", { ownerId: "alice" })).rejects.toThrow(/already exists/);
  });

  it("addCoParticipant lets a peer in; their ownership check passes", async () => {
    const store = createThreadStore(createStorage(dir), { persistDebounceMs: 0 });
    await store.create("project1", { ownerId: "alice" });
    await store.addCoParticipant("project1", "bob");
    const t = await store.get("project1");
    expect(t?.coParticipantIds).toEqual(["bob"]);
    expect(callerOwnsThread({ id: "bob", isCoach: false }, t!)).toBe(true);
  });

  it("migrates a legacy .sessions.json file", async () => {
    // Drop a legacy file in place.
    const legacy = {
      sessions: [
        {
          name: "alice",
          claudeSessionId: "abc",
          participantIds: ["alice"],
          hasMessages: true,
          createdAt: "2026-04-01T00:00:00Z",
          lastUsedAt: "2026-04-02T00:00:00Z",
          toolMutations: [],
        },
        {
          name: "shared-lab",
          claudeSessionId: null,
          participantIds: ["alice", "bob"],
          hasMessages: false,
          createdAt: "2026-04-03T00:00:00Z",
          lastUsedAt: "2026-04-03T00:00:00Z",
          toolMutations: [],
        },
      ],
    };
    await writeFile(join(dir, ".sessions.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const store = createThreadStore(createStorage(dir), { persistDebounceMs: 0 });
    const list = await store.list();
    const alice = list.find((t) => t.id === "alice");
    const lab = list.find((t) => t.id === "shared-lab");
    expect(alice?.ownerId).toBe("alice");
    expect(alice?.hasMessages).toBe(true);
    expect(lab?.ownerId).toBe("alice");
    expect(lab?.coParticipantIds).toEqual(["bob"]);
  });
});
