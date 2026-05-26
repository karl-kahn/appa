# Appa — Project Instructions

Appa is the kernel productized out of `kidwind-worlds/server/`. The aim is a tiny, opinionated framework: any project with the shape "many people, one shared workspace, an AI tutor with a domain persona, multiple input surfaces" should be able to stand up an Appa instance with a config file and one or two custom modules.

## Sister projects

- `~/Projects/kidwind-worlds/server/` — the original implementation. Reference for behavior; don't import from it.
- `~/Projects/kidwind-appa/` — earlier extraction, still KidWind-specific (turbine tutor, blade CAD, donors, GoFundMe). After `appa` stabilizes, the goal is to refactor `kidwind-appa` into a thin module layer on top of `appa`.

## Architecture rules

1. **Kernel does no domain work.** If a feature only makes sense for one kind of project (wind turbines, classrooms, debate club), it belongs in a module, not the kernel.
2. **Modules are self-contained.** One module = one directory under `src/modules/<name>/` with `index.ts`, routes, tools, prompt fragment, and tab fragment.
3. **No cross-module imports.** Modules don't know about each other. If two modules need to share state, that's a kernel concern.
4. **JSON files for persistence.** No database. Each module gets a `storage` namespace and reads/writes JSON. Aim: a project's full state is grep-able and `git add`-able.
5. **Tests as spec.** Every kernel piece (spawn, session, tools, storage) has a `.test.ts` next to it.
6. **FCIS markers.** Each source file starts with exactly one of:
   - `// pattern: functional-core` — pure logic, no IO, no side effects (testable as pure functions)
   - `// pattern: imperative-shell` — IO, spawn, network, filesystem, Express handlers
   - `// pattern: types-only` — no runtime export (or only trivial helpers that don't justify a separate label), just type declarations + re-exports

   Pick the dominant pattern for the file. If you can't pick — split the file. Dual or hyphenated labels (`functional-core + imperative-shell (foo)`) are not valid; they're a signal the file needs to be split.

## Tech stack

- TypeScript strict, ESM only, Node 20+
- Express 5 (matches existing Appa; resist the urge to switch to Hono mid-extraction)
- Vitest + happy-dom for UI tests
- Biome for format/lint
- Knip + Fallow for dead-code gate (wired into `npm run validate`)
- zod for runtime validation of tool params and config

## What ships in this repo

- The kernel (spawn, session, transcript, tools, storage, memory, rate-limit, auth)
- Generic modules: `tasks`, `photos`, `activity`
- `create-appa` scaffold CLI
- A demo `templates/` directory with `team.json`, sample `appa.config.ts`, sample `tutor-prompt.md`, sample `shared-memory.md`
- The browser UI shell (in `public/`) with hooks for module-supplied tabs

## What does NOT ship here

- KidWind-specific modules (blade CAD, donors, GoFundMe, wind tunnel test log) — those stay in `kidwind-appa`
- Authentication (the kernel has no auth; deployment must front it)
- File-storage abstractions beyond local disk JSON files (S3, D1, etc. are the consumer's problem)

## Workflow

- Branch → TDD (test first, watch fail, implement) → `npm run validate` → commit
- Conventional commits: `feat:`, `fix:`, `refactor:`, etc.
- ADRs in `docs/decisions/NN-<slug>.md` for any non-obvious architecture choice
- The kernel is the load-bearing surface for downstream projects. Per global `quality.md`, ADRs in `docs/decisions/` are load-bearing by default — include confidence and falsifiers on key claims.

## Open questions (track in backlog)

- Should the storage layer support a pluggable backend (SQLite/D1) for projects that outgrow JSON files?
- Module API: should `tools` and `routes` be one surface (tool calls = HTTP routes under the hood) or stay separate?
- How does a module declare it needs participant info (role-based auth)?
- Sandboxing — is the env whitelist enough, or do we want a `claude -p` shim that runs as a different uid in production?

## Sessions

Use `/kickoff` at start, `/wrap` at end. Memory dir is at `~/.claude/projects/-home-karl-Projects-appa/memory/` (auto-created on first /wrap).
