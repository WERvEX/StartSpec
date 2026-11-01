import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

// Claude Code and Claude Desktop finish one project together: KM0 starts (a stand-in for) Claude Code on tasks
// 01 and 03, and Claude Desktop (scripted, through the MCP server started exactly as Settings tells Claude
// Desktop to start it) takes task 02.
const fixtures = join(import.meta.dirname, "fixtures");

let launched: LaunchedApp;
let page: Page;
let repo: string;

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "km0-direct-e2e-"));
  writeFileSync(join(repo, "app.txt"), "hello\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
  launched = await launchApp({ KM0_FAKE_LLM: "1", PATH: `${fixtures}${delimiter}${process.env.PATH}` });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

const panel = () => page.getByRole("region", { name: "执行", exact: true });
const latestRun = () =>
  panel()
    .getByRole("listitem", { name: /^执行 / })
    .first();
const taskRow = (title: string) => latestRun().getByRole("listitem").filter({ hasText: title });

test("Claude Code and Claude Desktop finish a project together", async () => {
  // Settings → Execution: straight to agents; KM0 finds Claude Code and shows Claude Desktop's MCP entry.
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "执行" }).click();
  await page.getByRole("radio", { name: /直接交给 Agent/ }).check();
  const direct = page.getByRole("region", { name: "直接交给 Agent" });
  await expect(direct.getByText("2.1.316")).toBeVisible();
  const desktopSection = page.getByRole("region", { name: "Claude Desktop" });
  const config = JSON.parse((await desktopSection.locator("pre").first().textContent()) ?? "{}") as {
    mcpServers: { km0: { command: string; args: string[]; env: Record<string, string> } };
  };
  expect(config.mcpServers.km0.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  expect(config.mcpServers.km0.args[0]).toMatch(/km0-mcp\.cjs$/);
  await expect(desktopSection.getByText(/^claude mcp add km0 --env ELECTRON_RUN_AS_NODE=1 -- /)).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.screenshot({ path: "test-results/screenshots/settings-direct.png", fullPage: true });

  // Settings → Agents: Claude Desktop starts switched off.
  await page.getByRole("tab", { name: "Agent" }).click();
  const card = page.getByRole("region", { name: "Claude Desktop", exact: true });
  await expect(card.getByRole("checkbox", { name: "Claude Desktop" })).not.toBeChecked();
  await card.getByRole("checkbox", { name: "Claude Desktop" }).check();
  await card.getByRole("button", { name: "保存" }).click();
  await expect(card.getByRole("button", { name: "保存" })).toHaveCount(0);

  // A full-path project: three tasks, 02 after 01 and 03 after both.
  await page.getByRole("link", { name: /新建任务/ }).click();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("从零做一个内部知识库平台");
  await page.getByRole("button", { name: "开始分诊" }).click();
  for (const stage of ["A 定位与规模", "B 产品需求", "C 技术选型", "D 实现方案"]) {
    await expect(page.getByText(`${stage} · 第 1 轮`)).toBeVisible();
    await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  }
  await expect(page.getByRole("heading", { name: "8. 待定问题" })).toBeVisible();
  await page.getByRole("tab", { name: "任务与路由" }).click();
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(4);

  // Give task 02 to Claude Desktop by hand.
  await rows.nth(2).getByRole("button", { expanded: false }).click();
  const combination = page.getByRole("combobox", { name: "组合" });
  const option = combination
    .locator("option")
    .filter({ hasText: /^Claude Desktop · / })
    .first();
  await combination.selectOption((await option.getAttribute("value")) ?? "");
  await expect(rows.nth(2).getByText("Claude Desktop")).toBeVisible();

  // The check names what each agent needs; then link the repository and start.
  await panel().getByRole("button", { name: "执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "执行前检查" });
  await dialog.getByRole("button", { name: "选择仓库" }).click();
  const browser = page.getByRole("dialog", { name: "选择本地仓库" });
  await browser.getByRole("textbox", { name: "路径" }).fill(repo);
  await browser.getByRole("button", { name: "前往" }).click();
  await browser.getByRole("button", { name: "选择此文件夹" }).click();
  await expect(dialog.getByText(/Claude Code 2\.1\.316/)).toBeVisible();
  await expect(dialog.getByText(/1 个任务会等待 Claude Desktop 领取/)).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/direct-precheck.png" });
  await dialog.getByRole("button", { name: "开始执行" }).click();
  await expect(dialog).toBeHidden();

  // Claude Code does 01; then 02 waits for Claude Desktop.
  await expect(taskRow("搭建项目骨架").getByText("待验收")).toBeVisible({ timeout: 20_000 });
  await expect(taskRow("实现核心功能").getByText("等待领取")).toBeVisible({ timeout: 20_000 });
  await expect(latestRun().getByText(/在 Claude Desktop 里说“做 KM0 的任务”/)).toBeVisible();
  await panel().screenshot({ path: "test-results/screenshots/direct-awaiting.png" });

  // Claude Desktop, scripted: start KM0's MCP server the way its config says, take the task, do it, report.
  const { command, args, env } = config.mcpServers.km0;
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "scripted-claude-desktop", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, input: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: input })) as { content: { text: string }[] }).content[0]?.text ?? "";
  const taken = await call("km0_next_task");
  const ref = taken.match(/已领取任务 (\S+)。/)?.[1] ?? "";
  expect(ref).toMatch(/\/02$/);
  await expect(taskRow("实现核心功能").getByText("执行中")).toBeVisible();
  expect(await call("km0_list_files", { task_ref: ref })).toContain("claude-01.txt");
  await call("km0_write_file", { task_ref: ref, path: "desktop-02.txt", content: "task 02 by Claude Desktop\n" });
  await call("km0_report", { task_ref: ref, status: "done", summary: "Added desktop-02.txt." });
  await client.close();

  // Claude Code does 03 on top of both; the run ends and every task is judged.
  await expect(latestRun().getByText("已结束", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(latestRun().getByText(/结果已导入并验收/)).toBeVisible({ timeout: 20_000 });
  for (const title of ["搭建项目骨架", "实现核心功能", "设计数据模型与权限"]) {
    await expect(taskRow(title).getByText("待验收")).toBeVisible();
  }
  await expect(taskRow("实现核心功能").getByText(/Claude Desktop/)).toBeVisible();
  await expect(taskRow("设计数据模型与权限").getByText(/Claude Code/)).toBeVisible();
  await panel().screenshot({ path: "test-results/screenshots/direct-finished.png" });
  const branch = execSync("git branch --list 'km0/*/03'", { cwd: repo, encoding: "utf8" }).trim().replace("* ", "");
  expect(execSync(`git show ${branch}:desktop-02.txt`, { cwd: repo, encoding: "utf8" })).toBe(
    "task 02 by Claude Desktop\n",
  );
  expect(execSync(`git show ${branch}:claude-01.txt`, { cwd: repo, encoding: "utf8" })).toMatch(/task 01/);
});
