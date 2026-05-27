import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../core/config.js";
import tasksModule from "../modules/tasks/index.js";
import { devAuth } from "./auth.js";
import { type AppHandle, buildApp } from "./index.js";

const MOCK_CLAUDE = fileURLToPath(new URL("../core/__fixtures__/mock-claude.mjs", import.meta.url));

interface Booted {
  handle: AppHandle;
  url: string;
  close: () => Promise<void>;
}

async function bootTestServer(opts: {
  dir: string;
  scenario?: string;
  hourlyLimit?: number;
  maxToolRounds?: number;
  /** Omit resolveCaller to test the deny-by-default path. */
  withAuth?: boolean;
}): Promise<Booted> {
  // Required project files
  await writeFile(
    join(opts.dir, "team.json"),
    JSON.stringify({
      members: [
        { id: "alice", name: "Alice", role: "member" },
        { id: "bob", name: "Bob", role: "member" },
        { id: "karl", name: "Karl", role: "coach" },
      ],
    }),
  );
  await writeFile(join(opts.dir, "tutor-prompt.md"), "# Test tutor\nSay hi.\n");

  const config = resolveConfig({
    projectDir: opts.dir,
    modules: [tasksModule],
    claudeBinary: MOCK_CLAUDE,
    extraSpawnEnv: { MOCK_CLAUDE_SCENARIO: opts.scenario ?? "stream_text" },
    hourlyLimit: opts.hourlyLimit ?? 100,
    maxToolRounds: opts.maxToolRounds ?? 3,
    resolveCaller: opts.withAuth === false ? undefined : devAuth(),
  });

  const handle = await buildApp(config);
  const server = handle.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    handle,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readSse(res: Response): Promise<{ events: Array<{ type: string; data: unknown }> }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string; data: unknown }> = [];
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      events.push({
        type: eventLine.slice(6).trim(),
        data: JSON.parse(dataLine.slice(5).trim()),
      });
    }
  }
  return { events };
}

describe("handleChat integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appa-chat-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects with 403 when no resolveCaller is configured", async () => {
    const boot = await bootTestServer({ dir, withAuth: false });
    const res = await fetch(`${boot.url}/api/chat/threads/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no resolveCaller/);
    await boot.close();
  });

  it("returns 400 on empty message (before SSE headers flush)", async () => {
    const boot = await bootTestServer({ dir });
    const res = await fetch(`${boot.url}/api/chat/threads/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "alice" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).not.toMatch(/text\/event-stream/);
    await boot.close();
  });

  it("returns 403 when caller cannot be resolved (unknown asUserId)", async () => {
    const boot = await bootTestServer({ dir });
    const res = await fetch(`${boot.url}/api/chat/threads/ghost`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "ghost" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
    await boot.close();
  });

  it("returns 403 when a student posts to another student's thread", async () => {
    const boot = await bootTestServer({ dir });
    const res = await fetch(`${boot.url}/api/chat/threads/bob`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "alice" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
    await boot.close();
  });

  it("streams text events on the happy path", async () => {
    const boot = await bootTestServer({ dir });
    const res = await fetch(`${boot.url}/api/chat/threads/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "alice" },
      body: JSON.stringify({ message: "hi there" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const { events } = await readSse(res);
    const texts = events
      .filter((e) => e.type === "text")
      .map((e) => (e.data as { text: string }).text);
    expect(texts.join("")).toContain("Hello world");
    expect(events.at(-1)?.type).toBe("done");
    await boot.close();
  });

  it("emits SSE error event when rate-limit is exhausted (per caller)", async () => {
    // hourlyLimit:1 — first call OK, second exhausts.
    const boot = await bootTestServer({ dir, hourlyLimit: 1 });
    const ok = await fetch(`${boot.url}/api/chat/threads/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "alice" },
      body: JSON.stringify({ message: "first" }),
    });
    await readSse(ok); // drain so the spawn finishes before the next call
    const blocked = await fetch(`${boot.url}/api/chat/threads/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "alice" },
      body: JSON.stringify({ message: "second" }),
    });
    expect(blocked.status).toBe(200);
    const { events } = await readSse(blocked);
    expect(events[0]?.type).toBe("error");
    expect((events[0]?.data as { error: string }).error).toMatch(/limit/i);
    await boot.close();
  }, 10_000);

  it("a coach can post to a non-self thread id", async () => {
    const boot = await bootTestServer({ dir });
    const res = await fetch(`${boot.url}/api/chat/threads/office-hours-alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appa-User": "karl" },
      body: JSON.stringify({ message: "hi alice" }),
    });
    expect(res.status).toBe(200);
    const { events } = await readSse(res);
    expect(events.at(-1)?.type).toBe("done");
    await boot.close();
  });
});
