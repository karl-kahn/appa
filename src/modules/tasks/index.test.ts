import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../../core/memory.js";
import { type SessionRecord, createSessionStore } from "../../core/session.js";
import { createStorage } from "../../core/storage.js";
import { createTeamReader } from "../../core/team.js";
import { createTranscriptStore } from "../../core/transcript.js";
import type { ModuleContext } from "../types.js";
import tasksModule, { type Task } from "./index.js";

function fakeSession(): SessionRecord {
  return {
    name: "alice",
    claudeSessionId: null,
    participantIds: ["alice"],
    hasMessages: false,
    createdAt: "",
    lastUsedAt: "",
    toolMutations: [],
  };
}

describe("tasks module", () => {
  let dir: string;
  let ctx: ModuleContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-tasks-"));
    const storage = createStorage(dir);
    ctx = {
      projectDir: dir,
      storage,
      team: createTeamReader(storage),
      memory: createMemoryStore(dir),
      sessions: createSessionStore(storage, { persistDebounceMs: 0 }),
      transcripts: createTranscriptStore(dir),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function invoke<T = unknown>(tool: string, params: Record<string, unknown>): Promise<T> {
    const handler = tasksModule.tools?.[tool];
    if (!handler) throw new Error(`tool ${tool} not in module`);
    return Promise.resolve(
      handler({
        params,
        session: fakeSession(),
        attribution: "tutor:alice",
        ctx,
      }) as T,
    );
  }

  it("starts empty", async () => {
    expect(await invoke<Task[]>("get_tasks", {})).toEqual([]);
  });

  it("creates a task with the right attribution", async () => {
    const t = await invoke<Task>("create_task", { title: "ship it" });
    expect(t.id).toBe("1");
    expect(t.title).toBe("ship it");
    expect(t.column).toBe("backlog");
    expect(t.createdBy).toBe("tutor:alice");
  });

  it("auto-increments ids", async () => {
    const a = await invoke<Task>("create_task", { title: "a" });
    const b = await invoke<Task>("create_task", { title: "b" });
    expect(a.id).toBe("1");
    expect(b.id).toBe("2");
  });

  it("updates fields by id and ignores nulls", async () => {
    await invoke("create_task", { title: "a", assignee: "alice" });
    const updated = await invoke<Task>("update_task", {
      id: "1",
      column: "done",
      assignee: null,
    });
    expect(updated.column).toBe("done");
    // assignee stays because null means "leave unchanged"
    expect(updated.assignee).toBe("alice");
  });

  it("deletes by id", async () => {
    await invoke("create_task", { title: "a" });
    await invoke("create_task", { title: "b" });
    const result = await invoke<{ deleted: string; remaining: number }>("delete_task", {
      id: "1",
    });
    expect(result).toEqual({ deleted: "1", remaining: 1 });
    const list = await invoke<Task[]>("get_tasks", {});
    expect(list.map((t) => t.id)).toEqual(["2"]);
  });

  it("rejects invalid create params", async () => {
    await expect(invoke("create_task", { title: "" })).rejects.toThrow();
  });

  it("update_task throws on unknown id rather than silently returning null", async () => {
    await invoke("create_task", { title: "a" });
    await expect(invoke("update_task", { id: "ghost", column: "done" })).rejects.toThrow(
      /no task with id/,
    );
  });

  it("delete_task throws on unknown id rather than silently no-oping", async () => {
    await invoke("create_task", { title: "a" });
    await expect(invoke("delete_task", { id: "ghost" })).rejects.toThrow(/no task with id/);
  });
});
