import { z } from "zod";

/**
 * Running a hand-off package from KM0: by default with KM0 Runner, which KM0 starts, follows through its
 * `progress.jsonl` and stops; by handing each task straight to the agent it was routed to (`direct`: Claude Code,
 * which KM0 starts, and Claude Desktop, which takes its tasks over MCP); or with a command the user gives, which
 * KM0 only starts, shows and stops (unverified). The browser debug build cannot start local processes.
 */

/** The oldest KM0 Runner that writes progress.jsonl, stops on request and runs each task on its own ladder. */
export const RUNNER_MIN_VERSION = "0.3.0";
/** The pi version KM0 Runner pins; its configs refuse another one. */
export const PI_VERSION = "1.3.0";
/** The oldest Claude Code KM0 has run with `-p --output-format stream-json`. */
export const CLAUDE_CODE_MIN_VERSION = "2.0.0";
/** Agents the direct executor can hand a task to. */
export const DIRECT_AGENTS = ["claude_code", "claude_desktop"] as const;

const Path = z.string().trim().min(1).max(1000);
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalidEnvName");

export const ExecutorSettings = z.object({
  kind: z.enum(["runner", "direct", "custom"]).default("runner"),
  /** How to start KM0 Runner, such as `km0-runner` or `python -m km0_runner`; null finds it by itself. */
  runnerCommand: Path.nullable().default(null),
  /** Where run directories go; null: `runs/` in KM0's data folder. */
  runsDir: Path.nullable().default(null),
  /** The user's own runner.yaml; null: KM0 writes one from the plan and Settings → Models. */
  configFile: Path.nullable().default(null),
  /** Direct: how to start Claude Code, such as `claude`; null finds it on PATH. */
  claudeCommand: Path.nullable().default(null),
  /** Custom executor: the command, with {package}, {repo}, {run_dir} and {tasks} filled in. */
  customTemplate: z.string().trim().min(1).max(2000).nullable().default(null),
  customCwd: Path.nullable().default(null),
  customEnv: z.record(EnvName, z.string().max(4000)).default({}),
});
export type ExecutorSettings = z.output<typeof ExecutorSettings>;
export type ExecutorSettingsInput = z.input<typeof ExecutorSettings>;

/** A program KM0 looked for: where it is, its version, and what is wrong with it. */
export const ToolCheck = z.object({
  found: z.boolean(),
  command: z.string().nullable(),
  version: z.string().nullable(),
  ok: z.boolean(),
  problem: z.string().nullable(),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

/** What Claude Desktop (or any MCP client) needs to start KM0's MCP server: its entry in `mcpServers`. */
export const McpSetup = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});
export type McpSetup = z.infer<typeof McpSetup>;

export const ExecutorStatus = z.object({
  /** False in the browser debug build, with the reason. */
  available: z.boolean(),
  reason: z.string().nullable(),
  runner: ToolCheck,
  pi: ToolCheck,
  claude: ToolCheck,
  /** How to add KM0's MCP server to Claude Desktop; null in the browser build. */
  mcp: McpSetup.nullable(),
  runsDir: z.string(),
});
export type ExecutorStatus = z.infer<typeof ExecutorStatus>;

export const PrecheckItem = z.object({
  id: z.enum(["repo", "runner", "pi", "models", "keys", "ladder", "budget", "custom", "agents", "claude", "desktop"]),
  ok: z.boolean(),
  /** A failed blocking item stops the run from starting; others are warnings or information. */
  blocking: z.boolean(),
  detail: z.string(),
  /** Where to fix it. */
  fix: z.enum(["settings.execution", "settings.models", "project", "routing"]).nullable(),
});
export type PrecheckItem = z.infer<typeof PrecheckItem>;

export const Precheck = z.object({ ok: z.boolean(), items: z.array(PrecheckItem) });
export type Precheck = z.infer<typeof Precheck>;

/** `awaiting`: handed to an agent that takes its tasks itself (Claude Desktop) and not taken yet. */
export const ExecTaskStatus = z.enum([
  "waiting",
  "awaiting",
  "running",
  "passed",
  "unjudged",
  "failed",
  "blocked",
  "cancelled",
]);
export type ExecTaskStatus = z.infer<typeof ExecTaskStatus>;

/** One task of a run as the progress file tells it. */
export const ExecTask = z.object({
  taskId: z.string(),
  seq: z.number().int(),
  title: z.string(),
  status: ExecTaskStatus,
  /** The agent working on it; null when the executor does not say (KM0 Runner runs pi). */
  agent: z.string().nullable(),
  tier: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.number(),
  escalations: z.array(z.object({ from: z.string(), to: z.string(), signal: z.string(), detail: z.string() })),
  /** Why it failed, was blocked or cancelled. */
  detail: z.string(),
});
export type ExecTask = z.infer<typeof ExecTask>;

export const ExecutionStatus = z.enum(["running", "stopping", "finished", "cancelled", "failed", "interrupted"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const ExecutionRun = z.object({
  /** KM0's id for the run (`runs` table). */
  id: z.number().int(),
  projectId: z.number().int(),
  runId: z.string(),
  executor: z.enum(["runner", "direct", "custom"]),
  status: ExecutionStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  runDir: z.string(),
  cost: z.number(),
  budget: z.number().nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  tasks: z.array(ExecTask),
  /** The last lines the process printed. */
  log: z.array(z.string()),
  /** The imported KM0 Runner run with KM0's verdicts, once the results are in. */
  importedRunRef: z.number().int().nullable(),
  /** A redo of these task seqs on top of an earlier run's branches; empty for a full run. */
  seqs: z.array(z.number().int()),
  reuse: z.string().nullable(),
});
export type ExecutionRun = z.infer<typeof ExecutionRun>;

const ProjectId = z.number().int().positive();

export const StartExecutionInput = z.object({
  projectId: ProjectId,
  /** Only these tasks; the rest start from `reuse`'s branches. */
  seqs: z.array(z.number().int().positive()).default([]),
  reuse: z
    .string()
    .regex(/^[\w.-]+$/)
    .nullable()
    .default(null),
});

export const ExecutionRef = z.object({ projectId: ProjectId, runRef: z.number().int().positive() });

/** The window is closing while runs are still going; the renderer asks whether to stop them. */
export const QuitRequest = z.object({ running: z.number().int() });
