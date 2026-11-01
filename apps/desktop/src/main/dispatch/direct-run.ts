import { exec } from "node:child_process";
import { appendFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunningProcess } from "../services/exec-port";
import { type AgentOutcome, type AgentRun, runClaudeCode } from "./claude-code";
import { AUTHOR, EXCLUDES, GitError, git, gitDiff } from "./git";
import { findTask, type InboxTask, putTask, readInbox, removeTask, updateTask } from "./inbox";

/**
 * KM0's direct executor: each task goes straight to the agent the plan routed it to, in dependency order. Every
 * task gets a git worktree on its own branch (`km0/<run_id>/<NN>`), started from its upstream tasks' branches;
 * the agent works there, KM0 commits what it left, runs the task's test command and writes a report. The run
 * directory holds the same files KM0 Runner writes (progress.jsonl, reports/, diffs/, summary.json), so KM0
 * follows, stops, imports and judges a direct run exactly as it does a Runner run. KM0 never switches models
 * here: that is the plan's job, and a task that does not pass is redone from the routing table.
 */

export interface DirectTask {
  seq: number;
  title: string;
  dependsOn: number[];
  agent: string;
  /** The model ID as the agent takes it, such as `claude-sonnet-5-5`. */
  model: string | null;
  /** The model as reports name it, `km0-<providerId>/<modelId>`, which KM0 matches back on import. */
  modelRef: string | null;
  tier: string | null;
  /** The task file from the hand-off package. */
  prompt: string;
  testCommand: string | null;
  acceptance: string[];
  /** Added to the agent's environment. */
  env: Record<string, string>;
  features?: unknown;
  score?: unknown;
}

export interface DirectRunOptions {
  runId: string;
  runDir: string;
  repo: string;
  projectId: number;
  projectTitle: string;
  /** The hand-off package, copied into each worktree's `km0/` when the repository does not track one. */
  packageDir: string;
  tasks: DirectTask[];
  /** Run only these tasks; the others come from `reuse`'s branches, or the repository as it is. */
  seqs: number[];
  reuse: string | null;
  inboxDir: string;
  claudeCommand: string[] | null;
  /** The project budget; the remainder caps each Claude Code run. */
  budget: number | null;
  language: "zh-CN" | "en";
  version: string;
  onLine: (line: string) => void;
  /** How often to look for a Claude Desktop report; tests make it short. */
  pollMs?: number;
}

type Status = "passed" | "unjudged" | "failed" | "blocked" | "cancelled";
type Category = "tests_failed" | "budget_exhausted" | "blocked" | "error" | "cancelled" | "gave_up";

const EXIT_CANCELLED = 3;
const TEST_TIMEOUT_MS = 15 * 60_000;

const TEXT = {
  "zh-CN": {
    claudeNote: (branch: string) =>
      `你在一个独立的 git worktree 里工作，分支是 \`${branch}\`。按下面的任务完成改动；任务有测试命令时，完成后运行它。不要切换分支，也不要推送。改动可以自己提交；没有提交的改动，KM0 会在你结束后提交到这个分支。项目背景和文档在 \`km0/\` 文件夹里。`,
    upstreamFailed: (seq: string) => `依赖的任务 ${seq} 没有完成。`,
    conflict: (detail: string) => `合并上游任务的分支时有冲突：${detail}`,
    noAgent: (agent: string) => `直接执行还不能把任务交给 ${agent}。`,
    noClaude: "没有找到 Claude Code。",
    gaveUp: (summary: string) => `Agent 放弃了这个任务：${summary}`,
    testsFailed: "测试没有通过。",
    noRepoCommit: "仓库还没有任何提交：先提交一次，再执行。",
    waiting: (title: string) => `等待 Claude Desktop 领取：${title}`,
    claimed: (title: string) => `Claude Desktop 已领取：${title}`,
  },
  en: {
    claudeNote: (branch: string) =>
      `You work in a git worktree of your own, on branch \`${branch}\`. Make the change the task below asks for; when the task has a test command, run it at the end. Do not switch branches or push. You may commit; whatever you leave uncommitted, KM0 commits to this branch when you finish. The project's background and documents are in the \`km0/\` folder.`,
    upstreamFailed: (seq: string) => `Upstream task ${seq} did not finish.`,
    conflict: (detail: string) => `The upstream tasks' branches conflict: ${detail}`,
    noAgent: (agent: string) => `The direct executor cannot hand a task to ${agent} yet.`,
    noClaude: "Claude Code was not found.",
    gaveUp: (summary: string) => `The agent gave the task up: ${summary}`,
    testsFailed: "The tests do not pass.",
    noRepoCommit: "The repository has no commit yet: commit once, then run.",
    waiting: (title: string) => `Waiting for Claude Desktop to take: ${title}`,
    claimed: (title: string) => `Claude Desktop took: ${title}`,
  },
} as const;

const pad = (seq: number) => String(seq).padStart(2, "0");
const nowIso = () => new Date().toISOString();

/** Tasks in an order where every task comes after the tasks it depends on; ties by seq. */
export function dependencyOrder<T extends { seq: number; dependsOn: number[] }>(tasks: T[]): T[] {
  const bySeq = new Map(tasks.map((task) => [task.seq, task]));
  const done = new Set<number>();
  const order: T[] = [];
  const visit = (task: T, path: Set<number>) => {
    if (done.has(task.seq) || path.has(task.seq)) return;
    path.add(task.seq);
    for (const dep of [...task.dependsOn].sort((a, b) => a - b)) {
      const upstream = bySeq.get(dep);
      if (upstream) visit(upstream, path);
    }
    done.add(task.seq);
    order.push(task);
  };
  for (const task of [...tasks].sort((a, b) => a.seq - b.seq)) visit(task, new Set());
  return order;
}

/** Run a shell command in `cwd` to its end, with a time limit; its exit code and the tail of its output. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.slice(-4000);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output });
      },
    );
  });
}

export class DirectRun implements RunningProcess {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private cancelled = false;
  private current: AgentRun | null = null;
  private seqNo = 0;
  private spent = 0;
  private writes = Promise.resolve();
  private readonly text;
  private readonly pollMs;

  constructor(private readonly options: DirectRunOptions) {
    this.text = TEXT[options.language];
    this.pollMs = options.pollMs ?? 1000;
    this.exited = this.main().then(
      (code) => ({ code, signal: null }),
      (error: unknown) => {
        this.options.onLine(error instanceof Error ? error.message : String(error));
        return { code: 2, signal: null };
      },
    );
  }

  terminate(): void {
    this.cancelled = true;
    this.current?.stop();
    void this.cancelInbox();
  }

  kill(): void {
    this.terminate();
  }

  private async cancelInbox(): Promise<void> {
    for (const task of await readInbox(this.options.inboxDir)) {
      if (task.runId !== this.options.runId || task.state === "done" || task.state === "cancelled") continue;
      await updateTask(this.options.inboxDir, task.ref, (item) =>
        item.state === "waiting" || item.state === "claimed" ? { ...item, state: "cancelled" } : null,
      ).catch(() => null);
    }
  }

  private emit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    this.seqNo += 1;
    const line = `${JSON.stringify({ seq: this.seqNo, at: nowIso(), event, ...fields })}\n`;
    const file = join(this.options.runDir, "progress.jsonl");
    this.writes = this.writes.then(() => appendFile(file, line, "utf8"));
    return this.writes;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const file = join(this.options.runDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async main(): Promise<number> {
    const { options } = this;
    await mkdir(options.runDir, { recursive: true });
    const startCommit = await git(options.repo, ["rev-parse", "--verify", "HEAD"], false);
    if (!startCommit) throw new GitError(this.text.noRepoCommit);
    const selected =
      options.seqs.length > 0 ? options.tasks.filter((task) => options.seqs.includes(task.seq)) : options.tasks;
    const order = dependencyOrder(selected);
    await this.writeJson("run.json", {
      run_id: options.runId,
      executor: "km0-direct",
      km0_version: options.version,
      repo: options.repo,
      start_commit: startCommit,
      started_at: nowIso(),
      reuse: options.reuse,
    });
    await this.emit("run_started", {
      run_id: options.runId,
      tasks: order.map((task) => ({ task_id: pad(task.seq), title: task.title })),
    });

    const results = new Map<number, Status>();
    const branches = new Map<number, string>();
    // Upstream tasks this run does not redo: the branch an earlier run left them on.
    if (options.reuse) {
      for (const task of options.tasks) {
        if (selected.includes(task)) continue;
        const branch = `km0/${options.reuse}/${pad(task.seq)}`;
        if (await git(options.repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], false)) {
          branches.set(task.seq, branch);
        }
      }
    }
    for (const task of order) {
      const status = await this.runTask(task, startCommit, results, branches, selected);
      results.set(task.seq, status);
    }

    const counts = { passed: 0, unjudged: 0, failed: 0, blocked: 0, cancelled: 0 };
    for (const status of results.values()) counts[status] += 1;
    await this.writeJson("summary.json", {
      run_id: options.runId,
      executor: "km0-direct",
      tasks: results.size,
      ...counts,
      cost: this.spent,
    });
    await this.emit("run_finished", { status: this.cancelled ? "cancelled" : "completed", cost: this.spent });
    await this.writes;
    if (this.cancelled) return EXIT_CANCELLED;
    return counts.failed + counts.blocked > 0 ? 1 : 0;
  }

  private async runTask(
    task: DirectTask,
    startCommit: string,
    results: Map<number, Status>,
    branches: Map<number, string>,
    selected: DirectTask[],
  ): Promise<Status> {
    const { options, text } = this;
    const taskId = pad(task.seq);
    const branch = `km0/${options.runId}/${taskId}`;
    const report = {
      report_version: 2,
      run_id: options.runId,
      project_id: options.projectId,
      task_id: taskId,
      source: "km0",
      title: task.title,
      predicted_tier: task.tier,
      predicted_features: task.features ?? null,
      predicted_score: task.score ?? null,
      start_tier: null as string | null,
      explored: false,
      solved_tier: null as string | null,
      escalations: [],
      cost: 0,
      steps: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      wall_time: 0,
      test_command: task.testCommand,
      test_result: null as { passed: boolean | null; judge: string; detail: string } | null,
      failure_category: null as Category | null,
      failure_detail: "",
      handoff: "fresh",
      agent: task.agent,
      branch: null as string | null,
      base_commit: null as string | null,
      commit: null as string | null,
      diff: null as string | null,
      depends_on: task.dependsOn.map(pad),
      acceptance: task.acceptance,
      config_hash: "direct",
      runner_version: `km0-${options.version}`,
      attempts: [] as unknown[],
    };
    const finish = async (status: Status, category: Category | null, detail: string) => {
      report.failure_category = category;
      report.failure_detail = detail;
      await this.writeJson(`reports/${taskId}.json`, report);
      await this.emit("task_finished", { task_id: taskId, status, failure_detail: detail, cost: report.cost });
      return status;
    };

    if (this.cancelled) return finish("cancelled", "cancelled", "");
    // Upstream tasks: in this run they must have finished; outside it, their branch from `reuse` if there is one.
    const upstream: string[] = [];
    for (const dep of [...task.dependsOn].sort((a, b) => a - b)) {
      const inRun = selected.some((item) => item.seq === dep);
      const result = results.get(dep);
      if (inRun && result !== "passed" && result !== "unjudged")
        return finish("blocked", "blocked", text.upstreamFailed(pad(dep)));
      const upstreamBranch = branches.get(dep);
      if (upstreamBranch) upstream.push(upstreamBranch);
    }

    const worktree = join(options.runDir, "worktrees", taskId);
    try {
      await git(options.repo, ["worktree", "add", "-q", "-b", branch, worktree, upstream[0] ?? startCommit]);
    } catch (error) {
      return finish("blocked", "error", (error as Error).message);
    }
    for (const other of upstream.slice(1)) {
      try {
        await git(worktree, [...AUTHOR, "merge", "-q", "--no-edit", other]);
      } catch {
        const files = await git(worktree, ["diff", "--name-only", "--diff-filter=U"], false);
        await git(worktree, ["merge", "--abort"], false);
        await this.discard(worktree, branch);
        return finish("blocked", "blocked", text.conflict(`${other}: ${files.split("\n").join(", ") || "?"}`));
      }
    }
    if (!(await stat(join(worktree, "km0", "tasks.json")).catch(() => null))) {
      await cp(options.packageDir, join(worktree, "km0"), { recursive: true }).catch(() => undefined);
    }
    const baseCommit = await git(worktree, ["rev-parse", "HEAD"]);
    Object.assign(report, { branch, base_commit: baseCommit, start_tier: task.tier });
    await this.emit("task_started", { task_id: taskId, tier: task.tier, agent: task.agent });
    await this.emit("attempt_started", {
      task_id: taskId,
      tier: task.tier,
      model: task.model,
      agent: task.agent,
      purpose: "task",
    });

    const started = Date.now();
    const outcome = await this.handTo(task, worktree, branch);
    const wallTime = (Date.now() - started) / 1000;
    this.spent += outcome.cost;
    Object.assign(report, { cost: outcome.cost, steps: outcome.steps, tokens: outcome.tokens, wall_time: wallTime });
    await this.emit("attempt_finished", {
      task_id: taskId,
      tier: task.tier,
      model: task.model,
      agent: task.agent,
      cost: outcome.cost,
      steps: outcome.steps,
      stop_reason: outcome.stopReason,
    });

    // Whatever the agent left uncommitted goes onto the task's branch, outside km0/.
    await git(worktree, ["add", "-A", "--", ".", ...EXCLUDES], false);
    if (await git(worktree, ["diff", "--cached", "--name-only"], false)) {
      await git(worktree, [...AUTHOR, "commit", "-q", "--no-verify", "-m", `km0: ${taskId} ${task.title}`], false);
    }
    const head = await git(worktree, ["rev-parse", "HEAD"]);
    if (head !== baseCommit) {
      report.commit = head;
      report.diff = `diffs/${taskId}.diff`;
      const diffFile = join(options.runDir, "diffs", `${taskId}.diff`);
      await mkdir(dirname(diffFile), { recursive: true });
      await writeFile(diffFile, await gitDiff(worktree, baseCommit, head), "utf8");
    }
    branches.set(task.seq, branch);

    let testResult: { passed: boolean | null; judge: string; detail: string } | null = null;
    if (task.testCommand && outcome.stopReason !== "cancelled" && !this.cancelled) {
      const run = await runShell(task.testCommand, worktree);
      testResult = { passed: run.code === 0, judge: "test_command", detail: run.output };
      report.test_result = testResult;
      await this.emit("test_result", { task_id: taskId, passed: testResult.passed, detail: run.output.slice(-500) });
    }
    report.attempts = [
      {
        purpose: "task",
        tier: task.tier ?? "T1",
        model: task.modelRef ?? task.model ?? task.agent,
        agent: task.agent,
        steps: outcome.steps,
        tokens: outcome.tokens,
        cost: outcome.cost,
        wall_time: wallTime,
        stop_reason: outcome.stopReason,
        test_result: testResult,
        events: task.agent === "claude_code" ? `events/${taskId}.jsonl` : null,
      },
    ];
    await this.removeWorktree(worktree);

    if (outcome.stopReason === "cancelled" || this.cancelled) return finish("cancelled", "cancelled", "");
    if (outcome.stopReason === "error") return finish("failed", "error", outcome.detail);
    if (outcome.stopReason === "cost_budget") return finish("failed", "budget_exhausted", outcome.detail);
    if (outcome.gaveUp) return finish("failed", "gave_up", text.gaveUp(outcome.detail));
    if (testResult?.passed === false) return finish("failed", "tests_failed", text.testsFailed);
    if (testResult?.passed) report.solved_tier = task.tier;
    return finish(testResult?.passed ? "passed" : "unjudged", null, "");
  }

  /** Give the task to its agent and wait for it to finish. */
  private async handTo(
    task: DirectTask,
    worktree: string,
    branch: string,
  ): Promise<AgentOutcome & { gaveUp?: boolean }> {
    const { options, text } = this;
    const failed = (detail: string): AgentOutcome => ({
      stopReason: "error",
      steps: 0,
      cost: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      detail,
    });
    if (task.agent === "claude_code") {
      if (!options.claudeCommand) return failed(text.noClaude);
      const left = options.budget !== null ? Math.max(options.budget - this.spent, 0.01) : null;
      const eventsFile = join(options.runDir, "events", `${pad(task.seq)}.jsonl`);
      await mkdir(dirname(eventsFile), { recursive: true });
      this.current = runClaudeCode({
        command: options.claudeCommand,
        cwd: worktree,
        prompt: `${text.claudeNote(branch)}\n\n---\n\n${task.prompt}`,
        model: task.model,
        env: task.env,
        maxBudgetUsd: left,
        eventsFile,
        onLine: options.onLine,
      });
      const outcome = await this.current.outcome;
      this.current = null;
      return outcome;
    }
    if (task.agent === "claude_desktop") return this.waitForDesktop(task, worktree, branch);
    return failed(text.noAgent(task.agent));
  }

  /** Put the task in the inbox for Claude Desktop and wait until it reports, or the run is cancelled. */
  private async waitForDesktop(
    task: DirectTask,
    worktree: string,
    branch: string,
  ): Promise<AgentOutcome & { gaveUp?: boolean }> {
    const { options, text } = this;
    const ref = `${options.runId}/${pad(task.seq)}`;
    const entry: InboxTask = {
      version: 1,
      ref,
      runId: options.runId,
      taskId: pad(task.seq),
      seq: task.seq,
      title: task.title,
      projectTitle: options.projectTitle,
      agent: task.agent,
      model: task.model,
      worktree,
      branch,
      prompt: task.prompt,
      testCommand: task.testCommand,
      acceptance: task.acceptance,
      language: options.language,
      state: "waiting",
      createdAt: nowIso(),
      claimedAt: null,
      report: null,
    };
    await putTask(options.inboxDir, entry);
    await this.emit("task_waiting", { task_id: entry.taskId, agent: task.agent });
    options.onLine(text.waiting(task.title));
    let claimed = false;
    const base = { steps: 0, cost: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
    try {
      for (;;) {
        if (this.cancelled) return { ...base, stopReason: "cancelled", detail: "" };
        const current = await findTask(options.inboxDir, ref);
        if (!current || current.state === "cancelled") return { ...base, stopReason: "cancelled", detail: "" };
        if (current.state === "claimed" && !claimed) {
          claimed = true;
          await this.emit("task_claimed", { task_id: entry.taskId, agent: task.agent });
          options.onLine(text.claimed(task.title));
        }
        if (current.state === "done" && current.report) {
          const gaveUp = current.report.status === "gave_up";
          return { ...base, stopReason: "settled", detail: current.report.summary, gaveUp };
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    } finally {
      await removeTask(options.inboxDir, ref);
    }
  }

  private async removeWorktree(worktree: string): Promise<void> {
    await git(this.options.repo, ["worktree", "remove", "--force", worktree], false);
    await rm(worktree, { recursive: true, force: true });
    await git(this.options.repo, ["worktree", "prune"], false);
  }

  /** Drop the worktree and its branch: the task never started. */
  private async discard(worktree: string, branch: string): Promise<void> {
    await this.removeWorktree(worktree);
    await git(this.options.repo, ["branch", "-q", "-D", branch], false);
  }
}
