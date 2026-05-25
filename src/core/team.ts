// pattern: functional-core (lookups) + imperative-shell (file IO via storage)
import type { Storage } from "./storage.js";
import type { Role, Team, TeamMember } from "./types.js";

const EMPTY_TEAM: Team = { members: [] };

export interface TeamReader {
  list(): Promise<TeamMember[]>;
  findById(id: string): Promise<TeamMember | null>;
  hasRole(id: string, role: Role): Promise<boolean>;
  isCoach(id: string): Promise<boolean>;
}

export function createTeamReader(storage: Storage, key = "team.json"): TeamReader {
  async function load(): Promise<Team> {
    const raw = await storage.read<Team>(key, EMPTY_TEAM);
    return normalize(raw);
  }

  return {
    async list() {
      return (await load()).members;
    },
    async findById(id) {
      const team = await load();
      return team.members.find((m) => m.id === id) ?? null;
    },
    async hasRole(id, role) {
      const m = (await load()).members.find((x) => x.id === id);
      return !!m && m.role === role;
    },
    async isCoach(id) {
      const m = (await load()).members.find((x) => x.id === id);
      return !!m && m.role === "coach";
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
