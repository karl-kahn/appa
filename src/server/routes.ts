// pattern: imperative-shell
import type { Request, Response, Router } from "express";
import type { ResolvedConfig } from "../core/config.js";
import type { TeamReader } from "../core/team.js";
import { type ThreadStore, callerOwnsThread } from "../core/thread.js";
import type { TranscriptStore } from "../core/transcript.js";
import { resolveOr403 } from "./chat.js";

export interface CoreRoutesDeps {
  config: ResolvedConfig;
  team: TeamReader;
  threads: ThreadStore;
  transcripts: TranscriptStore;
  tabs: Array<{
    moduleName: string;
    tab: { id: string; label: string; visibleTo?: Array<"coach" | "member"> };
  }>;
}

export function mountCoreRoutes(router: Router, deps: CoreRoutesDeps): void {
  const { config, team, threads, transcripts, tabs } = deps;

  // /api/team: roster lookup for authenticated callers. Only id, name, role
  // and groupId exposed — extra fields (email, phone, etc.) stay private.
  router.get("/api/team", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const members = await team.list();
    res.json({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        ...(m.groupId !== undefined ? { groupId: m.groupId } : {}),
      })),
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

  // /api/threads: list. Non-coaches see only threads they participate in.
  router.get("/api/threads", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const all = await threads.list();
    const visible = caller.isCoach ? all : all.filter((t) => callerOwnsThread(caller, t));
    res.json({
      threads: visible.map((t) => ({
        id: t.id,
        ownerId: t.ownerId,
        coParticipantIds: t.coParticipantIds,
        title: t.title,
        hasMessages: t.hasMessages,
        lastUsedAt: t.lastUsedAt,
      })),
    });
  });

  router.get("/api/threads/:id", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const t = await threads.get(id);
    if (!t) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!callerOwnsThread(caller, t)) {
      res.status(403).json({ error: "not your thread" });
      return;
    }
    res.json(t);
  });

  router.post("/api/threads/:id/end", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const t = await threads.get(id);
    if (t && !callerOwnsThread(caller, t)) {
      res.status(403).json({ error: "not your thread" });
      return;
    }
    await threads.end(id);
    res.json({ ended: id });
  });

  router.post("/api/threads/:id/rollback", async (req, res) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const id = typeof req.params.id === "string" ? req.params.id : "";
    const t = await threads.get(id);
    if (t && !callerOwnsThread(caller, t)) {
      res.status(403).json({ error: "not your thread" });
      return;
    }
    const muts = await threads.takeMutations(id);
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
    // For non-coaches: a transcript is visible if its corresponding thread
    // is callerOwnsThread, or (fallback) the transcript name equals the
    // caller's id (handles threads that ended/were cleared from memory).
    const visible: typeof all = [];
    for (const entry of all) {
      const t = await threads.get(entry.name);
      if (t) {
        if (callerOwnsThread(caller, t)) visible.push(entry);
      } else if (entry.name === caller.id) {
        visible.push(entry);
      }
    }
    res.json({ transcripts: visible });
  });

  router.get("/api/transcripts/:name", async (req: Request, res: Response) => {
    const caller = await resolveOr403(req, res, { config });
    if (!caller) return;
    const name = typeof req.params.name === "string" ? req.params.name : "";
    const t = await threads.get(name);
    if (t) {
      if (!callerOwnsThread(caller, t)) {
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
