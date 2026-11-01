#!/usr/bin/env node
// A stand-in for Claude Code's `claude -p --output-format stream-json`, for KM0's tests: no model, no network.
// It reads the prompt on stdin, finds the task's number in the branch KM0 names (`km0/<run>/<NN>`), writes
// `claude-<NN>.txt` in the working folder and prints the events Claude Code prints, ending with `result`.
//   FAKE_CLAUDE_FAIL=<NN>     that task ends with an error result
//   FAKE_CLAUDE_DELAY_MS=<n>  wait this long before finishing (to test stopping)
//   FAKE_CLAUDE_ARGS=<file>   append the arguments it was given, one JSON line per run
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const seq = prompt.match(/km0\/[\w.-]+\/(\d+)/)?.[1] ?? "00";
const model = args[args.indexOf("--model") + 1] ?? "default";
if (process.env.FAKE_CLAUDE_ARGS) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGS, `${JSON.stringify({ seq, args, cwd: process.cwd() })}\n`);
}
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: "system", subtype: "init", session_id: `fake-${seq}`, model, cwd: process.cwd(), tools: ["Write"] });

const file = `claude-${seq}.txt`;
say({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(process.cwd(), file) } }],
  },
});
writeFileSync(join(process.cwd(), file), `task ${seq} by fake Claude Code (${model})\n`);
say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
say({ type: "assistant", message: { content: [{ type: "text", text: `Wrote ${file}.` }] } });

const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

const failed = process.env.FAKE_CLAUDE_FAIL === seq;
say({
  type: "result",
  subtype: failed ? "error_during_execution" : "success",
  is_error: failed,
  total_cost_usd: 0.0125,
  num_turns: 2,
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
  result: failed ? "The fake model gave up." : `Wrote ${file}.`,
});
process.exitCode = failed ? 1 : 0;
