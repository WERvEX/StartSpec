import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tasks waiting for an agent that takes its own work (Claude Desktop, through KM0's MCP server). The direct
 * executor writes one file per task into KM0's `dispatch/` folder and waits; the MCP server claims it, lets the
 * agent work in the task's worktree and records its report; the executor then carries on. Neither side touches
 * KM0's database, so the MCP server runs beside an open KM0 window without getting in its way.
 */

export type InboxState = "waiting" | "claimed" | "done" | "cancelled";

export interface InboxReport {
  status: "done" | "gave_up";
  summary: string;
  at: string;
}

export interface InboxTask {
  version: 1;
  /** `<run_id>/<NN>`, how the agent names the task in every tool call. */
  ref: string;
  runId: string;
  taskId: string;
  seq: number;
  title: string;
  projectTitle: string;
  agent: string;
  /** The model the plan chose; the agent may not be able to switch to it, so it is a suggestion. */
  model: string | null;
  worktree: string;
  branch: string;
  /** The task as handed off: the same text as the package's task file. */
  prompt: string;
  testCommand: string | null;
  acceptance: string[];
  language: "zh-CN" | "en";
  state: InboxState;
  createdAt: string;
  claimedAt: string | null;
  report: InboxReport | null;
}

const fileName = (ref: string) => `${ref.replace(/[^\w.-]+/g, "--")}.json`;

/** Every task in the inbox, oldest first; unreadable files are skipped. */
export async function readInbox(dir: string): Promise<InboxTask[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const tasks: InboxTask[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const task = await readTask(join(dir, name));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.ref.localeCompare(b.ref));
}

async function readTask(path: string): Promise<InboxTask | null> {
  try {
    const task = JSON.parse(await readFile(path, "utf8")) as InboxTask;
    return task.version === 1 && typeof task.ref === "string" ? task : null;
  } catch {
    return null;
  }
}

export async function findTask(dir: string, ref: string): Promise<InboxTask | null> {
  return readTask(join(dir, fileName(ref)));
}

/** Written to a temporary file and renamed, so a reader never sees half a task. */
export async function putTask(dir: string, task: InboxTask): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName(task.ref));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function removeTask(dir: string, ref: string): Promise<void> {
  await rm(join(dir, fileName(ref)), { force: true });
}

/** Drop every task a run left behind: the run is over, so no agent should take them any more. */
export async function removeRun(dir: string, runId: string): Promise<void> {
  for (const task of await readInbox(dir)) {
    if (task.runId === runId) await removeTask(dir, task.ref);
  }
}

/**
 * Change a task under a lock file, so two MCP servers (two Claude Desktop windows) cannot both claim it.
 * `change` returns the new task, or null to leave it as it is; the result is the task as it ends up.
 */
export async function updateTask(
  dir: string,
  ref: string,
  change: (task: InboxTask) => InboxTask | null,
): Promise<InboxTask | null> {
  const lock = join(dir, `${fileName(ref)}.lock`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const task = await findTask(dir, ref);
    if (!task) return null;
    const next = change(task);
    if (!next) return task;
    await putTask(dir, next);
    return next;
  } finally {
    await rm(lock, { force: true });
  }
}
