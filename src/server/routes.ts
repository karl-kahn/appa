// pattern: imperative-shell
import type { Request, Response, Router } from "express";
import type { SessionStore } from "../core/session.js";
import type { TranscriptStore } from "../core/transcript.js";
import type { TeamReader } from "../core/team.js";

export interface CoreRoutesDeps {
  team: TeamReader;
  sessions: SessionStore;
  transcripts: TranscriptStore;
  tabs: Array<{ moduleName: string; tab: { id: string; label: string; visibleTo?: string[] } }>;
}

export function mountCoreRoutes(router: Router, deps: CoreRoutesDeps): void {
  const { team, sessions, transcripts, tabs } = deps;

  router.get("/api/team", async (_req, res) => {
    res.json({ members: await team.list() });
  });

  router.get("/api/tabs", async (_req, res) => {
    res.json({ tabs: tabs.map((t) => ({ ...t.tab, moduleName: t.moduleName })) });
  });

  router.get("/api/sessions", async (_req, res) => {
    const list = await sessions.list();
    res.json({
      sessions: list.map((s) => ({
        name: s.name,
        participantIds: s.participantIds,
        hasMessages: s.hasMessages,
        lastUsedAt: s.lastUsedAt,
      })),
    });
  });

  router.get("/api/session/:name", async (req, res) => {
    const name = req.params.name ?? "";
    const s = await sessions.get(name);
    if (!s) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(s);
  });

  router.post("/api/session/:name/end", async (req, res) => {
    const name = req.params.name ?? "";
    await sessions.end(name);
    res.json({ ended: name });
  });

  router.post("/api/session/:name/rollback", async (req, res) => {
    const name = req.params.name ?? "";
    const muts = await sessions.takeMutations(name);
    // The kernel cannot actually undo tool effects — modules must record undo data
    // and the kernel exposes mutations so callers can compensate. Future hook.
    res.json({ rolledBack: muts.length, mutations: muts });
  });

  router.get("/api/transcripts", async (_req, res) => {
    res.json({ transcripts: await transcripts.list() });
  });

  router.get("/api/transcripts/:name", async (req: Request, res: Response) => {
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const limit = Number(req.query.limit ?? 100);
    res.json({ entries: await transcripts.read(name, limit) });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
}
