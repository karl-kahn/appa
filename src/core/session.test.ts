import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore, newClaudeSessionId, sanitizeSessionName } from "./session.js";
import { createStorage } from "./storage.js";

describe("sanitizeSessionName", () => {
  it("lowercases + underscores spaces", () => {
    expect(sanitizeSessionName("Caleb Test")).toBe("caleb_test");
  });
  it("strips disallowed chars", () => {
    expect(sanitizeSessionName("ca/leb!")).toBe("caleb");
  });
  it("throws on empty after sanitize", () => {
    expect(() => sanitizeSessionName("///")).toThrow();
  });
});

describe("newClaudeSessionId", () => {
  it("returns a UUID-shape string", () => {
    expect(newClaudeSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("SessionStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-session-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates and retrieves a session", async () => {
    const store = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    const s = await store.getOrCreate("alice");
    expect(s.name).toBe("alice");
    expect(s.claudeSessionId).toBeNull();
    expect(s.hasMessages).toBe(false);
  });

  it("returns the same object on getOrCreate twice", async () => {
    const store = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    const a = await store.getOrCreate("alice");
    const b = await store.getOrCreate("alice");
    expect(a.createdAt).toBe(b.createdAt);
  });

  it("persists across stores backed by the same dir", async () => {
    const s1 = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    await s1.getOrCreate("alice");
    await s1.markHasMessages("alice");

    const s2 = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    const loaded = await s2.get("alice");
    expect(loaded?.hasMessages).toBe(true);
  });

  it("tracks tool mutations and clears them on take", async () => {
    const store = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    await store.getOrCreate("alice");
    await store.recordMutation("alice", {
      tool: "create_task",
      params: { title: "x" },
      sessionName: "alice",
      at: new Date().toISOString(),
    });
    const taken = await store.takeMutations("alice");
    expect(taken).toHaveLength(1);
    const taken2 = await store.takeMutations("alice");
    expect(taken2).toHaveLength(0);
  });

  it("ends a session, removing it from list", async () => {
    const store = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    await store.getOrCreate("alice");
    await store.end("alice");
    expect(await store.get("alice")).toBeNull();
  });

  it("debounces writes; flush forces immediate persist", async () => {
    const s1 = createSessionStore(createStorage(dir), { persistDebounceMs: 50 });
    await s1.getOrCreate("alice");
    await s1.markHasMessages("alice");
    await s1.setParticipants("alice", ["alice"]);
    await s1.flush();

    const s2 = createSessionStore(createStorage(dir), { persistDebounceMs: 0 });
    const loaded = await s2.get("alice");
    expect(loaded?.hasMessages).toBe(true);
    expect(loaded?.participantIds).toEqual(["alice"]);
  });
});
