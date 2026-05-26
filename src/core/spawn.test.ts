import { describe, expect, it } from "vitest";
import { DEFAULT_DISALLOWED_TOOLS, buildArgs, buildEnv } from "./spawn.js";

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
