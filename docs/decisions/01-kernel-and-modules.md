# ADR 01 — Kernel + opt-in modules, not a framework

Date: 2026-05-25
Status: Proposed (pending /angel pass + Karl review)

## Context

`kidwind-worlds/server/index.js` is 139KB of single-file Express with 45 routes, 25+ helpers, 14 UI tabs, and 40 tutor tools. It works in production for the Hardy Hawks but is impossible to reuse: the generic chat-and-tutor spine is tangled with KidWind-specific surface (wind-tunnel test logs, blade CAD, OnShape, donors, GoFundMe).

We want to extract the generic pieces so future projects shaped like Appa — many people, one shared workspace, an AI tutor with a domain persona, multiple input surfaces — can stand one up with a config file and a couple of custom modules. Classroom interfaces are an explicit target use case.

## Decision

Build `appa` as a **kernel + opt-in modules** package. Not a framework, not a template repo, not a copy-and-fork.

**Kernel** (this package): the pieces every Appa instance needs.

- Claude CLI spawn harness (`claude -p` with stream-json, persona injection, env whitelist, `--disallowed-tools` defense in depth)
- Session state (per-user thread, in-memory + persisted to `.sessions.json`)
- Transcript I/O (per-session `.jsonl` files, summarization on session end)
- Tool round-trip (`|||TOOL_CALL|||` parsing, allowlist, mutation tracking + rollback, max-3-rounds guard)
- Storage (typed key/value over JSON files in a project directory)
- Team roster + role-based auth (coach vs student/member)
- Shared memory (a markdown file appended to every system prompt, updated by summarization)
- Rate limiting (hourly + daily spawn caps with hard cutoff)
- Activity log (read-only view of sessions + message counts; ships as a generic module on top of kernel events)

**Modules** (shipped or third-party): one self-contained directory that exports an `AppaModule` with:

- `name`
- `promptFragment?` — concatenated into the tutor persona
- `tools?` — record of named handlers the tutor can invoke
- `routes?(router, ctx)` — Express router registration
- `tab?` — `{id, label, htmlPath, jsPath?}` for the UI shell to render
- `init?(ctx)` — one-time setup (default file scaffolds)

Modules cannot import each other. If two modules need shared state, that's a kernel concern.

`appa` ships three generic modules:
- `tasks` — kanban board (backlog/active/testing/done, assignees, due dates)
- `photos` — uploads with uploader attribution and listing
- `activity` — read-only session log

KidWind-specific modules (test results, designs, journal, gears, blooket, gofundme, donors) stay in `kidwind-appa` once it gets refactored to consume `appa`.

## Rejected alternatives

1. **Template repo (cookiecutter).** Copy the directory, fill in three files, customize freely. *Rejected* because every classroom that diverges has to manually backport kernel fixes — drift kills it within months.

2. **Framework (Appa knows about your domain).** Bake in concepts like "assignment," "submission," "grade." *Rejected* because we don't know yet what shapes downstream projects need; baking the wrong abstraction in is worse than no abstraction. Worked-example projects (kidwind, classroom) will tell us what to lift.

3. **One big package with everything.** Ship kernel + all known modules in one. *Rejected* because the second classroom that doesn't want a GoFundMe builder shouldn't have to read past it. Generic modules in core, domain modules in consumer packages.

4. **Rewrite to Cloudflare Workers / Hono.** *Rejected for v1* — the existing Appa is Express 5 + Node + JSON files. Porting to Workers + D1 is a different project and not load-bearing for "can a teacher set this up." Revisit if a consumer hits scale that JSON files can't handle.

## Constraints we're keeping

- **Local-first JSON storage.** Grep-able, diff-able, `git add`-able. No SQL, no D1, no Postgres in the kernel. (Pluggable storage backend is on the open-questions list.)
- **Single process.** No worker pool, no queue, no Redis. Sessions are in-memory + JSON-persisted.
- **Express 5.** Not Hono, not Fastify. Match the existing implementation to minimize port risk.
- **Forced attribution on writes.** Every tool write records `tutor:<sessionName>`; rollback is a kernel primitive.
- **No auth in the kernel.** Deployment fronts it (Tailscale Funnel, nginx basic auth, reverse proxy, etc.).

## Module API sketch

```ts
import type { AppaModule } from "appa";

export default {
  name: "tasks",
  promptFragment: `
    The team has a task board with columns backlog, active, testing, done.
    You can read it with get_tasks and write with create_task / update_task / delete_task.
  `,
  tools: {
    get_tasks: async ({ storage }) => storage.read("tasks", []),
    create_task: async ({ storage, params, attribution }) => {
      const tasks = await storage.read<Task[]>("tasks", []);
      const next = { ...validate(params), id: nextId(tasks), createdBy: attribution };
      await storage.write("tasks", [...tasks, next]);
      return next;
    },
  },
  routes: (router, { storage }) => {
    router.get("/api/tasks", async (_req, res) => res.json(await storage.read("tasks", [])));
    router.post("/api/tasks", async (req, res) => { /* ... */ });
  },
  tab: {
    id: "board-view",
    label: "Board",
    htmlPath: "tab.html",
  },
} satisfies AppaModule;
```

A consumer's `appa.config.ts` looks like:

```ts
import { defineConfig } from "appa";
import tasks from "appa/modules/tasks";
import photos from "appa/modules/photos";
import activity from "appa/modules/activity";
import journal from "./modules/journal";  // domain-specific

export default defineConfig({
  projectDir: ".",
  port: 3848,
  modules: [tasks, photos, activity, journal],
  tutorPromptPath: "tutor-prompt.md",
  sharedMemoryPath: "shared-memory.md",
  teamPath: "team.json",
  model: "sonnet",
});
```

## Falsifiers

- **The kernel is too thin:** if writing a classroom module forces re-implementing things the kernel should own (auth scoping, per-user storage isolation, role checks), the kernel is missing concepts.
- **The kernel is too fat:** if a module needs to override or stub three kernel surfaces to get the behavior it wants, the kernel made assumptions it shouldn't have.
- **Module API leaks:** if a third-party module needs to import from `appa/internals` to do something reasonable, the module API needs widening.
- **Drift trap:** if six months in, `kidwind-appa` has copy-pasted half the kernel back into itself to fix bugs not yet fixed upstream, the kernel-as-library model is failing and a more invasive integration (or framework approach) is warranted.

## Confidence and could-be-wrong

- **Claim:** kernel + modules is the right shape vs. template-repo or framework.
  - Confidence: 0.75 | Tier: read-the-code (read existing Appa, designed against it)
  - Could-be-wrong-if: the second concrete use case (classroom) requires reworking kernel concepts (e.g., "team" doesn't fit a class of 30 students; "session" doesn't fit a long-running assignment). Concrete signal: when porting kidwind-appa to consume the kernel, ≥3 kernel concepts need renaming or reshaping.

- **Claim:** Express 5 + JSON files is the right substrate for v1.
  - Confidence: 0.85 | Tier: ran-and-saw-output (kidwind Appa runs on this stack in production)
  - Could-be-wrong-if: a classroom of 30 produces JSON files that lock contention starts mattering. Concrete signal: 100ms+ writes under concurrent load in profiling.

- **Claim:** three generic modules (tasks, photos, activity) is the right initial cut.
  - Confidence: 0.6 | Tier: read-the-code
  - Could-be-wrong-if: any of the three turns out to need significant per-project customization beyond config (e.g., "tasks" needs custom column names per project, "photos" needs per-album scoping). Then the module should ship as an opt-in pattern rather than a default.
