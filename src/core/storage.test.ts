import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage } from "./storage.js";

describe("storage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-storage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns fallback when file is missing", async () => {
    const storage = createStorage(dir);
    const result = await storage.read("tasks.json", []);
    expect(result).toEqual([]);
  });

  it("round-trips a write", async () => {
    const storage = createStorage(dir);
    await storage.write("tasks.json", [{ id: 1, title: "ship it" }]);
    const result = await storage.read<{ id: number; title: string }[]>("tasks.json", []);
    expect(result).toEqual([{ id: 1, title: "ship it" }]);
  });

  it("creates intermediate directories", async () => {
    const storage = createStorage(dir);
    await storage.write("nested/dir/data.json", { ok: true });
    const raw = await readFile(join(dir, "nested/dir/data.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  it("rejects keys with ..", async () => {
    const storage = createStorage(dir);
    await expect(storage.read("../outside.json", {})).rejects.toThrow(/may not contain/);
  });

  it("rejects invalid characters in keys", async () => {
    const storage = createStorage(dir);
    await expect(storage.read("bad key.json", {})).rejects.toThrow(/invalid key/);
  });

  it("serializes concurrent updates on the same key", async () => {
    const storage = createStorage(dir);
    await storage.write("counter.json", { n: 0 });
    const runs = Array.from({ length: 20 }, () =>
      storage.update<{ n: number }>("counter.json", { n: 0 }, (cur) => ({ n: cur.n + 1 })),
    );
    await Promise.all(runs);
    const final = await storage.read<{ n: number }>("counter.json", { n: 0 });
    expect(final.n).toBe(20);
  });

  it("allows concurrent updates on different keys", async () => {
    const storage = createStorage(dir);
    await Promise.all([storage.write("a.json", { v: "a" }), storage.write("b.json", { v: "b" })]);
    const [a, b] = await Promise.all([
      storage.read<{ v: string }>("a.json", { v: "" }),
      storage.read<{ v: string }>("b.json", { v: "" }),
    ]);
    expect(a.v).toBe("a");
    expect(b.v).toBe("b");
  });
});
