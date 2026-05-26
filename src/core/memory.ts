// pattern: imperative-shell
// Memory — knowledge appended into every system prompt.
//
// Two layers, scoped:
// - team (shared-memory.md): visible to every participant's tutor.
//   This is project-wide context (vocabulary, decisions, hard facts).
// - participant (participants/<id>/memory.md): visible only when
//   building the system prompt for that participant. This is the
//   place to record per-student notes ("Alice is shaky on pitch
//   angle") without leaking them into Bob's prompt.
//
// Caches both layers in-process; appends invalidate the relevant
// cache so the next read picks up new sections. Without caching
// the chat hot path re-reads on every request.
//
// /angel finding F39 (Blindspot Important): coach notes about one
// student must not propagate into another student's system prompt.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TEAM_HEADER = "## Team memory\n";
const PARTICIPANT_HEADER = (id: string) => `## Memory for ${id}\n`;
const SAFE_ID = /^[\w.-]{1,128}$/;

export interface MemoryStore {
  /** Team-shared memory only. Use this when no caller context exists. */
  read(): Promise<string>;
  /**
   * Composed memory for a specific participant: team-shared section
   * followed by the participant's private memory. The string the
   * chat handler should put into a participant's system prompt.
   */
  readForParticipant(participantId: string): Promise<string>;
  /** Append a section to the team-shared file. */
  append(section: string): Promise<void>;
  /** Append a section to a specific participant's private file. */
  appendForParticipant(participantId: string, section: string): Promise<void>;
  /** Invalidate caches. */
  refresh(): void;
  /** Filesystem path of the team-shared file. */
  path(): string;
  /** Filesystem path of a participant's private file. */
  pathForParticipant(participantId: string): string;
}

export function createMemoryStore(projectDir: string, file = "shared-memory.md"): MemoryStore {
  const sharedPath = join(projectDir, file);
  let sharedCache: string | null = null;
  const participantCache = new Map<string, string>();

  function validateId(id: string): void {
    if (!SAFE_ID.test(id)) {
      throw new Error(`memory: invalid participant id ${JSON.stringify(id)}`);
    }
  }

  function participantPath(id: string): string {
    validateId(id);
    return join(projectDir, "participants", id, "memory.md");
  }

  async function readFile_orEmpty(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return "";
      throw err;
    }
  }

  async function readShared(): Promise<string> {
    if (sharedCache !== null) return sharedCache;
    sharedCache = await readFile_orEmpty(sharedPath);
    return sharedCache;
  }

  async function readParticipant(id: string): Promise<string> {
    const cached = participantCache.get(id);
    if (cached !== undefined) return cached;
    const text = await readFile_orEmpty(participantPath(id));
    participantCache.set(id, text);
    return text;
  }

  return {
    async read() {
      return readShared();
    },
    async readForParticipant(id) {
      const [team, mine] = await Promise.all([readShared(), readParticipant(id)]);
      if (!team) return mine;
      if (!mine) return team;
      return `${team.trimEnd()}\n\n${mine}`;
    },
    async append(section) {
      await mkdir(dirname(sharedPath), { recursive: true });
      const existing = await readShared();
      const prefix = existing.length === 0 ? TEAM_HEADER : "";
      const block = section.endsWith("\n") ? section : `${section}\n`;
      await appendFile(sharedPath, `${prefix}${block}\n`, "utf8");
      sharedCache = null;
    },
    async appendForParticipant(id, section) {
      const path = participantPath(id);
      await mkdir(dirname(path), { recursive: true });
      const existing = await readParticipant(id);
      const prefix = existing.length === 0 ? PARTICIPANT_HEADER(id) : "";
      const block = section.endsWith("\n") ? section : `${section}\n`;
      await appendFile(path, `${prefix}${block}\n`, "utf8");
      participantCache.delete(id);
    },
    refresh() {
      sharedCache = null;
      participantCache.clear();
    },
    path() {
      return sharedPath;
    },
    pathForParticipant(id) {
      return participantPath(id);
    },
  };
}
