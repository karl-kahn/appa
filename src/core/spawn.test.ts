import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DISALLOWED_TOOLS, buildArgs, buildEnv, spawnClaude } from "./spawn.js";
import type { SpawnEvent } from "./types.js";

const MOCK_CLAUDE = fileURLToPath(new URL("./__fixtures__/mock-claude.mjs", import.meta.url));

describe("buildArgs", () => {
  it("includes --session-id on first call", () => {
    const args = buildArgs({
      message: "hi",
      claudeSessionId: "abc-123",
    });
    expect(args).toContain("--session-id");
    expect(args).toContain("abc-123");
    expect(args).not.toContain("--resume");
  });

  it("includes --resume on subsequent calls", () => {
    const args = buildArgs({
      message: "hi",
      claudeSessionId: "abc-123",
      resume: true,
    });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  it("requests stream-json + verbose + partial-messages + project settings", () => {
    const args = buildArgs({ message: "hi", claudeSessionId: "x" });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--setting-sources");
    expect(args).toContain("project");
  });

  it("disallows the default tool set", () => {
    const args = buildArgs({ message: "hi", claudeSessionId: "x" });
    for (const tool of DEFAULT_DISALLOWED_TOOLS) {
      expect(args).toContain(tool);
    }
  });

  it("extraDisallowedTools adds to defaults; cannot remove a default", () => {
    const args = buildArgs({
      message: "hi",
      claudeSessionId: "x",
      extraDisallowedTools: ["CustomTool(*)"],
    });
    expect(args).toContain("CustomTool(*)");
    for (const tool of DEFAULT_DISALLOWED_TOOLS) {
      expect(args).toContain(tool);
    }
  });

  it("empty extra list does not remove default bans", () => {
    const args = buildArgs({
      message: "hi",
      claudeSessionId: "x",
      extraDisallowedTools: [],
    });
    for (const tool of DEFAULT_DISALLOWED_TOOLS) {
      expect(args).toContain(tool);
    }
  });

  it("appends a system prompt fragment when provided", () => {
    const args = buildArgs({
      message: "hi",
      claudeSessionId: "x",
      systemPromptAppend: "You are a turbine tutor.",
    });
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are a turbine tutor.");
  });

  it("uses the requested model", () => {
    const args = buildArgs({ message: "hi", claudeSessionId: "x", model: "haiku" });
    expect(args).toContain("haiku");
  });
});

describe("spawnClaude (integration via mock CLI)", () => {
  async function collect(scenario: string, signal?: AbortSignal): Promise<SpawnEvent[]> {
    const out: SpawnEvent[] = [];
    const opts: Parameters<typeof spawnClaude>[0] = {
      message: "hi",
      claudeSessionId: "00000000-0000-0000-0000-000000000000",
      claudeBinary: MOCK_CLAUDE,
      extraEnv: { MOCK_CLAUDE_SCENARIO: scenario },
    };
    if (signal) opts.signal = signal;
    for await (const ev of spawnClaude(opts)) {
      out.push(ev);
    }
    return out;
  }

  it("emits text events from stream_event deltas + a final done", async () => {
    const events = await collect("stream_text");
    const texts = events.filter((e) => e.type === "text").map((e) => e.text);
    // Two deltas + one full assistant message → at least the two delta texts.
    expect(texts.join("")).toContain("Hello world");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("surfaces a non-JSON stdout line as a text event (graceful degradation)", async () => {
    const events = await collect("non_json_line");
    const texts = events.filter((e) => e.type === "text").map((e) => e.text ?? "");
    expect(texts.some((t) => t.includes("not even json"))).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("logs loudly + drops tool_use blocks; does NOT emit them as text", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = await collect("tool_use_warning");
    // The text content alongside the tool_use should still come through.
    const texts = events.filter((e) => e.type === "text").map((e) => e.text ?? "");
    expect(texts.join(" ")).toContain("shadow text");
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("unexpected tool_use");
    errSpy.mockRestore();
  });

  it("yields an error event when the subprocess exits non-zero", async () => {
    const events = await collect("exit_fail");
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.error ?? "").toMatch(/exited with code 2/);
  });

  it("honors AbortSignal: aborting mid-stream produces an error event and terminates", async () => {
    const ac = new AbortController();
    const collected: SpawnEvent[] = [];
    const stream = spawnClaude({
      message: "hi",
      claudeSessionId: "00000000-0000-0000-0000-000000000000",
      claudeBinary: MOCK_CLAUDE,
      signal: ac.signal,
      extraEnv: { MOCK_CLAUDE_SCENARIO: "abort_loop" },
    });
    // Let a couple of heartbeats arrive, then abort.
    let i = 0;
    for await (const ev of stream) {
      collected.push(ev);
      if (++i >= 2) ac.abort();
      if (ev.type === "error" || ev.type === "done") break;
    }
    expect(collected.some((e) => e.type === "text")).toBe(true);
    expect(collected.at(-1)?.type).toBe("error");
  }, 5000);
});

describe("buildEnv", () => {
  it("whitelists exactly the expected vars", () => {
    const parent = {
      HOME: "/home/karl",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      AWS_SECRET_KEY: "should-not-leak",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    const env = buildEnv(parent);
    expect(env.HOME).toBe("/home/karl");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.AWS_SECRET_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});
