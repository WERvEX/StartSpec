import { exec } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type InboxTask, readInbox, updateTask } from "../main/dispatch/inbox";

/**
 * KM0's MCP server, for agents that take their own work: Claude Desktop, or Claude Code in a chat. It hands out
 * the tasks KM0's direct executor put in the inbox for them, lets the agent read and write files only inside
 * the task's worktree and run the task's tests there, and records the agent's report for the executor.
 */

const MAX_READ = 200_000;
const MAX_LIST = 2_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const SKIPPED = new Set([".git", "node_modules"]);

const TEXT = {
  "zh-CN": {
    none: "现在没有等待领取的 KM0 任务。KM0 执行到交给 Claude Desktop 的任务时，才会出现在这里。",
    unknown: (ref: string) => `没有这个任务：${ref}。用 km0_next_task 领取任务。`,
    closed: (ref: string) => `任务 ${ref} 已经结束或被取消，不能再修改。`,
    outside: (path: string) => `${path} 不在任务的工作目录里。`,
    noTests: "这个任务没有测试命令。",
    written: (path: string) => `已写入 ${path}。`,
    deleted: (path: string) => `已删除 ${path}。`,
    reported: "已回报，KM0 会提交改动、运行测试并验收。",
    tooMany: (count: number) => `（只列出前 ${count} 项）`,
    exit: (code: number) => `退出码 ${code}`,
    task: (task: InboxTask, resumed: boolean) =>
      [
        resumed ? `继续之前领取的任务 ${task.ref}。` : `已领取任务 ${task.ref}。`,
        `项目：${task.projectTitle}`,
        `任务：${task.title}`,
        task.model ? `计划使用的模型：${task.model}（能选的话请用它）` : null,
        task.testCommand ? `测试命令：${task.testCommand}` : null,
        "",
        `做法：所有工具都带上 task_ref="${task.ref}"。用 km0_list_files、km0_read_file 看代码，用 km0_write_file、km0_delete_file 修改，用 km0_run_tests 运行测试；完成后用 km0_report 回报（做不了就回报 gave_up 并说明原因）。文件只在这个任务的工作目录里，项目背景和文档在 km0/ 文件夹。`,
        "",
        "---",
        "",
        task.prompt,
      ]
        .filter((line) => line !== null)
        .join("\n"),
  },
  en: {
    none: "No KM0 task is waiting. Tasks show up here when KM0 reaches one it handed to Claude Desktop.",
    unknown: (ref: string) => `There is no task ${ref}. Take one with km0_next_task.`,
    closed: (ref: string) => `Task ${ref} has finished or was cancelled and can no longer change.`,
    outside: (path: string) => `${path} is not inside the task's working folder.`,
    noTests: "This task has no test command.",
    written: (path: string) => `Wrote ${path}.`,
    deleted: (path: string) => `Deleted ${path}.`,
    reported: "Reported. KM0 commits the change, runs the tests and judges the work.",
    tooMany: (count: number) => `(only the first ${count} entries)`,
    exit: (code: number) => `exit code ${code}`,
    task: (task: InboxTask, resumed: boolean) =>
      [
        resumed ? `Carrying on with task ${task.ref}, taken earlier.` : `Took task ${task.ref}.`,
        `Project: ${task.projectTitle}`,
        `Task: ${task.title}`,
        task.model ? `Planned model: ${task.model} (use it if you can choose)` : null,
        task.testCommand ? `Test command: ${task.testCommand}` : null,
        "",
        `How: pass task_ref="${task.ref}" to every tool. Read the code with km0_list_files and km0_read_file, change it with km0_write_file and km0_delete_file, run the tests with km0_run_tests, and report with km0_report when done (report gave_up with the reason if you cannot do it). The files are the task's own working folder; the project's background and documents are in km0/.`,
        "",
        "---",
        "",
        task.prompt,
      ]
        .filter((line) => line !== null)
        .join("\n"),
  },
} as const;

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

/** A path inside the worktree, never `.git` or outside it (symbolic links included); null otherwise. */
export async function insideWorktree(root: string, path: string): Promise<string | null> {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === ".git") return null;
  const realRoot = await realpath(root);
  // The nearest part of the path that exists decides where a link would really lead.
  let existing = full;
  while (!(await stat(existing).catch(() => null)) && dirname(existing) !== existing) existing = dirname(existing);
  const real = await realpath(existing);
  const realRel = relative(realRoot, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) return null;
  return full;
}

async function listFiles(root: string, start: string): Promise<{ files: string[]; cut: boolean }> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!(await walk(full))) return false;
      } else {
        files.push(rel);
        if (files.length >= MAX_LIST) return false;
      }
    }
    return true;
  };
  const complete = await walk(start);
  return { files, cut: !complete };
}

function runTests(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    exec(
      command,
      { cwd, timeout: TEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: `${stdout}${stderr}`.slice(-8000),
        }),
    );
  });
}

export function createKm0McpServer(inboxDir: string, version = "1.1.0"): McpServer {
  const server = new McpServer({ name: "km0", version });
  const taskRef = z.string().describe("The task's ref, as km0_next_task gave it, such as 20261101-120000/02");

  /** The task, claimed and still open, or the reason it cannot be used. */
  async function open(ref: string): Promise<{ task: InboxTask } | { error: ReturnType<typeof reply> }> {
    const task = (await readInbox(inboxDir)).find((item) => item.ref === ref);
    const text = TEXT[task?.language ?? "en"];
    if (!task) return { error: reply(text.unknown(ref), true) };
    if (task.state !== "claimed") return { error: reply(text.closed(ref), true) };
    return { task };
  }

  async function file(ref: string, path: string) {
    const opened = await open(ref);
    if ("error" in opened) return opened;
    const full = await insideWorktree(opened.task.worktree, path);
    if (!full) return { error: reply(TEXT[opened.task.language].outside(path), true) };
    return { task: opened.task, full };
  }

  server.registerTool(
    "km0_next_task",
    {
      title: "Take the next KM0 task",
      description:
        "Take the next task KM0 handed to this agent, or the one taken earlier and not yet reported. Returns the task, where to work and how to report.",
      inputSchema: {},
    },
    async () => {
      const tasks = await readInbox(inboxDir);
      const open = tasks.find((task) => task.state === "claimed");
      if (open) return reply(TEXT[open.language].task(open, true));
      for (const waiting of tasks.filter((task) => task.state === "waiting")) {
        const claimed = await updateTask(inboxDir, waiting.ref, (task) =>
          task.state === "waiting" ? { ...task, state: "claimed", claimedAt: new Date().toISOString() } : null,
        );
        if (claimed?.state === "claimed") return reply(TEXT[claimed.language].task(claimed, false));
      }
      return reply(TEXT[tasks[0]?.language ?? "en"].none);
    },
  );

  server.registerTool(
    "km0_list_files",
    {
      title: "List files in the task's folder",
      description: "Files under a folder of the task's worktree (default: all of it), skipping .git and node_modules.",
      inputSchema: { task_ref: taskRef, path: z.string().default(".").describe("A folder, relative to the worktree") },
    },
    async ({ task_ref, path }) => {
      const found = await file(task_ref, path);
      if ("error" in found) return found.error;
      const { files, cut } = await listFiles(found.task.worktree, found.full);
      return reply([...files, ...(cut ? [TEXT[found.task.language].tooMany(MAX_LIST)] : [])].join("\n"));
    },
  );

  server.registerTool(
    "km0_read_file",
    {
      title: "Read a file in the task's folder",
      description: "A text file of the task's worktree.",
      inputSchema: { task_ref: taskRef, path: z.string().describe("Relative to the worktree") },
    },
    async ({ task_ref, path }) => {
      const found = await file(task_ref, path);
      if ("error" in found) return found.error;
      try {
        return reply((await readFile(found.full, "utf8")).slice(0, MAX_READ));
      } catch (error) {
        return reply((error as Error).message, true);
      }
    },
  );

  server.registerTool(
    "km0_write_file",
    {
      title: "Write a file in the task's folder",
      description: "Create or replace a text file of the task's worktree with the whole new content.",
      inputSchema: {
        task_ref: taskRef,
        path: z.string().describe("Relative to the worktree"),
        content: z.string().describe("The file's complete new content"),
      },
    },
    async ({ task_ref, path, content }) => {
      const found = await file(task_ref, path);
      if ("error" in found) return found.error;
      await mkdir(dirname(found.full), { recursive: true });
      await writeFile(found.full, content, "utf8");
      return reply(TEXT[found.task.language].written(path));
    },
  );

  server.registerTool(
    "km0_delete_file",
    {
      title: "Delete a file in the task's folder",
      description: "Remove a file of the task's worktree.",
      inputSchema: { task_ref: taskRef, path: z.string().describe("Relative to the worktree") },
    },
    async ({ task_ref, path }) => {
      const found = await file(task_ref, path);
      if ("error" in found) return found.error;
      await rm(found.full, { force: true });
      return reply(TEXT[found.task.language].deleted(path));
    },
  );

  server.registerTool(
    "km0_run_tests",
    {
      title: "Run the task's tests",
      description: "Run the task's test command in its worktree; the exit code and the end of the output.",
      inputSchema: { task_ref: taskRef },
    },
    async ({ task_ref }) => {
      const opened = await open(task_ref);
      if ("error" in opened) return opened.error;
      const text = TEXT[opened.task.language];
      if (!opened.task.testCommand) return reply(text.noTests);
      const run = await runTests(opened.task.testCommand, opened.task.worktree);
      return reply(`${text.exit(run.code)}\n\n${run.output}`, run.code !== 0);
    },
  );

  server.registerTool(
    "km0_report",
    {
      title: "Report the task done",
      description:
        "Tell KM0 the task is done (or given up, with why). KM0 then commits the change, runs the tests and judges it.",
      inputSchema: {
        task_ref: taskRef,
        status: z.enum(["done", "gave_up"]),
        summary: z.string().describe("What was changed, or why it could not be done"),
      },
    },
    async ({ task_ref, status, summary }) => {
      const opened = await open(task_ref);
      if ("error" in opened) return opened.error;
      await updateTask(inboxDir, task_ref, (task) =>
        task.state === "claimed"
          ? { ...task, state: "done", report: { status, summary, at: new Date().toISOString() } }
          : null,
      );
      return reply(TEXT[opened.task.language].reported);
    },
  );

  return server;
}
