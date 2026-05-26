// pattern: imperative-shell
// Threads — persisted conversation contexts. Each chat URL points at a Thread
// (was: "Session"). The rename clarifies what was always true: this object
// holds the conversation state, owned by a Participant, optionally shared
// with co-participants. Sessions still exist conceptually as the runtime
// spawn-loop bookkeeping (see chat.ts) but they are transient and not
// persisted under that name.
//
// /angel finding F10 (Thousand-Foot Critical, ADR-focus): the old single
// `Session.name` string was a URL slug, transcript filename, attribution
// suffix, participant key, AND rollback target simultaneously. Splitting
// the concepts is the change that unblocks classroom shapes (pair work,
// teacher office hours, two threads per student).

import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.js";
import type { ToolMutation } from "./types.js";

const THREADS_KEY = ".threads.json";
const LEGACY_SESSIONS_KEY = ".sessions.json"; // pre-2026-05-26 layout

export interface ThreadRecord {
  /** URL slug + transcript filename. Stable. */
  id: string;
  /** The primary participant. ACL primitive: ownerId is the "this thread belongs to" answer. */
  ownerId: string;
  /** Other participants who can read/write. Excludes owner. */
  coParticipantIds: string[];
  /** Optional human-readable label (e.g., "alice — homework week 3"). */
  title?: string;
  claudeSessionId: string | null;
  hasMessages: boolean;
  createdAt: string;
  lastUsedAt: string;
  toolMutations: ToolMutation[];
}

interface PersistedShape {
  threads: ThreadRecord[];
}

interface LegacySessionShape {
  sessions: Array<{
    name: string;
    claudeSessionId: string | null;
    participantIds: string[];
    hasMessages: boolean;
    createdAt: string;
    lastUsedAt: string;
    toolMutations: ToolMutation[];
  }>;
}

const SAFE_ID = /^[\w.-]{1,64}$/;

export function sanitizeThreadId(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, "_");
  const cleaned = trimmed.replace(/[^\w.-]/g, "");
  if (!cleaned) throw new Error("thread: id resolves to empty");
  if (!SAFE_ID.test(cleaned)) {
    throw new Error(`thread: invalid id ${JSON.stringify(input)}`);
  }
  return cleaned;
}

/** Make a new claude session id (UUID v4 suitable for `claude --session-id`). */
export function newClaudeSessionId(): string {
  return randomUUID();
}

export interface ThreadStoreOptions {
  /** Trailing debounce on `.threads.json` writes. Default 300ms; 0 disables. */
  persistDebounceMs?: number;
}

export interface ThreadCreateOptions {
  ownerId: string;
  coParticipantIds?: string[];
  title?: string;
}

export interface ThreadStore {
  /** Get an existing thread by id, or null. */
  get(id: string): Promise<ThreadRecord | null>;
  /** Create a thread with explicit owner. Throws if the id already exists. */
  create(id: string, opts: ThreadCreateOptions): Promise<ThreadRecord>;
  /** Get if exists, else create with the given owner. */
  getOrCreate(id: string, opts: ThreadCreateOptions): Promise<ThreadRecord>;
  list(): Promise<ThreadRecord[]>;
  setClaudeId(id: string, claudeSessionId: string): Promise<void>;
  markHasMessages(id: string): Promise<void>;
  addCoParticipant(id: string, participantId: string): Promise<void>;
  recordMutation(id: string, mutation: ToolMutation): Promise<void>;
  takeMutations(id: string): Promise<ToolMutation[]>;
  end(id: string): Promise<void>;
  /** Flush any pending debounced persist. Call on graceful shutdown. */
  flush(): Promise<void>;
}

export function createThreadStore(storage: Storage, opts: ThreadStoreOptions = {}): ThreadStore {
  const debounceMs = opts.persistDebounceMs ?? 300;
  let cache: Map<string, ThreadRecord> | null = null;
  let pendingTimer: NodeJS.Timeout | null = null;
  let pendingResolves: Array<() => void> = [];

  async function migrateFromLegacy(): Promise<Map<string, ThreadRecord> | null> {
    const legacy = await storage.read<LegacySessionShape | { threads: undefined }>(
      LEGACY_SESSIONS_KEY,
      { threads: undefined } as never,
    );
    if (!("sessions" in legacy) || !Array.isArray(legacy.sessions)) return null;
    console.warn(
      `appa/thread: migrating ${legacy.sessions.length} legacy session(s) to .threads.json`,
    );
    const map = new Map<string, ThreadRecord>();
    for (const s of legacy.sessions) {
      // Kidwind convention was session.name === participant id. Use the
      // first participant or the name itself as the owner.
      const ownerId = s.participantIds[0] ?? s.name;
      const coParticipantIds = s.participantIds.filter((p) => p !== ownerId);
      map.set(s.name, {
        id: s.name,
        ownerId,
        coParticipantIds,
        claudeSessionId: s.claudeSessionId,
        hasMessages: s.hasMessages,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        toolMutations: s.toolMutations,
      });
    }
    await storage.write<PersistedShape>(THREADS_KEY, { threads: [...map.values()] });
    return map;
  }

  async function load(): Promise<Map<string, ThreadRecord>> {
    if (cache) return cache;
    const data = await storage.read<PersistedShape>(THREADS_KEY, { threads: [] });
    if (data.threads.length === 0) {
      // No threads file yet — check for a legacy sessions file to migrate.
      const migrated = await migrateFromLegacy();
      if (migrated) {
        cache = migrated;
        return cache;
      }
    }
    cache = new Map(data.threads.map((t) => [t.id, t]));
    return cache;
  }

  async function writeNow(): Promise<void> {
    if (!cache) return;
    await storage.write<PersistedShape>(THREADS_KEY, { threads: [...cache.values()] });
  }

  function schedulePersist(): Promise<void> {
    if (debounceMs <= 0) return writeNow();
    return new Promise<void>((resolve) => {
      pendingResolves.push(resolve);
      if (pendingTimer) return;
      pendingTimer = setTimeout(() => {
        const resolves = pendingResolves;
        pendingResolves = [];
        pendingTimer = null;
        writeNow()
          .then(() => {
            for (const r of resolves) r();
          })
          .catch((err) => {
            console.error("appa/thread: persist failed", err);
            for (const r of resolves) r();
          });
      }, debounceMs);
    });
  }

  async function persist(map: Map<string, ThreadRecord>): Promise<void> {
    cache = map;
    await schedulePersist();
  }

  async function flush(): Promise<void> {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      const resolves = pendingResolves;
      pendingResolves = [];
      await writeNow();
      for (const r of resolves) r();
    }
  }

  function blank(id: string, opts: ThreadCreateOptions): ThreadRecord {
    const now = new Date().toISOString();
    const coParticipantIds = [
      ...new Set((opts.coParticipantIds ?? []).filter((p) => p !== opts.ownerId)),
    ];
    const record: ThreadRecord = {
      id,
      ownerId: opts.ownerId,
      coParticipantIds,
      claudeSessionId: null,
      hasMessages: false,
      createdAt: now,
      lastUsedAt: now,
      toolMutations: [],
    };
    if (opts.title) record.title = opts.title;
    return record;
  }

  return {
    async get(id) {
      const map = await load();
      return map.get(sanitizeThreadId(id)) ?? null;
    },
    async create(id, opts) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      if (map.has(safe)) throw new Error(`thread: ${safe} already exists`);
      const t = blank(safe, opts);
      map.set(safe, t);
      await persist(map);
      return t;
    },
    async getOrCreate(id, opts) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const existing = map.get(safe);
      if (existing) return existing;
      const t = blank(safe, opts);
      map.set(safe, t);
      await persist(map);
      return t;
    },
    async list() {
      const map = await load();
      return [...map.values()];
    },
    async setClaudeId(id, claudeSessionId) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const t = map.get(safe);
      if (!t) return;
      t.claudeSessionId = claudeSessionId;
      t.lastUsedAt = new Date().toISOString();
      map.set(safe, t);
      await persist(map);
    },
    async markHasMessages(id) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const t = map.get(safe);
      if (!t) return;
      t.hasMessages = true;
      t.lastUsedAt = new Date().toISOString();
      map.set(safe, t);
      await persist(map);
    },
    async addCoParticipant(id, participantId) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const t = map.get(safe);
      if (!t) return;
      if (participantId === t.ownerId) return;
      if (t.coParticipantIds.includes(participantId)) return;
      t.coParticipantIds = [...t.coParticipantIds, participantId];
      map.set(safe, t);
      await persist(map);
    },
    async recordMutation(id, mutation) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const t = map.get(safe);
      if (!t) return;
      t.toolMutations.push(mutation);
      map.set(safe, t);
      await persist(map);
    },
    async takeMutations(id) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      const t = map.get(safe);
      if (!t) return [];
      const muts = t.toolMutations;
      t.toolMutations = [];
      map.set(safe, t);
      await persist(map);
      return muts;
    },
    async end(id) {
      const map = await load();
      const safe = sanitizeThreadId(id);
      map.delete(safe);
      await persist(map);
    },
    flush,
  };
}

/** Caller may act on this thread: owner, a co-participant, or a coach. */
export function callerOwnsThread(
  caller: { id: string; isCoach: boolean },
  thread: { ownerId: string; coParticipantIds: string[] },
): boolean {
  if (caller.isCoach) return true;
  if (thread.ownerId === caller.id) return true;
  return thread.coParticipantIds.includes(caller.id);
}
