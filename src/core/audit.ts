// pattern: imperative-shell
// Append-only audit log for mutating operations.
//
// Pre-2026-05-26 the kernel had no audit trail beyond the chat
// transcript itself: a coach asking "who deleted that task?" had no
// answer. Tool mutations were buffered onto the session object and
// drained on rollback — once drained they were gone.
//
// This log writes one JSON line per event to audit.jsonl in the
// project dir. The kernel auto-subscribes to bus tool.invoked events;
// modules and core routes call append() directly for HTTP mutations.
//
// /angel finding F41 (Blindspot Important).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AuditEntry {
  /** ISO timestamp, set by the helper. */
  ts?: string;
  /** Caller participant id, or "system" / "tutor:<id>" / etc. */
  by: string;
  /** What was done — short verb-noun like "task.create", "photo.delete". */
  action: string;
  /** Stable identifier of the affected resource, when applicable. */
  target?: string;
  /** Arbitrary structured details. Keep small; large payloads should be summarized. */
  details?: Record<string, unknown>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  path(): string;
}

export function createAuditLog(projectDir: string, file = "audit.jsonl"): AuditLog {
  const fullPath = join(projectDir, file);
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (!dirReady) dirReady = mkdir(dirname(fullPath), { recursive: true }).then(() => undefined);
    return dirReady;
  }

  return {
    async append(entry) {
      await ensureDir();
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
      await appendFile(fullPath, line, "utf8");
    },
    path() {
      return fullPath;
    },
  };
}
