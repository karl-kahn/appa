// pattern: imperative-shell
// In-memory session map persisted to .sessions.json on each change.

import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.js";
import type { SessionInfo, ToolMutation } from "./types.js";

const SESSIONS_KEY = ".sessions.json";

export interface SessionRecord extends SessionInfo {
  toolMutations: ToolMutation[];
}

interface PersistedShape {
  sessions: SessionRecord[];
}

const SAFE_NAME = /^[\w.-]{1,64}$/;

export function sanitizeSessionName(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, "_");
  const cleaned = trimmed.replace(/[^\w.-]/g, "");
  if (!cleaned) throw new Error("session: name resolves to empty");
  if (!SAFE_NAME.test(cleaned)) throw new Error(`session: invalid name ${JSON.stringify(input)}`);
  return cleaned;
}

export interface SessionStore {
  getOrCreate(name: string): Promise<SessionRecord>;
  get(name: string): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
  setClaudeId(name: string, claudeSessionId: string): Promise<void>;
  markHasMessages(name: string): Promise<void>;
  setParticipants(name: string, participantIds: string[]): Promise<void>;
  recordMutation(name: string, mutation: ToolMutation): Promise<void>;
  takeMutations(name: string): Promise<ToolMutation[]>;
  end(name: string): Promise<void>;
}

export function createSessionStore(storage: Storage): SessionStore {
  // Cache the in-memory state to avoid re-reading the JSON on every operation.
  // Persisted on every mutation so a process restart can recover.
  let cache: Map<string, SessionRecord> | null = null;

  async function load(): Promise<Map<string, SessionRecord>> {
    if (cache) return cache;
    const data = await storage.read<PersistedShape>(SESSIONS_KEY, { sessions: [] });
    cache = new Map(data.sessions.map((s) => [s.name, s]));
    return cache;
  }

  async function persist(map: Map<string, SessionRecord>): Promise<void> {
    cache = map;
    await storage.write<PersistedShape>(SESSIONS_KEY, { sessions: [...map.values()] });
  }

  function blank(name: string): SessionRecord {
    const now = new Date().toISOString();
    return {
      name,
      claudeSessionId: null,
      participantIds: [],
      hasMessages: false,
      createdAt: now,
      lastUsedAt: now,
      toolMutations: [],
    };
  }

  return {
    async getOrCreate(name) {
      const safe = sanitizeSessionName(name);
      const map = await load();
      let s = map.get(safe);
      if (!s) {
        s = blank(safe);
        map.set(safe, s);
        await persist(map);
      }
      return s;
    },
    async get(name) {
      const safe = sanitizeSessionName(name);
      const map = await load();
      return map.get(safe) ?? null;
    },
    async list() {
      const map = await load();
      return [...map.values()];
    },
    async setClaudeId(name, claudeSessionId) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      const s = map.get(safe) ?? blank(safe);
      s.claudeSessionId = claudeSessionId;
      s.lastUsedAt = new Date().toISOString();
      map.set(safe, s);
      await persist(map);
    },
    async markHasMessages(name) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      const s = map.get(safe) ?? blank(safe);
      s.hasMessages = true;
      s.lastUsedAt = new Date().toISOString();
      map.set(safe, s);
      await persist(map);
    },
    async setParticipants(name, participantIds) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      const s = map.get(safe) ?? blank(safe);
      s.participantIds = [...new Set(participantIds)];
      map.set(safe, s);
      await persist(map);
    },
    async recordMutation(name, mutation) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      const s = map.get(safe) ?? blank(safe);
      s.toolMutations.push(mutation);
      map.set(safe, s);
      await persist(map);
    },
    async takeMutations(name) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      const s = map.get(safe);
      if (!s) return [];
      const muts = s.toolMutations;
      s.toolMutations = [];
      map.set(safe, s);
      await persist(map);
      return muts;
    },
    async end(name) {
      const map = await load();
      const safe = sanitizeSessionName(name);
      map.delete(safe);
      await persist(map);
    },
  };
}

/** Make a new claude session id (UUID v4 suitable for `claude --session-id`). */
export function newClaudeSessionId(): string {
  return randomUUID();
}
