// pattern: imperative-shell
// Per-session .jsonl transcript files. Append-only; reads parse line-by-line.
//
// Hooks: a deployment can pass `onAppend` to be notified of every entry
// the kernel writes — that's the wiring point for content-safety
// alerting, audit logging, and live moderation surfaces. The hook is
// best-effort: errors are caught and logged so a broken alerting path
// doesn't break the chat. /angel finding F7 (Blindspot Critical).

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { TranscriptEntry } from "./types.js";

const SAFE_NAME = /^[\w.-]+$/;

function validateName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`transcript: invalid session name ${JSON.stringify(name)}`);
  }
}

export type OnTranscriptAppend = (
  sessionName: string,
  entry: TranscriptEntry,
) => void | Promise<void>;

export interface TranscriptStoreOptions {
  /** Subdirectory under projectDir. Default "transcripts". */
  dir?: string;
  /** Called after every successful append. Errors are logged + swallowed. */
  onAppend?: OnTranscriptAppend;
}

export interface TranscriptStore {
  append(sessionName: string, entry: TranscriptEntry): Promise<void>;
  read(sessionName: string, limit?: number): Promise<TranscriptEntry[]>;
  list(): Promise<{ name: string; size: number; mtime: string }[]>;
  /**
   * Delete the transcript file for a specific thread. Idempotent —
   * succeeds even if the file doesn't exist. FERPA/GDPR Article 17
   * right-to-erasure path. /angel finding F38.
   */
  remove(sessionName: string): Promise<void>;
  /**
   * Delete transcript files older than `cutoff`. Returns the list of
   * deleted thread names. Used by the retention sweeper at boot when
   * `config.transcriptRetentionDays` is set.
   */
  pruneOlderThan(cutoff: Date): Promise<string[]>;
}

export function createTranscriptStore(
  projectDir: string,
  opts: TranscriptStoreOptions | string = {},
): TranscriptStore {
  // Accept either an options object or a legacy `dir` string.
  const options: TranscriptStoreOptions = typeof opts === "string" ? { dir: opts } : opts;
  const dir = options.dir ?? "transcripts";
  const onAppend = options.onAppend;
  const root = join(projectDir, dir);
  let rootReady: Promise<void> | null = null;

  function ensureRoot(): Promise<void> {
    if (!rootReady) rootReady = mkdir(root, { recursive: true }).then(() => undefined);
    return rootReady;
  }

  function pathFor(name: string): string {
    validateName(name);
    return join(root, `${name}.jsonl`);
  }

  return {
    async append(sessionName, entry) {
      await ensureRoot();
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(pathFor(sessionName), line, "utf8");
      if (onAppend) {
        try {
          await onAppend(sessionName, entry);
        } catch (err) {
          console.error(
            "appa/transcript: onAppend hook threw — entry was persisted, hook failed:",
            err,
          );
        }
      }
    },

    async read(sessionName, limit) {
      const path = pathFor(sessionName);
      try {
        await stat(path);
      } catch {
        return [];
      }
      const all: TranscriptEntry[] = [];
      const rl = createInterface({
        input: createReadStream(path, "utf8"),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          // skip malformed lines rather than throwing — transcripts are append-only
          // and a partial write shouldn't poison the whole read
        }
      }
      if (limit && limit > 0 && all.length > limit) return all.slice(-limit);
      return all;
    },

    async list() {
      try {
        const names = await readdir(root);
        const out: { name: string; size: number; mtime: string }[] = [];
        for (const f of names) {
          if (!f.endsWith(".jsonl")) continue;
          const st = await stat(join(root, f));
          out.push({
            name: f.replace(/\.jsonl$/, ""),
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        }
        return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      } catch {
        return [];
      }
    },

    async remove(sessionName) {
      try {
        await unlink(pathFor(sessionName));
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
    },

    async pruneOlderThan(cutoff) {
      const removed: string[] = [];
      try {
        const names = await readdir(root);
        for (const f of names) {
          if (!f.endsWith(".jsonl")) continue;
          const st = await stat(join(root, f));
          if (st.mtime < cutoff) {
            await unlink(join(root, f));
            removed.push(f.replace(/\.jsonl$/, ""));
          }
        }
      } catch {
        // No transcripts dir yet — nothing to prune.
      }
      return removed;
    },
  };
}
