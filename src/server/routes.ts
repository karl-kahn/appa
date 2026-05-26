// pattern: imperative-shell
import type { Request, Response, Router } from "express";
import type { ResolvedConfig } from "../core/config.js";
import type { SessionStore } from "../core/session.js";
import type { TeamReader } from "../core/team.js";
import type { TranscriptStore } from "../core/transcript.js";
import { callerOwnsSession } from "./auth.js";
import { resolveOr403 } from "./chat.js";

export interface CoreRoutesDeps {
  config: ResolvedConfig;
  team: TeamReader;
  sessions: SessionStore;
  transcripts: TranscriptStore;
  tabs: Array<{
    moduleName: string;
    tab: { id: string; label: string; visibleTo?: Array<"coach" | "member"> };
  }>;
}

export function mountCoreRoutes(router: Router, deps: CoreRoutesDeps): void {
  const { config, team, sessions, transcripts, tabs } = deps;

  // /api/team: roster lookup for authenticated callers. Only id, name,
  // role exposed — extra fields (email, phone, etc.) stay private.
  router.get("/api/team", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const members = await team.list();
    res.json({
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    });
  });

  // /api/bootstrap: unauthenticated picker source. Returns only id+name+role
  // so a fresh browser can render the user picker before identity is set.
  // Intentionally less than /api/team (no extra fields, no auth).
  router.get("/api/bootstrap", async (_req, res) => {
    const members = await team.list();
    res.json({
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    });
  });

  // /api/tabs: filtered by caller role per each tab's visibleTo declaration.
  router.get("/api/tabs", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const role = caller.isCoach ? "coach" : "member";
    res.json({
      tabs: tabs
        .filter((t) => !t.tab.visibleTo || t.tab.visibleTo.includes(role))
        .map((t) => ({ ...t.tab, moduleName: t.moduleName })),
    });
  });

  // /api/sessions: list. Non-coaches see only sessions they participate in.
  router.get("/api/sessions", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const all = await sessions.list();
    const visible = caller.isCoach
      ? all
      : all.filter((s) => callerOwnsSession(caller, s));
    res.json({
      sessions: visible.map((s) => ({
        name: s.name,
        participantIds: s.participantIds,
        hasMessages: s.hasMessages,
        lastUsedAt: s.lastUsedAt,
      })),
    });
  });

  router.get("/api/session/:name", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const s = await sessions.get(name);
    if (!s) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!callerOwnsSession(caller, s)) {
      res.status(403).json({ error: "not your session" });
      return;
    }
    res.json(s);
  });

  router.post("/api/session/:name/end", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const s = await sessions.get(name);
    if (s && !callerOwnsSession(caller, s)) {
      res.status(403).json({ error: "not your session" });
      return;
    }
    await sessions.end(name);
    res.json({ ended: name });
  });

  router.post("/api/session/:name/rollback", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const s = await sessions.get(name);
    if (s && !callerOwnsSession(caller, s)) {
      res.status(403).json({ error: "not your session" });
      return;
    }
    const muts = await sessions.takeMutations(name);
    // The kernel cannot actually undo tool effects — modules must record undo data
    // and the kernel exposes mutations so callers can compensate. Future hook.
    res.json({ rolledBack: muts.length, mutations: muts });
  });

  // /api/transcripts: list. Non-coaches see only their own.
  router.get("/api/transcripts", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const all = await transcripts.list();
    if (caller.isCoach) {
      res.json({ transcripts: all });
      return;
    }
    // For non-coaches, restrict to transcripts whose name is the caller's id.
    res.json({ transcripts: all.filter((t) => t.name === caller.id) });
  });

  router.get("/api/transcripts/:name", async (req: Request, res: Response) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const s = await sessions.get(name);
    // If the session record exists, use full ownership check; else fall back
    // to "name must equal caller id" (transcript may exist without an
    // in-memory session for completed runs).
    if (s) {
      if (!callerOwnsSession(caller, s)) {
        res.status(403).json({ error: "not your transcript" });
        return;
      }
    } else if (!caller.isCoach && name !== caller.id) {
      res.status(403).json({ error: "not your transcript" });
      return;
    }
    const limit = Number(req.query.limit ?? 100);
    res.json({ entries: await transcripts.read(name, limit) });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
}
