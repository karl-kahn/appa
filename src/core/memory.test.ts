import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory.js";

describe("MemoryStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-memory-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("read() returns the shared file only", async () => {
    const m = createMemoryStore(dir);
    await m.append("team-wide fact");
    expect(await m.read()).toContain("team-wide fact");
    expect(await m.read()).not.toContain("alice");
  });

  it("readForParticipant composes shared + private", async () => {
    const m = createMemoryStore(dir);
    await m.append("team-wide fact");
    await m.appendForParticipant("alice", "alice is struggling with pitch angle");
    const aliceView = await m.readForParticipant("alice");
    expect(aliceView).toContain("team-wide fact");
    expect(aliceView).toContain("alice is struggling");

    const bobView = await m.readForParticipant("bob");
    expect(bobView).toContain("team-wide fact");
    expect(bobView).not.toContain("alice");
  });

  it("private memory file lives under participants/<id>/memory.md", async () => {
    const m = createMemoryStore(dir);
    await m.appendForParticipant("alice", "private to alice");
    const raw = await readFile(join(dir, "participants/alice/memory.md"), "utf8");
    expect(raw).toContain("private to alice");
  });

  it("rejects invalid participant ids", async () => {
    const m = createMemoryStore(dir);
    await expect(m.appendForParticipant("../etc", "x")).rejects.toThrow(/invalid participant id/);
  });

  it("appending invalidates the relevant cache", async () => {
    const m = createMemoryStore(dir);
    expect(await m.readForParticipant("alice")).toBe("");
    await m.appendForParticipant("alice", "new note");
    expect(await m.readForParticipant("alice")).toContain("new note");
  });
});
