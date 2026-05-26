// pattern: functional-core
// Parse |||TOOL_CALL|||...|||END_TOOL_CALL||| blocks emitted by the tutor.
// Imperative-shell concerns (executing the tool against module handlers) live in
// the module registry — this file is pure string parsing + allowlist gating.

import type { ToolCall } from "./types.js";

const BLOCK_RE = /\|\|\|TOOL_CALL\|\|\|\s*([\s\S]*?)\s*\|\|\|END_TOOL_CALL\|\|\|/g;

export interface ParsedBlock {
  call: ToolCall | null;
  raw: string;
  parseError?: string;
}

/** Find every TOOL_CALL block in `text` and return them in order. Tolerant of markdown fences inside the block. */
export function parseToolCalls(text: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const match of text.matchAll(BLOCK_RE)) {
    const raw = match[1] ?? "";
    const body = stripFences(raw).trim();
    if (!body) {
      out.push({ call: null, raw, parseError: "empty tool call block" });
      continue;
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      const call = coerceCall(parsed);
      if (!call) {
        out.push({ call: null, raw, parseError: "missing tool field" });
        continue;
      }
      out.push({ call, raw });
    } catch (err) {
      out.push({
        call: null,
        raw,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Remove all TOOL_CALL blocks from text, leaving any surrounding prose intact. */
export function stripToolBlocks(text: string): string {
  return text.replace(BLOCK_RE, "");
}

/** Returns true if `name` is in `allowlist`. Centralized so spawn/route layers stay symmetric. */
export function isAllowed(name: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(name);
}

function stripFences(body: string): string {
  // Tolerate the model wrapping JSON in ```...``` despite the prompt asking it not to.
  const fenced = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1] ?? body;
  return body;
}

function coerceCall(value: unknown): ToolCall | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.tool !== "string") return null;
  const params =
    typeof obj.params === "object" && obj.params !== null && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};
  return { tool: obj.tool, params };
}
