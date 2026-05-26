// pattern: imperative-shell
// TeamReader wraps storage with a single-process in-memory cache. Hot path
// (chat.ts:resolveCaller, sessionBlock) reads team.json on every request; the
// cache cuts disk reads from ~3/request to once per server boot + on team.refresh().
import type { Storage } from "./storage.js";
import type { Role, Team, TeamMember } from "./types.js";

const EMPTY_TEAM: Team = { members: [] };

export interface TeamReader {
  list(): Promise<TeamMember[]>;
  findById(id: string): Promise<TeamMember | null>;
  hasRole(id: string, role: Role): Promise<boolean>;
  isCoach(id: string): Promise<boolean>;
  /** Invalidate cache; next read hits disk. Call after roster edits. */
  refresh(): Promise<Team>;
}

export function createTeamReader(storage: Storage, key = "team.json"): TeamReader {
  let cache: Team | null = null;
  let inflight: Promise<Team> | null = null;

  async function loadFresh(): Promise<Team> {
    const raw = await storage.read<Team>(key, EMPTY_TEAM);
    return normalize(raw);
  }

  async function load(): Promise<Team> {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = loadFresh().then((t) => {
      cache = t;
      inflight = null;
      return t;
    });
    return inflight;
  }

  return {
    async list() {
      return (await load()).members;
    },
    async findById(id) {
      return (await load()).members.find((m) => m.id === id) ?? null;
    },
    async hasRole(id, role) {
      const m = (await load()).members.find((x) => x.id === id);
      return !!m && m.role === role;
    },
    async isCoach(id) {
      const m = (await load()).members.find((x) => x.id === id);
      return !!m && m.role === "coach";
    },
    async refresh() {
      cache = null;
      return load();
    },
  };
}

function normalize(team: unknown): Team {
  if (typeof team !== "object" || team === null) return EMPTY_TEAM;
  const t = team as Record<string, unknown>;
  const members = Array.isArray(t.members) ? t.members.filter(isMember) : [];
  return { ...t, members };
}

function isMember(value: unknown): value is TeamMember {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    (v.role === "coach" || v.role === "member")
  );
}
