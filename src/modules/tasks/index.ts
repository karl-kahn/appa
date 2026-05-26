// pattern: imperative-shell
// Generic kanban task board.

import { z } from "zod";
import type { AppaModule } from "../types.js";

const Column = z.enum(["backlog", "active", "testing", "done"]);

const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  column: Column,
  assignee: z.string().optional(),
  due: z.string().optional(),
  notes: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

const CreateInput = z.object({
  title: z.string().min(1).max(200),
  column: Column.default("backlog"),
  assignee: z.string().optional(),
  due: z.string().optional(),
  notes: z.string().optional(),
});

const UpdateInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  column: Column.optional(),
  assignee: z.string().optional().nullable(),
  due: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const DeleteInput = z.object({ id: z.string() });

const KEY = "tasks.json";

function nextId(tasks: Task[]): string {
  const max = tasks.reduce((m, t) => {
    const n = Number(t.id);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return String(max + 1);
}

const promptFragment = `
The team has a task board with columns: backlog, active, testing, done.
You can read tasks with \`get_tasks\` and write with \`create_task\`, \`update_task\`, \`delete_task\`.
Always confirm with the user before writing.

Tool params:
- \`create_task\`: \`title\` (required), \`column\` (default backlog), \`assignee\` (member id), \`due\` (ISO date), \`notes\`
- \`update_task\`: \`id\` (required), plus any field
- \`delete_task\`: \`id\` (required)
`;

const mod: AppaModule = {
  name: "tasks",
  promptFragment,
  tools: {
    get_tasks: async ({ ctx }) => ctx.storage.read<Task[]>(KEY, []),
    create_task: async ({ params, ctx, attribution }) => {
      const input = CreateInput.parse(params);
      const created = await ctx.storage.update<Task[]>(KEY, [], (cur) => {
        const next: Task = {
          ...input,
          id: nextId(cur),
          createdBy: attribution,
          createdAt: new Date().toISOString(),
        };
        return [...cur, next];
      });
      return created[created.length - 1];
    },
    update_task: async ({ params, ctx }) => {
      const input = UpdateInput.parse(params);
      let found = false;
      const list = await ctx.storage.update<Task[]>(KEY, [], (cur) =>
        cur.map((t) => {
          if (t.id !== input.id) return t;
          found = true;
          return { ...t, ...stripNulls(input) } as Task;
        }),
      );
      if (!found) {
        throw new Error(`update_task: no task with id ${JSON.stringify(input.id)}`);
      }
      return list.find((t) => t.id === input.id);
    },
    delete_task: async ({ params, ctx }) => {
      const input = DeleteInput.parse(params);
      let found = false;
      const after = await ctx.storage.update<Task[]>(KEY, [], (cur) => {
        const next = cur.filter((t) => {
          if (t.id === input.id) {
            found = true;
            return false;
          }
          return true;
        });
        return next;
      });
      if (!found) {
        throw new Error(`delete_task: no task with id ${JSON.stringify(input.id)}`);
      }
      return { deleted: input.id, remaining: after.length };
    },
  },
  routes: (router, { storage }) => {
    router.get("/api/tasks", async (_req, res) => {
      res.json({ tasks: await storage.read<Task[]>(KEY, []) });
    });
    router.post("/api/tasks", async (req, res) => {
      const parsed = CreateInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const updated = await storage.update<Task[]>(KEY, [], (cur) => [
        ...cur,
        {
          ...parsed.data,
          id: nextId(cur),
          createdBy: "ui",
          createdAt: new Date().toISOString(),
        },
      ]);
      res.json({ task: updated[updated.length - 1] });
    });
    router.put("/api/tasks/:id", async (req, res) => {
      const id = typeof req.params.id === "string" ? req.params.id : "";
      const parsed = UpdateInput.safeParse({ ...req.body, id });
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const updated = await storage.update<Task[]>(KEY, [], (cur) =>
        cur.map((t) => (t.id === id ? ({ ...t, ...stripNulls(parsed.data) } as Task) : t)),
      );
      res.json({ task: updated.find((t) => t.id === id) ?? null });
    });
    router.delete("/api/tasks/:id", async (req, res) => {
      const id = typeof req.params.id === "string" ? req.params.id : "";
      let found = false;
      await storage.update<Task[]>(KEY, [], (cur) =>
        cur.filter((t) => {
          if (t.id === id) {
            found = true;
            return false;
          }
          return true;
        }),
      );
      if (!found) {
        res.status(404).json({ error: `no task with id ${id}` });
        return;
      }
      res.json({ deleted: id });
    });
  },
  tab: {
    id: "board-view",
    label: "Board",
    htmlPath: "tab.html",
  },
  dir: new URL(".", import.meta.url).pathname,
};

function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export default mod;
