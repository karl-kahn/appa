// pattern: imperative-shell
// Read-only view of chat sessions + transcripts.

import { createTranscriptStore } from "../../core/transcript.js";
import type { AppaModule } from "../types.js";

const promptFragment = `
You can inspect past chat sessions to recall what was discussed.
- \`get_activity\`: list sessions with participant counts and last-used timestamps.
- \`read_transcript\`: read the messages in one session. Params: \`name\` (required), \`limit\` (optional, default 50).
Use these only when the user references past work — never to surveil another student.
`;

const mod: AppaModule = {
  name: "activity",
  promptFragment,
  tools: {
    get_activity: async ({ ctx }) => {
      const sessions = await ctx.sessions.list();
      return sessions.map((s) => ({
        name: s.name,
        participantIds: s.participantIds,
        hasMessages: s.hasMessages,
        lastUsedAt: s.lastUsedAt,
      }));
    },
    read_transcript: async ({ params, ctx }) => {
      const name = typeof params.name === "string" ? params.name : "";
      const limit = typeof params.limit === "number" ? params.limit : 50;
      if (!name) return { error: "name required" };
      const ts = createTranscriptStore(ctx.projectDir);
      const entries = await ts.read(name, Math.min(limit, 200));
      return { entries };
    },
  },
  routes: (router, ctx) => {
    router.get("/api/activity", async (_req, res) => {
      const sessions = await ctx.sessions.list();
      res.json({
        sessions: sessions.map((s) => ({
          name: s.name,
          participantIds: s.participantIds,
          hasMessages: s.hasMessages,
          lastUsedAt: s.lastUsedAt,
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
