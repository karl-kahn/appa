// pattern: imperative-shell
// shared-memory.md: a knowledge base appended into every system prompt.
// Cached in-process; append() invalidates the cache, so the next read picks
// up the new section. Without this the chat hot path re-reads the file on
// every request (3 disk reads per chat call at classroom scale).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HEADER = "## Team memory\n";

export interface MemoryStore {
  read(): Promise<string>;
  append(section: string): Promise<void>;
  /** Invalidate cache. Useful if the file is edited externally. */
  refresh(): void;
  path(): string;
}

export function createMemoryStore(projectDir: string, file = "shared-memory.md"): MemoryStore {
  const fullPath = join(projectDir, file);
  let cache: string | null = null;

  async function readFresh(): Promise<string> {
    try {
      return await readFile(fullPath, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return "";
      throw err;
    }
  }

  return {
    async read() {
      if (cache !== null) return cache;
      cache = await readFresh();
      return cache;
    },
    async append(section) {
      await mkdir(dirname(fullPath), { recursive: true });
      const existing = await this.read();
      const prefix = existing.length === 0 ? HEADER : "";
      const block = section.endsWith("\n") ? section : `${section}\n`;
      await appendFile(fullPath, `${prefix}${block}\n`, "utf8");
      cache = null; // force re-read on next access
    },
    refresh() {
      cache = null;
    },
    path() {
      return fullPath;
    },
  };
}
