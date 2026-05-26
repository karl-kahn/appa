// pattern: imperative-shell
// Per-session .jsonl transcript files. Append-only; reads parse line-by-line.

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { TranscriptEntry } from "./types.js";

const SAFE_NAME = /^[\w.-]+$/;

function validateName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`transcript: invalid session name ${JSON.stringify(name)}`);
  }
}

export interface TranscriptStore {
  append(sessionName: string, entry: TranscriptEntry): Promise<void>;
  read(sessionName: string, limit?: number): Promise<TranscriptEntry[]>;
  list(): Promise<{ name: string; size: number; mtime: string }[]>;
}

export function createTranscriptStore(projectDir: string, dir = "transcripts"): TranscriptStore {
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
  };
}
