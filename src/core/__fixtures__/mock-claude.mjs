#!/usr/bin/env node
// Stand-in for the `claude` CLI used by spawnClaude tests. Ignores
// most of the CLI args (claude-cli's real flags don't matter here);
// behavior is driven by MOCK_CLAUDE_SCENARIO env var. Reads stdin
// to completion so the upstream `child.stdin.end()` doesn't hang.

import { setTimeout as wait } from "node:timers/promises";

const scenario = process.env.MOCK_CLAUDE_SCENARIO ?? "stream_text";

// Drain stdin so the caller's child.stdin.write/end resolves cleanly.
process.stdin.resume();
const drain = new Promise((resolve) => {
  process.stdin.on("end", resolve);
});

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  // Don't await drain unless we actually need stdin contents — the
  // important thing is keeping stdin open until we've emitted output.
  switch (scenario) {
    case "stream_text": {
      // Two incremental deltas, then a complete assistant message.
      emit({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      });
      emit({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      });
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      });
      emit({ type: "result", result: "ok" });
      break;
    }
    case "non_json_line": {
      // A line that isn't JSON — should be surfaced as a text event.
      process.stdout.write("not even json\n");
      emit({ type: "assistant", message: { content: [{ type: "text", text: "and then valid" }] } });
      break;
    }
    case "tool_use_warning": {
      // assistant message with a tool_use content block — spawnClaude
      // should log loudly and NOT emit it as a text event.
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", id: "tool_1", input: {} },
            { type: "text", text: "shadow text" },
          ],
        },
      });
      break;
    }
    case "exit_fail": {
      process.stderr.write("simulated claude error\n");
      process.exit(2);
      return;
    }
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: the loop runs forever; abort kills us
    case "abort_loop": {
      // Heartbeat forever — for the abort test. The loop never exits; the
      // parent process kills us via AbortSignal.
      // biome-ignore lint/correctness/noConstantCondition: intentional
      while (true) {
        emit({ type: "assistant", message: { content: [{ type: "text", text: "tick" }] } });
        await wait(50);
      }
    }
    default:
      process.exit(99);
  }
  // Hold stdin open briefly to mirror the real CLI's behavior of
  // accepting the prompt before terminating.
  await Promise.race([drain, wait(100)]);
}

main().catch((err) => {
  process.stderr.write(`mock-claude crashed: ${err}\n`);
  process.exit(1);
});
