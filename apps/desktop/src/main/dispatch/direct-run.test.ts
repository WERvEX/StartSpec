import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createKm0McpServer, insideWorktree } from "../../mcp/server";
import { DirectRun, type DirectTask, dependencyOrder } from "./direct-run";
import { readInbox } from "./inbox";

const FAKE_CLAUDE = [process.execPath, join(import.meta.dirname, "../../../../../e2e/fixtures/fake-claude.mjs")];
/** A test command that passes when every named file is in the worktree; quoted for sh and cmd alike. */
const has = (...files: string[]) =>
  `node -e "process.exit([${files.map((file) => `'${file}'`).join(",")}].every((f) => require('fs').existsSync(f)) ? 0 : 1)"`;

function gitRepo(): string {
  const path = mkdtempSync(join(tmpdir(), "km0-direct-repo-"));
  writeFileSync(join(path, "app.txt"), "hello\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: path });
  return path;
}

function packageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "km0-direct-pkg-"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks.json"), "[]\n");
  writeFileSync(join(dir, "tasks", "01.md"), "# Task 01\n");
  return dir;
}

const task = (seq: number, agent: string, dependsOn: number[], testCommand: string | null): DirectTask => ({
  seq,
  title: `Task ${seq}`,
  dependsOn,
  agent,
  model: "claude-sonnet-5-5",
  modelRef: "km0-1/claude-sonnet-5-5",
  tier: "T2",
  prompt: `Do task ${seq}.`,
  testCommand,
  acceptance: [`When task ${seq} is done, the file exists.`],
  env: {},
});

const runs: DirectRun[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.kill();
});

function start(repo: string, tasks: DirectTask[], overrides: Partial<ConstructorParameters<typeof DirectRun>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "km0-direct-runs-"));
  const runId = "20261101-120000";
  const lines: string[] = [];
  const run = new DirectRun({
    runId,
    runDir: join(root, runId),
    repo,
    projectId: 7,
    projectTitle: "Demo",
    packageDir: packageDir(),
    tasks,
    seqs: [],
    reuse: null,
    inboxDir: join(root, "dispatch"),
    claudeCommand: FAKE_CLAUDE,
    budget: null,
    language: "en",
    version: "1.1.0",
    onLine: (line) => lines.push(line),
    pollMs: 20,
    ...overrides,
  });
  runs.push(run);
  return { run, runDir: join(root, runId), inboxDir: join(root, "dispatch"), lines, runId };
}

async function desktop(inboxDir: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKm0McpServer(inboxDir).connect(serverSide);
  const client = new Client({ name: "scripted-claude-desktop", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
  };
  return { call, close: () => client.close() };
}

const progress = (runDir: string) =>
  readFileSync(join(runDir, "progress.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const report = (runDir: string, seq: string) =>
  JSON.parse(readFileSync(join(runDir, "reports", `${seq}.json`), "utf8")) as Record<string, unknown>;

describe("dependency order", () => {
  it("puts every task after the tasks it depends on", () => {
    const order = dependencyOrder([
      { seq: 1, dependsOn: [3] },
      { seq: 2, dependsOn: [] },
      { seq: 3, dependsOn: [2] },
    ]);
    expect(order.map((item) => item.seq)).toEqual([2, 3, 1]);
  });
});

describe("Claude Code and Claude Desktop finish a project together", () => {
  it("hands 01 to Claude Code, 02 to Claude Desktop over MCP and 03 to Claude Code, each on top of the last", async () => {
    const repo = gitRepo();
    const { run, runDir, inboxDir, runId } = start(repo, [
      task(1, "claude_code", [], has("claude-01.txt")),
      task(2, "claude_desktop", [1], has("claude-01.txt", "desktop-02.txt")),
      task(3, "claude_code", [2], has("claude-01.txt", "desktop-02.txt", "claude-03.txt")),
    ]);

    // Claude Desktop, scripted: wait for the task, look around, write a file, run the tests and report.
    const agent = await desktop(inboxDir);
    let taken = await agent.call("km0_next_task");
    for (let i = 0; !/Took task/.test(taken.text) && i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      taken = await agent.call("km0_next_task");
    }
    const ref = `${runId}/02`;
    expect(taken.text).toContain(`Took task ${ref}`);
    expect(taken.text).toContain("Do task 2.");
    expect(progress(runDir).some((event) => event.event === "task_waiting" && event.task_id === "02")).toBe(true);

    const files = await agent.call("km0_list_files", { task_ref: ref });
    expect(files.text.split("\n")).toEqual(expect.arrayContaining(["app.txt", "claude-01.txt", "km0/tasks/01.md"]));
    expect((await agent.call("km0_read_file", { task_ref: ref, path: "claude-01.txt" })).text).toMatch(/task 01/);
    expect((await agent.call("km0_run_tests", { task_ref: ref })).isError).toBe(true);
    await agent.call("km0_write_file", {
      task_ref: ref,
      path: "desktop-02.txt",
      content: "task 02 by Claude Desktop\n",
    });
    expect((await agent.call("km0_run_tests", { task_ref: ref })).text).toMatch(/exit code 0/);
    // Nothing outside the worktree, and not its .git.
    expect((await agent.call("km0_read_file", { task_ref: ref, path: "../../../etc/hosts" })).isError).toBe(true);
    expect((await agent.call("km0_write_file", { task_ref: ref, path: ".git/config", content: "x" })).isError).toBe(
      true,
    );
    await agent.call("km0_report", { task_ref: ref, status: "done", summary: "Added desktop-02.txt." });
    expect((await agent.call("km0_write_file", { task_ref: ref, path: "late.txt", content: "x" })).isError).toBe(true);

    expect(await run.exited).toEqual({ code: 0, signal: null });
    await agent.close();

    for (const seq of ["01", "02", "03"]) {
      expect(report(runDir, seq)).toMatchObject({
        report_version: 2,
        run_id: runId,
        project_id: 7,
        task_id: seq,
        branch: `km0/${runId}/${seq}`,
        test_result: { passed: true },
        failure_category: null,
      });
    }
    expect(report(runDir, "01")).toMatchObject({
      agent: "claude_code",
      cost: 0.0125,
      steps: 1,
      solved_tier: "T2",
      attempts: [expect.objectContaining({ agent: "claude_code", model: "km0-1/claude-sonnet-5-5", cost: 0.0125 })],
    });
    expect(report(runDir, "02")).toMatchObject({ agent: "claude_desktop", depends_on: ["01"] });
    // Each branch carries the work of the tasks before it; the user's checkout and km0/ are untouched.
    const show = (ref: string) =>
      execSync(`git show ${ref}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(show(`km0/${runId}/03:desktop-02.txt`)).toBe("task 02 by Claude Desktop\n");
    expect(show(`km0/${runId}/03:claude-01.txt`)).toMatch(/task 01/);
    expect(() => show(`km0/${runId}/03:km0/tasks.json`)).toThrow();
    expect(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })).toBe("");
    expect(execSync("git branch --show-current", { cwd: repo, encoding: "utf8" }).trim()).not.toContain("km0/");
    expect(readFileSync(join(runDir, "diffs", "02.diff"), "utf8")).toContain("+task 02 by Claude Desktop");
    expect(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"))).toMatchObject({ passed: 3, failed: 0 });
    expect(progress(runDir).at(-1)).toMatchObject({ event: "run_finished", status: "completed" });
    expect(existsSync(join(runDir, "worktrees", "02"))).toBe(false);
    expect(await readInbox(inboxDir)).toEqual([]);
  });

  it("blocks the tasks after a failed one, and gives Claude Code the model and budget", async () => {
    const repo = gitRepo();
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_FAIL = "01";
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    try {
      const { run, runDir } = start(repo, [task(1, "claude_code", [], null), task(2, "claude_code", [1], null)], {
        budget: 5,
      });
      expect((await run.exited).code).toBe(1);
      expect(report(runDir, "01")).toMatchObject({
        failure_category: "error",
        failure_detail: "The fake model gave up.",
      });
      expect(report(runDir, "02")).toMatchObject({ failure_category: "blocked", branch: null });
      const call = JSON.parse(readFileSync(argsFile, "utf8").split("\n")[0] as string) as { args: string[] };
      expect(call.args).toEqual(
        expect.arrayContaining([
          "-p",
          "--output-format",
          "stream-json",
          "--model",
          "claude-sonnet-5-5",
          "--max-budget-usd",
          "5.00",
        ]),
      );
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
      delete process.env.FAKE_CLAUDE_ARGS;
    }
  });

  it("stops: a task waiting for Claude Desktop and everything after it are cancelled", async () => {
    const repo = gitRepo();
    const { run, runDir, inboxDir } = start(repo, [
      task(1, "claude_desktop", [], null),
      task(2, "claude_code", [1], null),
    ]);
    for (let i = 0; (await readInbox(inboxDir)).length === 0 && i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await readInbox(inboxDir))[0]).toMatchObject({ state: "waiting", taskId: "01" });
    run.terminate();
    expect((await run.exited).code).toBe(3);
    expect(report(runDir, "01")).toMatchObject({ failure_category: "cancelled" });
    expect(report(runDir, "02")).toMatchObject({ failure_category: "cancelled" });
    expect(progress(runDir).at(-1)).toMatchObject({ event: "run_finished", status: "cancelled" });
    expect(await readInbox(inboxDir)).toEqual([]);
    expect(readdirSync(join(runDir, "worktrees"))).toEqual([]);
  });

  it("refuses an agent it cannot hand a task to", async () => {
    const { run, runDir } = start(gitRepo(), [task(1, "codex", [], null)]);
    expect((await run.exited).code).toBe(1);
    expect(report(runDir, "01")).toMatchObject({
      failure_detail: expect.stringMatching(/cannot hand a task to codex/),
    });
  });
});

describe("the MCP server's file tools stay in the worktree", () => {
  it("rejects paths outside it, .git, and links that lead out", async () => {
    const root = mkdtempSync(join(tmpdir(), "km0-worktree-"));
    const outside = mkdtempSync(join(tmpdir(), "km0-outside-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    if (process.platform !== "win32") symlinkSync(outside, join(root, "escape"));
    expect(await insideWorktree(root, "src/new/file.ts")).toBe(join(root, "src", "new", "file.ts"));
    expect(await insideWorktree(root, "../x")).toBeNull();
    expect(await insideWorktree(root, ".git/config")).toBeNull();
    if (process.platform !== "win32") expect(await insideWorktree(root, "escape/secret.txt")).toBeNull();
  });
});

// With KM0_CLAUDE_REAL=1, the real `claude` on PATH does one small task (it spends a little of the account's quota).
describe.skipIf(!process.env.KM0_CLAUDE_REAL)("the real Claude Code", () => {
  it("does a small task in its worktree and KM0 commits it", async () => {
    const repo = gitRepo();
    const job: DirectTask = {
      ...task(1, "claude_code", [], has("hello.txt")),
      model: process.env.KM0_CLAUDE_MODEL ?? "claude-haiku-5-5",
      prompt: "Create a file named hello.txt in the current folder containing the single line: hello from KM0",
    };
    const { run, runDir } = start(repo, [job], { claudeCommand: ["claude"] });
    expect((await run.exited).code).toBe(0);
    expect(report(runDir, "01")).toMatchObject({ test_result: { passed: true }, failure_category: null });
    expect(Number(report(runDir, "01").steps)).toBeGreaterThan(0);
  }, 300_000);
});
