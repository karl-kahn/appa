import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditLog } from "./audit.js";

describe("AuditLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-audit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one JSON line per entry with a timestamp", async () => {
    const log = createAuditLog(dir);
    await log.append({ by: "alice", action: "task.create", target: "1" });
    await log.append({
      by: "coach",
      action: "task.delete",
      target: "1",
      details: { reason: "duplicate" },
    });

    const raw = await readFile(log.path(), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "");
    const second = JSON.parse(lines[1] ?? "");
    expect(first.by).toBe("alice");
    expect(first.action).toBe("task.create");
    expect(first.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(second.details).toEqual({ reason: "duplicate" });
  });

  it("preserves entry-supplied ts if provided", async () => {
    const log = createAuditLog(dir);
    await log.append({ ts: "2026-01-01T00:00:00Z", by: "alice", action: "x" });
    const raw = await readFile(log.path(), "utf8");
    expect(JSON.parse(raw.trim()).ts).toBe("2026-01-01T00:00:00Z");
  });
});
