import { describe, expect, it } from "vitest";
import { isAllowed, parseToolCalls, stripToolBlocks } from "./tools.js";

describe("parseToolCalls", () => {
  it("parses a single well-formed block", () => {
    const text = '|||TOOL_CALL|||\n{"tool": "get_tasks", "params": {}}\n|||END_TOOL_CALL|||';
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call).toEqual({ tool: "get_tasks", params: {} });
  });

  it("parses multiple blocks in order", () => {
    const text = [
      "let me check",
      '|||TOOL_CALL|||\n{"tool":"get_tasks","params":{}}\n|||END_TOOL_CALL|||',
      "and the journal",
      '|||TOOL_CALL|||\n{"tool":"get_journal","params":{}}\n|||END_TOOL_CALL|||',
    ].join("\n");
    const calls = parseToolCalls(text).map((c) => c.call?.tool);
    expect(calls).toEqual(["get_tasks", "get_journal"]);
  });

  it("defaults params to {} when omitted", () => {
    const text = '|||TOOL_CALL|||\n{"tool": "get_tasks"}\n|||END_TOOL_CALL|||';
    expect(parseToolCalls(text)[0]?.call?.params).toEqual({});
  });

  it("strips a ```json fence if the model adds one", () => {
    const text =
      '|||TOOL_CALL|||\n```json\n{"tool":"get_tasks","params":{}}\n```\n|||END_TOOL_CALL|||';
    expect(parseToolCalls(text)[0]?.call?.tool).toBe("get_tasks");
  });

  it("reports a parse error for invalid JSON", () => {
    const text = "|||TOOL_CALL|||\n{not json}\n|||END_TOOL_CALL|||";
    const result = parseToolCalls(text)[0];
    expect(result?.call).toBeNull();
    expect(result?.parseError).toBeTruthy();
  });

  it("rejects a block with no tool name", () => {
    const text = '|||TOOL_CALL|||\n{"params":{}}\n|||END_TOOL_CALL|||';
    const result = parseToolCalls(text)[0];
    expect(result?.call).toBeNull();
    expect(result?.parseError).toMatch(/missing tool/);
  });

  it("returns [] when there are no blocks", () => {
    expect(parseToolCalls("just some prose")).toEqual([]);
  });
});

describe("stripToolBlocks", () => {
  it("removes blocks but keeps surrounding text", () => {
    const text = "before|||TOOL_CALL|||\n{}|||END_TOOL_CALL|||after";
    expect(stripToolBlocks(text)).toBe("beforeafter");
  });
});

describe("isAllowed", () => {
  it("returns true for allowlisted names", () => {
    const allow = new Set(["get_tasks"]);
    expect(isAllowed("get_tasks", allow)).toBe(true);
    expect(isAllowed("rm_rf_world", allow)).toBe(false);
  });
});
