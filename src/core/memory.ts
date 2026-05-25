// pattern: imperative-shell
// shared-memory.md: a knowledge base appended into every system prompt.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HEADER = "## Team memory\n";

export interface MemoryStore {
  read(): Promise<string>;
  append(section: string): Promise<void>;
  path(): string;
}

export function createMemoryStore(projectDir: string, file = "shared-memory.md"): MemoryStore {
  const fullPath = join(projectDir, file);

  return {
    async read() {
      try {
        return await readFile(fullPath, "utf8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return "";
        throw err;
      }
    },
    async append(section) {
      await mkdir(dirname(fullPath), { recursive: true });
      const existing = await this.read();
      const prefix = existing.length === 0 ? HEADER : "";
      const block = section.endsWith("\n") ? section : `${section}\n`;
      await appendFile(fullPath, `${prefix}${block}\n`, "utf8");
    },
    path() {
      return fullPath;
    },
  };
}
