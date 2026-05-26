// pattern: imperative-shell
// Read-only view of chat threads + transcripts.

import { callerOwnsThread } from "../../core/thread.js";
import type { AppaModule } from "../types.js";

const promptFragment = `
You can inspect past chat threads to recall what was discussed.
- \`get_activity\`: list threads the caller participates in.
- \`read_transcript\`: read the messages in one thread. Params: \`id\` (required), \`limit\` (optional, default 50). Coaches can read any thread; non-coaches can read only their own.
Use these only when the user references past work — never to surveil another student.
`;

const mod: AppaModule = {
  name: "activity",
  promptFragment,
  tools: {
    get_activity: async ({ ctx, caller }) => {
      const all = await ctx.threads.list();
      const visible = caller.isCoach ? all : all.filter((t) => callerOwnsThread(caller, t));
      return visible.map((t) => ({
        id: t.id,
        ownerId: t.ownerId,
        coParticipantIds: t.coParticipantIds,
        hasMessages: t.hasMessages,
        lastUsedAt: t.lastUsedAt,
      }));
    },
    read_transcript: async ({ params, ctx, caller }) => {
      const id = typeof params.id === "string" ? params.id : "";
      const limit = typeof params.limit === "number" ? params.limit : 50;
      if (!id) return { error: "id required" };
      const t = await ctx.threads.get(id);
      if (t && !callerOwnsThread(caller, t)) {
        return { error: "not your thread" };
      }
      if (!t && !caller.isCoach && id !== caller.id) {
        return { error: "not your thread" };
      }
      const entries = await ctx.transcripts.read(id, Math.min(limit, 200));
      return { entries };
    },
  },
  routes: (router, ctx) => {
    router.get("/api/activity", async (req, res) => {
      const caller = await ctx.requireCaller(req, res);
      if (!caller) return;
      const all = await ctx.threads.list();
      const visible = caller.isCoach ? all : all.filter((t) => callerOwnsThread(caller, t));
      res.json({
        threads: visible.map((t) => ({
          id: t.id,
          ownerId: t.ownerId,
          coParticipantIds: t.coParticipantIds,
          hasMessages: t.hasMessages,
          lastUsedAt: t.lastUsedAt,
        })),
      });
    });
  },
  tab: {
    id: "activity-view",
    label: "Activity",
    htmlPath: "tab.html",
  },
  dir: new URL(".", import.meta.url).pathname,
};

export default mod;
