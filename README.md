# Appa

A web chat tutor + team workspace kernel. Each user in a roster gets their own chat with a project-defined Claude persona; the same UI surfaces tabs for whatever a team needs — task board, photos, activity log, plus any custom modules you bolt on.

Originally extracted from the [Hardy Hawks KidWind project](https://github.com/karl-kahn/kidwind-appa). This package is the generic kernel; KidWind-specific bits (blade CAD, wind-tunnel test log, donor management, GoFundMe builder) live in `kidwind-appa` as a downstream consumer of `appa`.

> Status: **0.1.0 stub.** Architecture and core spawn loop are in. Module API stabilizing. Not yet on npm.

## Shape it fits

- Many participants (a class, a team, a cohort) sharing one project
- AI tutor with a project-specific persona and accumulated team memory
- Multiple input surfaces (chat, task board, file uploads, custom forms) that all live on the same shared state
- Coach/teacher + student/member role split
- Local-first storage in JSON files; trivial to back up, diff, version

## Quick start (once published)

```bash
npx create-appa my-classroom
cd my-classroom
cp .env.example .env  # set ANTHROPIC_API_KEY
npm install
npm start
```

Open http://127.0.0.1:3848. Pick a user from `team.json`, start chatting. Coaches see admin tabs; students see only their own data.

## Core concept: kernel + modules

The **kernel** owns:

- Claude CLI spawn harness with persona injection
- Session state (per-user chat thread, transcript persistence)
- Tool round-trip (`|||TOOL_CALL|||` block parsing, allowlist enforcement, mutation tracking + rollback)
- Team roster + role-based auth
- Shared memory loader (a markdown file that gets appended to every system prompt)
- Rate limiting on spawns
- Activity log

A **module** is a self-contained bundle that adds:

- HTTP routes (Express router)
- Tutor tools (read/write callbacks the persona can invoke)
- A UI tab (HTML fragment + optional JS)
- A persona-prompt fragment (concatenated into the system prompt)
- One or more JSON data files

`appa` ships three generic modules out of the box: `tasks`, `photos`, `activity`.

## Architecture in 60 seconds

```
appa.config.ts  ── your config (team.json path, modules to load, tutor persona)
       │
       ▼
appa CLI ── loads kernel + modules ── starts Express on :3848
       │
       ▼
Browser ── picks user from team.json ── opens chat tab
       │
       ▼
POST /api/chat ── spawns `claude -p` ── streams SSE back
       │              │
       │              └─ tutor emits |||TOOL_CALL||| → kernel dispatches to module → resumes Claude with result
       │
       ▼
On session end ── transcript persisted ── summarized into shared-memory.md for the next session
```

## Project layout

```
src/
  core/           # kernel: spawn, session, transcript, tools, storage, memory
  server/         # express wiring
  modules/        # generic modules (tasks, photos, activity)
  scaffold/       # create-appa CLI
public/           # browser UI shell
templates/        # files copied by create-appa into a new project
```

## Building your own module

A module is a single file (or a directory with an `index.ts`) that exports an `AppaModule`. See `src/modules/tasks/` for a worked example. Skeleton:

```ts
import type { AppaModule } from "appa";

export default {
  name: "my-module",
  promptFragment: "You can ask about ... using the get_foo tool.",
  tools: {
    get_foo: async ({ storage }) => storage.read("foo"),
    create_foo: async ({ storage, params, attribution }) => { /* ... */ },
  },
  routes: (router, { storage }) => {
    router.get("/api/foo", async (_req, res) => res.json(await storage.read("foo")));
  },
  tab: {
    id: "foo-view",
    label: "Foo",
    htmlPath: "tab.html",
  },
} satisfies AppaModule;
```

## Security posture

The spawned `claude -p` subprocess runs with:

- `--setting-sources project` (no user MCPs/hooks/skills)
- `--disallowed-tools` covering Bash, Write, Edit, Read, Glob, Grep, MCP, Agent, WebFetch, WebSearch
- A minimal env whitelist (HOME, PATH, TERM, LANG, ANTHROPIC_API_KEY)
- Stripped `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` to prevent silent exits

The kernel enforces:

- An allowlist of tutor tools (no dynamic dispatch)
- Forced attribution on write ops (`tutor:<sessionName>`)
- Max 3 tool rounds per user message (prevents runaway tutoring loops)
- Session name sanitization (no path traversal)
- Hourly/daily spawn limits

The kernel does **not** include an authentication layer for the web UI. Don't expose `appa` to the open internet without one. The Hardy Hawks deployment fronts it with Tailscale Funnel.

## Development

```bash
npm install
npm run dev       # tsx watch
npm test
npm run validate  # format + lint + typecheck + test + lint:dead
```

## License

MIT.
