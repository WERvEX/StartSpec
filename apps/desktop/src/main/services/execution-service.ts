import type { Language } from "@km0/core";
import {
  AppError,
  CLAUDE_CODE_MIN_VERSION,
  DIRECT_AGENTS,
  type ExecTask,
  type ExecTaskStatus,
  type ExecutionRun,
  type ExecutionStatus,
  ExecutorSettings,
  type ExecutorStatus,
  type HandoffPackage,
  type McpSetup,
  type ModelEntry,
  PI_VERSION,
  type Precheck,
  type PrecheckItem,
  type RoutingPlan,
  RUNNER_MIN_VERSION,
  type ToolCheck,
} from "@km0/shared";
import { type Database, nowIso } from "../db/sql";
// Types only: the executor itself is Node code, handed in by the desktop app so the browser build never loads it.
import type { DirectRunOptions, DirectTask } from "../dispatch/direct-run";
import type { ExecPort, RunningProcess } from "./exec-port";
import type { HandoffService } from "./handoff-service";
import { KeyedLock } from "./lock";
import type { RoutingService } from "./routing-service";
import type { RunnerService } from "./runner-service";
import type { SettingsStore } from "./settings-store";

const SETTINGS_KEY = "execution";
const PROGRESS_FILE = "progress.jsonl";
const STOP_FILE = "STOP";
/** Exit code of `km0-runner run` when it was stopped. */
const EXIT_CANCELLED = 3;
const POLL_MS = 500;
const LOG_LINES = 200;
const KEPT_LOG_LINES = 50;
/** Official endpoints for providers set up without an address: an agent signs in by itself, or the default API. */
const DEFAULT_BASE_URL = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" } as const;

interface RunRow {
  id: number;
  project_id: number;
  run_id: string;
  executor: "runner" | "direct" | "custom";
  status: ExecutionStatus;
  run_dir: string;
  seqs_json: string;
  reuse: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  cost: number;
  log_json: string;
  runner_run_ref: number | null;
}

/** What a run's progress file says so far. */
interface ProgressState {
  tasks: Map<string, ExecTask>;
  finished: "completed" | "cancelled" | null;
  cost: number;
}

interface Active {
  process: RunningProcess;
  progress: ProgressState;
  offset: number;
  log: string[];
  stopping: boolean;
  timer: ReturnType<typeof setInterval>;
}

const emptyProgress = (): ProgressState => ({ tasks: new Map(), finished: null, cost: 0 });

/** Fold progress.jsonl events into the run's tasks; unknown events and malformed lines are skipped. */
export function applyProgress(state: ProgressState, lines: string[]): ProgressState {
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof event.task_id === "string" ? event.task_id : null;
    const task = id ? state.tasks.get(id) : undefined;
    switch (event.event) {
      case "run_started":
        for (const item of (event.tasks as { task_id: string; title: string }[] | undefined) ?? []) {
          state.tasks.set(item.task_id, {
            taskId: item.task_id,
            seq: Number.parseInt(item.task_id, 10) || 0,
            title: item.title,
            status: "waiting",
            agent: null,
            tier: null,
            model: null,
            cost: 0,
            escalations: [],
            detail: "",
          });
        }
        break;
      case "task_started":
        if (task) {
          Object.assign(task, { status: "running", tier: String(event.tier ?? "") || null });
          if (typeof event.agent === "string") task.agent = event.agent;
        }
        break;
      // The direct executor handed the task to an agent that takes its own work, which then took it.
      case "task_waiting":
        if (task) task.status = "awaiting";
        break;
      case "task_claimed":
        if (task) task.status = "running";
        break;
      case "attempt_started":
        if (task && event.purpose !== "merge") {
          Object.assign(task, {
            tier: String(event.tier ?? "") || task.tier,
            model: String(event.model ?? "") || null,
          });
        }
        break;
      case "attempt_finished":
        if (task) task.cost += Number(event.cost) || 0;
        state.cost += Number(event.cost) || 0;
        break;
      case "escalation":
        task?.escalations.push({
          from: String(event.from_tier ?? ""),
          to: String(event.to_tier ?? ""),
          signal: String(event.signal ?? ""),
          detail: String(event.detail ?? ""),
        });
        break;
      case "task_finished":
        if (task) {
          task.status = (event.status as ExecTaskStatus) ?? "failed";
          task.detail = String(event.failure_detail ?? "");
        }
        break;
      case "run_finished":
        state.finished = event.status === "cancelled" ? "cancelled" : "completed";
        if (typeof event.cost === "number") state.cost = event.cost;
        break;
    }
  }
  return state;
}

/** `km0-runner 0.2.0` → `0.2.0`. */
const versionIn = (output: string) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

function atLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Split a command the way a shell would for plain words and quotes; enough for a path and its arguments. */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parts;
}

/** A run id in KM0 Runner's own format, unique within the runs folder. */
function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

const TEXT = {
  "zh-CN": {
    web: "网页调试版不能启动本地程序。请在桌面版里执行，或者导出交接包后自己运行 KM0 Runner。",
    noRepo: "这个项目还没有关联本地仓库：Runner 要在一个 git 仓库里为每个任务建分支。",
    notGit: (path: string) => `${path} 不是 git 仓库。`,
    repo: (path: string) => path,
    runnerMissing: "没有找到 KM0 Runner：安装后放进 PATH，或者在“设置 → 执行”里填写启动方式。",
    runnerOld: (version: string) =>
      `KM0 Runner ${version} 太旧，需要 ${RUNNER_MIN_VERSION} 或更新的版本（能写进度、停止，并让每个任务沿自己的升级链执行）。`,
    runnerOk: (version: string, command: string) => `${version}（${command}）`,
    piMissing: `没有找到 pi：npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}`,
    piWrong: (version: string) =>
      `pi ${version} 不是 Runner 锁定的 ${PI_VERSION}：npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}`,
    piOk: (version: string) => version,
    piOwnConfig: "使用自己的 Runner 配置：pi 由 Runner 自己检查。",
    noModels: "没有任务分到模型：先在“设置 → Agent”里给 Agent 勾选模型。",
    noTask: "还没有拆解任务。",
    unknownSeq: (seqs: string) => `计划里没有这些任务：${seqs}`,
    keys: (names: string) => `这些服务商没有密钥，也没有地址：${names}`,
    keysOk: "阶梯和升级链上的服务商都有密钥或地址；密钥只通过环境变量交给 Runner。",
    ladder: (rungs: string) => rungs,
    ownLadders: (count: number) => `；${count} 个任务沿各自的升级链执行`,
    ownConfig: (path: string) => `使用自己的 Runner 配置：${path}`,
    over: (expected: string, budget: string) => `期望总成本 ${expected} 超出预算 ${budget}。`,
    withinBudget: (expected: string) => `期望总成本 ${expected}。`,
    noTemplate: "自定义执行方式还没有填写命令。",
    custom: (template: string) => `自定义命令（未验证）：${template}`,
    noReports: "执行结束，但运行目录里没有 Runner 格式的结果，请手动导入。",
    judgeFailed: (message: string) => `结果已导入，但验收没有完成：${message}`,
    exited: (code: number | null) => `执行进程退出，退出码 ${code ?? "无"}。`,
    interrupted: "KM0 关闭时这个执行还没有结束。",
    directAgents: (count: number) =>
      `${count} 个任务直接交给对应的 Agent：Claude Code 自动执行，Claude Desktop 等它来领取。`,
    unsupported: (tasks: string) =>
      `这些任务分给了不能直接执行的 Agent：${tasks}。在路由表里改成 Claude Code 或 Claude Desktop，或者改用 KM0 Runner 执行。`,
    claudeMissing:
      "没有找到 Claude Code：npm install -g @anthropic-ai/claude-code，或者在“设置 → 执行”里填写启动方式。",
    claudeOld: (version: string) => `Claude Code ${version} 太旧，需要 ${CLAUDE_CODE_MIN_VERSION} 或更新的版本。`,
    claudeOk: (version: string, login: string) => `Claude Code ${version}；${login}`,
    claudeKey: "密钥只通过环境变量交给 Claude Code。",
    claudeOwnLogin: "使用 Claude Code 自己的登录；用订阅登录时，请自行确认这样调用符合订阅条款。",
    desktop: (count: number) =>
      `${count} 个任务会等待 Claude Desktop 领取：先在“设置 → 执行”里把 KM0 的 MCP 服务器加到 Claude Desktop，然后在 Claude Desktop 里说“做 KM0 的任务”。`,
  },
  en: {
    web: "The browser debug build cannot start local programs. Run from the desktop app, or export the package and run KM0 Runner yourself.",
    noRepo: "This project has no linked local repository: the Runner makes a branch per task in a git repository.",
    notGit: (path: string) => `${path} is not a git repository.`,
    repo: (path: string) => path,
    runnerMissing: "KM0 Runner was not found: install it on PATH, or set how to start it under Settings → Execution.",
    runnerOld: (version: string) =>
      `KM0 Runner ${version} is too old; ${RUNNER_MIN_VERSION} or newer is needed (progress, stopping and a ladder per task).`,
    runnerOk: (version: string, command: string) => `${version} (${command})`,
    piMissing: `pi was not found: npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}`,
    piWrong: (version: string) =>
      `pi ${version} is not the ${PI_VERSION} the Runner pins: npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}`,
    piOk: (version: string) => version,
    piOwnConfig: "Using your own Runner config: the Runner checks pi itself.",
    noModels: "No task has a model: tick models for the agents under Settings → Agents first.",
    noTask: "The work has not been broken into tasks yet.",
    unknownSeq: (seqs: string) => `The plan has no such tasks: ${seqs}`,
    keys: (names: string) => `These providers have neither a key nor an address: ${names}`,
    keysOk:
      "Every provider on the ladders has a key or an address; keys reach the Runner only as environment variables.",
    ladder: (rungs: string) => rungs,
    ownLadders: (count: number) =>
      `; ${count} ${count === 1 ? "task climbs its" : "tasks climb their"} own escalation chain`,
    ownConfig: (path: string) => `Using your own Runner config: ${path}`,
    over: (expected: string, budget: string) => `The expected total ${expected} is over the ${budget} budget.`,
    withinBudget: (expected: string) => `Expected total ${expected}.`,
    noTemplate: "The custom executor has no command yet.",
    custom: (template: string) => `Custom command (unverified): ${template}`,
    noReports: "The run ended, but its folder holds no Runner results; import them by hand.",
    judgeFailed: (message: string) => `The results are imported, but acceptance did not finish: ${message}`,
    exited: (code: number | null) => `The process exited with code ${code ?? "none"}.`,
    interrupted: "This run had not finished when KM0 closed.",
    directAgents: (count: number) =>
      `${count} ${count === 1 ? "task goes" : "tasks go"} straight to its agent: Claude Code runs by itself, Claude Desktop is waited for.`,
    unsupported: (tasks: string) =>
      `These tasks went to agents the direct executor cannot run: ${tasks}. Route them to Claude Code or Claude Desktop, or run with KM0 Runner.`,
    claudeMissing:
      "Claude Code was not found: npm install -g @anthropic-ai/claude-code, or set how to start it under Settings → Execution.",
    claudeOld: (version: string) => `Claude Code ${version} is too old; ${CLAUDE_CODE_MIN_VERSION} or newer is needed.`,
    claudeOk: (version: string, login: string) => `Claude Code ${version}; ${login}`,
    claudeKey: "keys reach Claude Code only as environment variables.",
    claudeOwnLogin:
      "it uses Claude Code's own sign-in; with a subscription sign-in, check that being run this way fits its terms.",
    desktop: (count: number) =>
      `${count} ${count === 1 ? "task waits" : "tasks wait"} for Claude Desktop to take ${count === 1 ? "it" : "them"}: add KM0's MCP server to Claude Desktop under Settings → Execution, then ask Claude Desktop to "do the KM0 tasks".`,
  },
} as const;

const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
const pad = (seq: number) => String(seq).padStart(2, "0");

/**
 * The Runner config KM0 writes from the plan, models from Settings → Models: one rung per tier label for the
 * run, and for each routed task its own ladder up its escalation chain (`task_ladders`, KM0 Runner 0.3.0).
 */
export interface GeneratedConfig {
  config: Record<string, unknown>;
  modelsJson: Record<string, unknown>;
  env: Record<string, string>;
  rungs: { name: string; model: ModelEntry }[];
  /** Task seq (`NN`) → the rungs it climbs: the combination it was routed to, then each step of its chain. */
  taskLadders: Record<string, { name: string; model: ModelEntry }[]>;
  /** Providers on any ladder with neither a key nor an address. */
  keyless: string[];
}

/**
 * A task's own ladder: its choice, then its chain, each step a rung named by its tier label (`T2`, then `T2-2`
 * when the label comes again). The Runner only runs pi, so a step with a model already on the ladder is skipped.
 */
export function taskLadder(
  task: Pick<RoutingPlan["tasks"][number], "choice" | "chain">,
  byRef: Map<number, ModelEntry>,
): { name: string; model: ModelEntry }[] {
  const ladder: { name: string; model: ModelEntry; tier: string }[] = [];
  for (const step of task.choice ? [task.choice, ...task.chain] : []) {
    const model = byRef.get(step.modelRef);
    if (!model || ladder.some((rung) => rung.model.id === model.id)) continue;
    const same = ladder.filter((rung) => rung.tier === step.tier).length;
    ladder.push({ name: same === 0 ? step.tier : `${step.tier}-${same + 1}`, model, tier: step.tier });
  }
  return ladder.map(({ name, model }) => ({ name, model }));
}

export function generateConfig(
  plan: RoutingPlan,
  models: ModelEntry[],
  keyOf: (providerId: number) => string | null,
  baseUrlOf: (providerId: number) => string | null,
  pi: { command: string; modelsJson: string },
): GeneratedConfig {
  const byRef = new Map(models.map((model) => [model.id, model]));
  const rungs: { name: string; model: ModelEntry }[] = [];
  for (const tier of ["T1", "T2", "T3"] as const) {
    // The model most tasks of this label were routed to; else one their escalation chains climb to.
    const counts = new Map<number, number>();
    for (const task of plan.tasks) {
      if (task.choice?.tier === tier) counts.set(task.choice.modelRef, (counts.get(task.choice.modelRef) ?? 0) + 1);
    }
    if (counts.size === 0) {
      for (const step of plan.tasks.flatMap((task) => task.chain)) {
        if (step.tier === tier) counts.set(step.modelRef, (counts.get(step.modelRef) ?? 0) + 1);
      }
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const model = best ? byRef.get(best[0]) : undefined;
    if (model) rungs.push({ name: tier, model });
  }
  const taskLadders: GeneratedConfig["taskLadders"] = {};
  for (const task of plan.tasks) {
    const ladder = taskLadder(task, byRef);
    if (ladder.length > 0) taskLadders[String(task.seq).padStart(2, "0")] = ladder;
  }
  const provider = (model: ModelEntry) => `km0-${model.providerId}`;
  const ref = (model: ModelEntry) => `${provider(model)}/${model.modelId}`;
  const providers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const keyless: string[] = [];
  for (const { model } of [...rungs, ...Object.values(taskLadders).flat()]) {
    const name = provider(model);
    const key = keyOf(model.providerId);
    const baseUrl = baseUrlOf(model.providerId);
    if (key) env[`KM0_KEY_${model.providerId}`] = key;
    else if (!baseUrl && !keyless.includes(model.providerName)) keyless.push(model.providerName);
    const entry = (providers[name] as { models: unknown[] } | undefined) ?? {
      baseUrl: baseUrl ?? DEFAULT_BASE_URL[model.providerKind],
      api: model.providerKind === "anthropic" ? "anthropic-messages" : "openai-completions",
      // pi reads the key from the environment; it is never written to a file.
      apiKey: key ? `$KM0_KEY_${model.providerId}` : "none",
      models: [] as unknown[],
    };
    if (!(entry.models as { id: string }[]).some((item) => item.id === model.modelId)) {
      const price = model.effective;
      entry.models.push({
        id: model.modelId,
        name: model.name,
        ...(price.input !== null && price.output !== null
          ? { cost: { input: price.input, output: price.output, cacheRead: price.cacheRead ?? 0, cacheWrite: 0 } }
          : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      });
    }
    providers[name] = entry;
  }
  return {
    config: {
      pi: { command: [pi.command], models_json: pi.modelsJson },
      ladder: rungs.map(({ name, model }) => ({ name, model: ref(model) })),
      task_ladders: Object.fromEntries(
        Object.entries(taskLadders).map(([seq, ladder]) => [
          seq,
          ladder.map(({ name, model }) => ({ name, model: ref(model) })),
        ]),
      ),
    },
    modelsJson: { providers },
    env,
    rungs,
    taskLadders,
    keyless,
  };
}

/** What the direct executor needs from the desktop app. */
export interface DirectSetup {
  /** KM0's `dispatch/` folder: the inbox where tasks for Claude Desktop wait. */
  inboxDir: string;
  /** How Claude Desktop starts KM0's MCP server. */
  mcp: McpSetup | null;
  version: string;
  /** Starts the run: a DirectRun in KM0's main process. */
  startRun: (options: DirectRunOptions) => RunningProcess;
  /** A run that ended without KM0 seeing it end (KM0 closed): take its tasks out of the inbox. */
  forget: (runId: string) => Promise<void>;
}

/** `2.1.3 (Claude Code)` → `2.1.3`. */
const claudeVersionIn = (output: string) => (/claude/i.test(output) ? versionIn(output) : null);

/**
 * Runs hand-off packages from KM0. With KM0 Runner (the default) KM0 writes the package and a Runner config
 * generated from the plan, starts `km0-runner run`, follows its progress.jsonl, stops it on request, and
 * when it ends imports the reports and judges them. The direct executor hands each task to its routed agent
 * (Claude Code, Claude Desktop) and writes the same files, so it is followed, stopped and judged the same way.
 * A custom command is only started, shown and stopped.
 */
export class ExecutionService {
  private readonly active = new Map<number, Active>();
  private readonly locks = new KeyedLock<number>();

  constructor(
    private readonly db: Database,
    private readonly port: ExecPort | null,
    private readonly settings: SettingsStore,
    private readonly routing: RoutingService,
    private readonly handoff: HandoffService,
    private readonly runner: RunnerService,
    private readonly language: () => Language,
    private readonly defaultRunsDir: string,
    private readonly emit: (run: ExecutionRun) => void = () => undefined,
    private readonly direct: DirectSetup | null = null,
  ) {
    // Runs that were going when KM0 last closed: finished if their progress file says so, else interrupted.
    const stale = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('running', 'stopping')")
      .all() as unknown as RunRow[];
    for (const row of stale) void this.settle(row);
  }

  // Settings

  getSettings(): ExecutorSettings {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get(SETTINGS_KEY) as
      | { value: string }
      | undefined;
    const parsed = row ? ExecutorSettings.safeParse(JSON.parse(row.value)) : null;
    return parsed?.success ? parsed.data : ExecutorSettings.parse({});
  }

  setSettings(input: ExecutorSettings): ExecutorSettings {
    const data = ExecutorSettings.parse(input);
    this.db
      .prepare(
        "INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(SETTINGS_KEY, JSON.stringify(data));
    return data;
  }

  private runsDir(): string {
    return this.getSettings().runsDir ?? this.defaultRunsDir;
  }

  // Detection

  async status(): Promise<ExecutorStatus> {
    const none: ToolCheck = { found: false, command: null, version: null, ok: false, problem: null };
    if (!this.port) {
      return {
        available: false,
        reason: TEXT[this.language()].web,
        runner: none,
        pi: none,
        claude: none,
        mcp: null,
        runsDir: this.runsDir(),
      };
    }
    const [runner, pi, claude] = await Promise.all([this.findRunner(), this.findPi(), this.findClaude()]);
    return {
      available: true,
      reason: null,
      runner: runner.check,
      pi,
      claude: claude.check,
      mcp: this.direct?.mcp ?? null,
      runsDir: this.runsDir(),
    };
  }

  private async findClaude(): Promise<{ check: ToolCheck; command: string[] | null }> {
    const port = this.port as ExecPort;
    const text = TEXT[this.language()];
    const configured = this.getSettings().claudeCommand;
    const command = configured
      ? splitCommand(configured)
      : await port.which("claude").then((found) => (found ? [found] : null));
    if (command) {
      const result = await port.capture([...command, "--version"]);
      const version = result.code === 0 ? claudeVersionIn(result.output) : null;
      if (version) {
        const ok = atLeast(version, CLAUDE_CODE_MIN_VERSION);
        return {
          check: { found: true, command: command.join(" "), version, ok, problem: ok ? null : text.claudeOld(version) },
          command,
        };
      }
    }
    return {
      check: { found: false, command: configured, version: null, ok: false, problem: text.claudeMissing },
      command: null,
    };
  }

  private async findRunner(): Promise<{ check: ToolCheck; command: string[] | null }> {
    const port = this.port as ExecPort;
    const text = TEXT[this.language()];
    const configured = this.getSettings().runnerCommand;
    const candidates: string[][] = [];
    if (configured) candidates.push(splitCommand(configured));
    else {
      const onPath = await port.which("km0-runner");
      if (onPath) candidates.push([onPath]);
      for (const python of ["python3", "python"]) {
        const found = await port.which(python);
        if (found) candidates.push([found, "-m", "km0_runner"]);
      }
    }
    for (const command of candidates) {
      const result = await port.capture([...command, "--version"]);
      const version = result.code === 0 && /km0-runner/.test(result.output) ? versionIn(result.output) : null;
      if (!version) continue;
      const ok = atLeast(version, RUNNER_MIN_VERSION);
      return {
        check: { found: true, command: command.join(" "), version, ok, problem: ok ? null : text.runnerOld(version) },
        command,
      };
    }
    return {
      check: { found: false, command: configured, version: null, ok: false, problem: text.runnerMissing },
      command: null,
    };
  }

  private async findPi(): Promise<ToolCheck> {
    const port = this.port as ExecPort;
    const text = TEXT[this.language()];
    const command = await port.which("pi");
    if (!command) return { found: false, command: null, version: null, ok: false, problem: text.piMissing };
    const result = await port.capture([command, "--version"]);
    const version = versionIn(result.output);
    const ok = version === PI_VERSION;
    return { found: true, command, version, ok, problem: ok ? null : text.piWrong(version ?? "?") };
  }

  // Precheck

  async precheck(projectId: number, seqs: number[] = []): Promise<Precheck> {
    const text = TEXT[this.language()];
    const items: PrecheckItem[] = [];
    const item = (entry: PrecheckItem) => items.push(entry);
    if (!this.port) {
      item({ id: "runner", ok: false, blocking: true, detail: text.web, fix: null });
      return { ok: false, items };
    }
    const port = this.port;
    const settings = this.getSettings();
    const repo = this.repoOf(projectId);
    if (!repo) item({ id: "repo", ok: false, blocking: true, detail: text.noRepo, fix: "project" });
    else {
      const git = await port.capture(["git", "-C", repo, "rev-parse", "--is-inside-work-tree"]);
      const ok = git.code === 0 && git.output.trim() === "true";
      item({
        id: "repo",
        ok,
        blocking: true,
        detail: ok ? text.repo(repo) : text.notGit(repo),
        fix: ok ? null : "project",
      });
    }
    const plan = this.routing.get(projectId);
    if (!plan || plan.tasks.length === 0) {
      item({ id: "models", ok: false, blocking: true, detail: text.noTask, fix: "routing" });
      return { ok: false, items };
    }
    const unknown = seqs.filter((seq) => !plan.tasks.some((task) => task.seq === seq));
    if (unknown.length > 0) {
      item({ id: "models", ok: false, blocking: true, detail: text.unknownSeq(unknown.join(", ")), fix: "routing" });
    }

    if (settings.kind === "direct") {
      await this.precheckDirect(plan, seqs, item);
    } else if (settings.kind === "custom") {
      const template = settings.customTemplate;
      item({
        id: "custom",
        ok: Boolean(template),
        blocking: true,
        detail: template ? text.custom(template) : text.noTemplate,
        fix: template ? null : "settings.execution",
      });
    } else {
      const runner = await this.findRunner();
      item({
        id: "runner",
        ok: runner.check.ok,
        blocking: true,
        detail: runner.check.ok
          ? text.runnerOk(runner.check.version ?? "", runner.check.command ?? "")
          : (runner.check.problem ?? text.runnerMissing),
        fix: runner.check.ok ? null : "settings.execution",
      });
      if (settings.configFile) {
        item({ id: "pi", ok: true, blocking: false, detail: text.piOwnConfig, fix: null });
        item({ id: "ladder", ok: true, blocking: false, detail: text.ownConfig(settings.configFile), fix: null });
      } else {
        const pi = await this.findPi();
        item({
          id: "pi",
          ok: pi.ok,
          blocking: true,
          detail: pi.ok ? text.piOk(pi.version ?? "") : (pi.problem ?? text.piMissing),
          fix: pi.ok ? null : "settings.execution",
        });
        const generated = this.generate(plan, pi.command ?? "pi");
        if (generated.rungs.length === 0) {
          item({ id: "models", ok: false, blocking: true, detail: text.noModels, fix: "routing" });
        } else {
          const rungs = generated.rungs.map((rung) => `${rung.name} ${rung.model.name}`).join(" → ");
          const owned = Object.keys(generated.taskLadders).length;
          item({
            id: "ladder",
            ok: true,
            blocking: false,
            detail: text.ladder(rungs) + (owned > 0 ? text.ownLadders(owned) : ""),
            fix: null,
          });
          item({
            id: "keys",
            ok: generated.keyless.length === 0,
            blocking: true,
            detail: generated.keyless.length > 0 ? text.keys(generated.keyless.join("、")) : text.keysOk,
            fix: generated.keyless.length > 0 ? "settings.models" : null,
          });
        }
      }
    }
    const expected = plan.totals.expectedCost;
    if (expected !== null) {
      const over = plan.budget !== null && expected > plan.budget;
      item({
        id: "budget",
        ok: !over,
        blocking: false,
        detail: over ? text.over(usd(expected), usd(plan.budget ?? 0)) : text.withinBudget(usd(expected)),
        fix: over ? "routing" : null,
      });
    }
    return { ok: items.every((entry) => entry.ok || !entry.blocking), items };
  }

  /** Every task's agent can take a task directly; Claude Code is there when a task goes to it. */
  private async precheckDirect(plan: RoutingPlan, seqs: number[], item: (entry: PrecheckItem) => void): Promise<void> {
    const text = TEXT[this.language()];
    const tasks = seqs.length > 0 ? plan.tasks.filter((task) => seqs.includes(task.seq)) : plan.tasks;
    const names = new Map(this.routing.agentConfigs().map((agent) => [agent.id, agent.name]));
    const unsupported = tasks.filter((task) => !(DIRECT_AGENTS as readonly string[]).includes(task.agent));
    item({
      id: "agents",
      ok: unsupported.length === 0,
      blocking: unsupported.length > 0,
      detail:
        unsupported.length > 0
          ? text.unsupported(
              unsupported.map((task) => `${pad(task.seq)} ${names.get(task.agent) ?? task.agent}`).join("、"),
            )
          : text.directAgents(tasks.length),
      fix: unsupported.length > 0 ? "routing" : null,
    });
    const coded = tasks.filter((task) => task.agent === "claude_code");
    if (coded.length > 0) {
      const claude = await this.findClaude();
      const keyed = coded.some((task) => Object.keys(this.agentEnv(task)).length > 0);
      item({
        id: "claude",
        ok: claude.check.ok,
        blocking: true,
        detail: claude.check.ok
          ? text.claudeOk(claude.check.version ?? "", keyed ? text.claudeKey : text.claudeOwnLogin)
          : (claude.check.problem ?? text.claudeMissing),
        fix: claude.check.ok ? null : "settings.execution",
      });
    }
    const desktop = tasks.filter((task) => task.agent === "claude_desktop").length;
    if (desktop > 0) item({ id: "desktop", ok: true, blocking: false, detail: text.desktop(desktop), fix: null });
  }

  /** What a task's agent gets in its environment: the provider's key and address for Claude Code. */
  private agentEnv(task: RoutingPlan["tasks"][number]): Record<string, string> {
    if (task.agent !== "claude_code" || task.modelRef === null) return {};
    const model = this.settings.listModels().find((entry) => entry.id === task.modelRef);
    if (!model) return {};
    const env: Record<string, string> = {};
    const key = this.settings.providerKey(model.providerId);
    const baseUrl = this.settings.listProviders().find((provider) => provider.id === model.providerId)?.baseUrl;
    if (key) env.ANTHROPIC_API_KEY = key;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    return env;
  }

  private generate(plan: RoutingPlan, piCommand: string, modelsJson = "models.json"): GeneratedConfig {
    const providers = new Map(this.settings.listProviders().map((provider) => [provider.id, provider]));
    return generateConfig(
      plan,
      this.settings.listModels(),
      (id) => this.settings.providerKey(id),
      (id) => providers.get(id)?.baseUrl ?? null,
      { command: piCommand, modelsJson },
    );
  }

  // Runs

  start(projectId: number, seqs: number[] = [], reuse: string | null = null): Promise<ExecutionRun> {
    return this.locks.run(projectId, async () => {
      const check = await this.precheck(projectId, seqs);
      if (!check.ok) {
        const failed = check.items.find((entry) => !entry.ok && entry.blocking);
        throw new AppError("conflict", failed?.detail ?? "The run cannot start.");
      }
      const port = this.port as ExecPort;
      const settings = this.getSettings();
      const repo = this.repoOf(projectId) as string;
      const runsDir = this.runsDir();
      let runId = newRunId();
      for (let n = 2; await port.exists(port.join(runsDir, runId)); n += 1) runId = `${newRunId()}-${n}`;
      const runDir = port.join(runsDir, runId);
      // The package and config sit beside the run directory, not in it, so the run folder stays the Runner's.
      const packageDir = port.join(runsDir, `${runId}.km0`);
      // The direct executor hands each agent its own task file; KM0 Runner reads the Runner flavour.
      const pkg = this.handoff.build(projectId, settings.kind === "direct" ? "agents" : "runner");
      for (const file of pkg.files) await port.writeFile(port.join(packageDir, ...file.path.split("/")), file.content);

      let process: RunningProcess;
      const log: string[] = [];
      const onLine = (line: string) => {
        log.push(line);
        if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
      };
      if (settings.kind === "direct") {
        process = await this.startDirect(
          projectId,
          runId,
          runDir,
          port.join(packageDir, "km0"),
          pkg,
          seqs,
          reuse,
          onLine,
        );
      } else if (settings.kind === "custom") {
        const commandLine = (settings.customTemplate ?? "")
          .replaceAll("{package}", port.quote(packageDir))
          .replaceAll("{repo}", port.quote(repo))
          .replaceAll("{run_dir}", port.quote(runDir))
          .replaceAll("{tasks}", (seqs.length > 0 ? seqs : pkg.tasks.map((task) => task.seq)).join(","));
        process = port.spawnShell(commandLine, { cwd: settings.customCwd ?? repo, env: settings.customEnv, onLine });
      } else {
        const runner = (await this.findRunner()).command as string[];
        let configPath = settings.configFile;
        let env: Record<string, string> = {};
        if (!configPath) {
          const pi = await this.findPi();
          const plan = this.routing.get(projectId) as RoutingPlan;
          const modelsPath = port.join(packageDir, "models.json");
          const generated = this.generate(plan, pi.command ?? "pi", modelsPath);
          configPath = port.join(packageDir, "runner.json");
          await port.writeFile(configPath, `${JSON.stringify(generated.config, null, 2)}\n`);
          await port.writeFile(modelsPath, `${JSON.stringify(generated.modelsJson, null, 2)}\n`);
          env = generated.env;
        }
        const args = ["run", packageDir, "--repo", repo, "-c", configPath, "--runs", runsDir, "--run-id", runId];
        if (seqs.length > 0) args.push("--tasks", ...seqs.map(String));
        if (reuse) args.push("--reuse", reuse);
        process = port.spawn([...runner, ...args], { cwd: repo, env, onLine });
      }

      const result = this.db
        .prepare(
          `INSERT INTO runs (project_id, run_id, executor, status, run_dir, seqs_json, reuse, started_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(projectId, runId, settings.kind, runDir, JSON.stringify(seqs), reuse, nowIso());
      const id = Number(result.lastInsertRowid);
      const active: Active = {
        process,
        progress: emptyProgress(),
        offset: 0,
        log,
        stopping: false,
        timer: setInterval(() => void this.poll(id), POLL_MS),
      };
      this.active.set(id, active);
      void process.exited.then((exit) => this.finish(id, exit.code));
      return this.view(this.row(id));
    });
  }

  private async startDirect(
    projectId: number,
    runId: string,
    runDir: string,
    packageDir: string,
    pkg: HandoffPackage,
    seqs: number[],
    reuse: string | null,
    onLine: (line: string) => void,
  ): Promise<RunningProcess> {
    const direct = this.direct;
    if (!direct) throw new AppError("conflict", "The direct executor is not available here.");
    const plan = this.routing.get(projectId) as RoutingPlan;
    const models = new Map(this.settings.listModels().map((model) => [model.id, model]));
    const listed = JSON.parse(pkg.files.find((file) => file.path === "km0/tasks.json")?.content ?? "[]") as {
      seq: number;
      testCommand: string | null;
    }[];
    const coded = plan.tasks.some(
      (task) => task.agent === "claude_code" && (seqs.length === 0 || seqs.includes(task.seq)),
    );
    const claude = coded ? (await this.findClaude()).command : null;
    const tasks: DirectTask[] = plan.tasks.map((task) => {
      const model = task.modelRef !== null ? models.get(task.modelRef) : undefined;
      return {
        seq: task.seq,
        title: task.title,
        dependsOn: task.dependsOn,
        agent: task.agent,
        model: task.model,
        modelRef: model ? `km0-${model.providerId}/${model.modelId}` : null,
        tier: task.tier,
        prompt: pkg.tasks.find((item) => item.seq === task.seq)?.prompt ?? "",
        testCommand: listed.find((item) => item.seq === task.seq)?.testCommand ?? null,
        acceptance: task.acceptance,
        env: this.agentEnv(task),
        features: task.features,
        score: task.score,
      };
    });
    const project = this.db.prepare("SELECT title FROM projects WHERE id = ?").get(projectId) as { title: string };
    const options: DirectRunOptions = {
      runId,
      runDir,
      repo: this.repoOf(projectId) as string,
      projectId,
      projectTitle: project.title,
      packageDir,
      tasks,
      seqs,
      reuse,
      inboxDir: direct.inboxDir,
      claudeCommand: claude,
      budget: plan.budget,
      language: this.language(),
      version: direct.version,
      onLine,
    };
    return direct.startRun(options);
  }

  /** Ask a run to stop: its stop file (any platform) and SIGTERM where there is one. */
  async stop(projectId: number, runRef: number): Promise<ExecutionRun> {
    const row = this.row(runRef);
    if (row.project_id !== projectId) throw new AppError("not_found", `Run ${runRef} does not exist.`);
    const active = this.active.get(runRef);
    if (!active) return this.view(row);
    active.stopping = true;
    if (this.port) await this.port.writeFile(this.port.join(row.run_dir, STOP_FILE), "");
    active.process.terminate();
    this.db.prepare("UPDATE runs SET status = 'stopping' WHERE id = ?").run(runRef);
    const view = this.view(this.row(runRef));
    this.emit(view);
    return view;
  }

  /** Stop every run still going and wait for them to end, at most `timeoutMs`; for closing the window. */
  async stopAll(timeoutMs = 15_000): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.stop(this.row(id).project_id, id)));
    const waits = ids.map((id) => this.active.get(id)?.process.exited ?? Promise.resolve());
    await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    for (const id of ids) this.active.get(id)?.process.kill();
  }

  runningCount(): number {
    return this.active.size;
  }

  list(projectId: number): Promise<ExecutionRun[]> {
    return Promise.all(
      (
        this.db
          .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC")
          .all(projectId) as unknown as RunRow[]
      ).map((row) => this.loadView(row)),
    );
  }

  /** Read new progress lines; a line is only taken once it is complete. */
  private async poll(id: number): Promise<void> {
    const active = this.active.get(id);
    if (!active || !this.port) return;
    const row = this.row(id);
    const { text } = await this.port.readFrom(this.port.join(row.run_dir, PROGRESS_FILE), active.offset);
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      this.emit(this.view(row));
      return;
    }
    const complete = text.slice(0, end + 1);
    active.offset += new TextEncoder().encode(complete).length;
    applyProgress(active.progress, complete.split("\n").filter(Boolean));
    this.emit(this.view(row));
  }

  private async finish(id: number, code: number | null): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    clearInterval(active.timer);
    await this.poll(id);
    this.active.delete(id);
    const row = this.row(id);
    const text = TEXT[this.language()];
    const cancelled = code === EXIT_CANCELLED || active.progress.finished === "cancelled" || active.stopping;
    // The Runner and the direct executor exit 1 when some task failed, which is still a finished run; a custom
    // command must exit 0.
    const ok = row.executor === "custom" ? code === 0 : code === 0 || code === 1;
    const status: ExecutionStatus = cancelled ? "cancelled" : ok ? "finished" : "failed";
    const error = status === "failed" ? [text.exited(code), ...active.log.slice(-5)].join("\n") : null;
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error = ?, cost = ?, log_json = ? WHERE id = ?`,
      )
      .run(status, nowIso(), code, error, active.progress.cost, JSON.stringify(active.log.slice(-KEPT_LOG_LINES)), id);
    this.emit(await this.loadView(this.row(id)));
    await this.collect(id);
  }

  /** Import the run's reports and judge them; a run without Runner reports asks for a manual import. */
  private async collect(id: number): Promise<void> {
    const row = this.row(id);
    const text = TEXT[this.language()];
    if (!this.port || !(await this.port.exists(this.port.join(row.run_dir, "reports")))) {
      if (row.executor === "custom") this.noteError(id, text.noReports);
      return;
    }
    try {
      const imported = await this.runner.import(row.project_id, row.run_dir);
      if (!imported) return;
      this.db.prepare("UPDATE runs SET runner_run_ref = ? WHERE id = ?").run(imported.id, id);
      this.emit(await this.loadView(this.row(id)));
      await this.runner.judge(row.project_id, imported.id);
    } catch (error) {
      this.noteError(id, text.judgeFailed(error instanceof Error ? error.message : String(error)));
      return;
    }
    this.emit(await this.loadView(this.row(id)));
  }

  private noteError(id: number, message: string): void {
    const row = this.row(id);
    this.db.prepare("UPDATE runs SET error = ? WHERE id = ?").run(row.error ? `${row.error}\n${message}` : message, id);
    void this.loadView(this.row(id)).then((view) => this.emit(view));
  }

  /** A run left going when KM0 closed. */
  private async settle(row: RunRow): Promise<void> {
    if (row.executor === "direct") await this.direct?.forget(row.run_id).catch(() => undefined);
    const progress = await this.readProgress(row);
    const status: ExecutionStatus =
      progress.finished === "cancelled" ? "cancelled" : progress.finished ? "finished" : "interrupted";
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = COALESCE(finished_at, ?), cost = ?, error = ? WHERE id = ?")
      .run(
        status,
        nowIso(),
        progress.cost,
        status === "interrupted" ? TEXT[this.language()].interrupted : null,
        row.id,
      );
    if (progress.finished && row.runner_run_ref === null) await this.collect(row.id);
  }

  private async readProgress(row: RunRow): Promise<ProgressState> {
    if (!this.port) return emptyProgress();
    const { text } = await this.port.readFrom(this.port.join(row.run_dir, PROGRESS_FILE), 0);
    return applyProgress(emptyProgress(), text.split("\n").filter(Boolean));
  }

  private async loadView(row: RunRow): Promise<ExecutionRun> {
    if (this.active.has(row.id)) return this.view(row);
    return this.view(row, await this.readProgress(row));
  }

  private view(row: RunRow, progress?: ProgressState): ExecutionRun {
    const active = this.active.get(row.id);
    const state = active?.progress ?? progress ?? emptyProgress();
    const plan = this.routing.get(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      executor: row.executor,
      status: active?.stopping ? "stopping" : row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      runDir: row.run_dir,
      cost: active ? state.cost : row.cost || state.cost,
      budget: plan?.budget ?? null,
      exitCode: row.exit_code,
      error: row.error,
      tasks: [...state.tasks.values()].sort((a, b) => a.seq - b.seq),
      log: active ? active.log.slice(-KEPT_LOG_LINES) : (JSON.parse(row.log_json) as string[]),
      importedRunRef: row.runner_run_ref,
      seqs: JSON.parse(row.seqs_json) as number[],
      reuse: row.reuse,
    };
  }

  private row(id: number): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) throw new AppError("not_found", `Run ${id} does not exist.`);
    return row;
  }

  private repoOf(projectId: number): string | null {
    const row = this.db.prepare("SELECT repo_path FROM projects WHERE id = ?").get(projectId) as
      | { repo_path: string | null }
      | undefined;
    if (!row) throw new AppError("not_found", `Project ${projectId} does not exist.`);
    return row.repo_path;
  }
}
