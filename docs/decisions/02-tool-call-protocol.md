# ADR 02 — Text-embedded `|||TOOL_CALL|||` protocol over native stream-json `tool_use`

Date: 2026-05-26
Status: Accepted (post-/angel 2026-05-25)

## Context

The Claude CLI's `--output-format stream-json` natively emits `tool_use` content blocks inside `assistant` messages. The Anthropic SDK's tool-calling API is the standard path for letting a model invoke a tool: declare tools, the model emits `tool_use`, the host runs the tool, the conversation continues.

Appa instead has the model emit tool calls as **text** wrapped in `|||TOOL_CALL|||` / `|||END_TOOL_CALL|||` delimiters inside its prose, parses them out of the assistant text, executes them, and re-spawns the model with the result as a follow-up user message.

The /angel review (2026-05-25) flagged this as a Critical finding three ways:
- **RTFM:** `mapStreamEvent` silently dropped native `tool_use` content blocks; works only because `--disallowed-tools` removes every native tool the model could use.
- **Test:** no test pinned this behavior; a regression would be invisible.
- **Future-Me:** the constraint ("we use text-embedded, not native") appears nowhere in the code; a maintainer seeing the dead `tool_use` arm in `mapStreamEvent` would obviously "fix" it and break Appa.

This ADR documents the decision and the migration path.

## Decision

Keep the text-embedded `|||TOOL_CALL|||` protocol for v0.1. Add explicit guards against silent drops of `tool_use` events. Plan a migration to native `tool_use` for v0.2+ once Anthropic's CLI behavior stabilizes and we've validated the migration shape against the kidwind-appa port.

## Why text-embedded for v0.1

1. **One protocol, two callers.** Appa's tool round-trip is identical whether the model is run via `claude -p` (current), the Anthropic SDK directly (future), or a different LLM that doesn't support native tool-calling. A model that can emit delimited text is the lowest common denominator; native `tool_use` is Anthropic-specific.

2. **The tutor prompt already does the work.** Module `promptFragment`s describe tools to the model; the model already knows the format. Switching to native `tool_use` would require translating each module's prompt into the SDK's tools schema — a real cost, with no behavioral benefit for v0.1 (no model is "off" in the Anthropic family).

3. **Stream-json's `tool_use` is incomplete in `claude -p`.** As of 2026-05, the CLI's `--include-partial-messages` emits text deltas but does NOT emit incremental `tool_use` deltas — they arrive only at turn boundaries. That removes the latency argument for native and gives us nothing the text protocol doesn't have.

4. **Defense in depth.** Disallowing every native tool via `--disallowed-tools` is a real security boundary independent of the protocol question. Migrating to native tool-calling would require selectively re-enabling tools, which widens the attack surface (per /angel F6).

## Why migrate later

1. **Native tool-calling is the Anthropic-supported path.** If `claude -p` changes its stream-json schema to assume native tools, the regex parser becomes brittle. (We have a guard now — `mapStreamEvent` logs loudly if `tool_use` ever arrives — so we'll notice. But noticing isn't fixing.)
2. **Tool-use as a first-class type** lets us add things the text protocol can't (per-tool input schemas, streaming tool results, parallel tool calls).
3. **The kidwind-appa port** will pressure-test how badly the v0.1 protocol fits an actual consumer. If `kidwind-appa` needs even one tool the text protocol can't model cleanly, that's the trigger.

## What we ship today

- `mapStreamEvent` in `src/core/spawn.ts` extracts `text` blocks and `stream_event` text deltas. It explicitly inspects `assistant` message content for `tool_use` / `tool_result` blocks and **logs a loud `console.error`** with the tool name when one arrives — that's the invariant alarm.
- `--disallowed-tools` covers every native tool (`Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`, `mcp__*`, `Todo*`) plus anything caller-supplied via `extraDisallowedTools` is additive only (F6).
- The `|||TOOL_CALL|||` regex lives in `src/core/tools.ts` with a JSDoc that names the protocol. `parseToolCalls` is unit-tested for fenced/unfenced blocks, malformed JSON, missing `tool` field, and multi-block messages.

## Falsifiers

- **The protocol breaks under model rotation.** A future Sonnet/Haiku version stops reliably emitting the delimiters and starts using native `tool_use` even with `--disallowed-tools` blocking the tool list. Concrete signal: `appa/spawn: unexpected tool_use content block` warnings appear in production logs more than a handful of times in any week. *Trigger:* immediate migration.
- **A consumer needs a tool whose contract the text protocol can't carry.** E.g. a tool with binary input/output, or with a multi-megabyte parameter set. Concrete signal: `kidwind-appa` (or any consumer) opens an issue asking for the SDK-tools shape. *Trigger:* migrate.
- **Latency complaints traced to round-trip overhead.** If model output streams character-by-character but tool dispatch waits for the full turn, a tool-heavy chat feels slow. We measure with `wrk` + counters; if median tool-call-latency under load exceeds ~2s for sub-100ms tools, the spawn-and-resume cycle is the suspect. *Trigger:* either migrate or buffer tool calls speculatively.

## Confidence

- **Claim:** Text protocol is the right v0.1 choice.
  - Confidence: 0.7 | Tier: ran-and-saw-output (kidwind Appa runs on this in production; 30 students × 9 months without a tool-dispatch failure)
  - Could-be-wrong-if: the migration path turns out to be cheaper than expected — i.e., a couple weekends of work would let us drop the regex parser entirely. We haven't sized the migration; that estimate alone could move confidence.

- **Claim:** The current `mapStreamEvent` invariant alarm catches drift.
  - Confidence: 0.85 | Tier: read-the-code (the code paths are short and tested for the happy case)
  - Could-be-wrong-if: a `tool_use` event arrives in a content shape `mapStreamEvent` doesn't recognize (e.g., nested inside a different top-level type). We'd silently miss it.

## Migration sketch (for whoever does it)

1. Convert each module's `promptFragment` into a tools schema (name, description, input JSON Schema). Most of the per-tool docs in `promptFragment`s already include enough detail for this.
2. Add a `tools` field to `SpawnOptions`; pass it through to `claude -p --tools-file=…` or via SDK options.
3. Teach `mapStreamEvent` to emit a `tool_use` SpawnEvent type; route it through `registry.invoke` instead of `parseToolCalls`.
4. Send tool results back via the SDK's `tool_result` content blocks (not the current "user message containing JSON" pattern).
5. Drop the regex parser. Keep the text protocol as a fallback for non-Anthropic models.

Estimated effort: 2-3 days of focused work, plus migration of the kidwind-appa tutor-prompt.md tool descriptions into machine-readable tool schemas (which is also a port-time task per ADR-01).
