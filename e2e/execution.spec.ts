import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

// A stand-in KM0 Runner and pi (e2e/fixtures): the same progress, report and stop protocol, no model.
const fixtures = join(import.meta.dirname, "fixtures");
const runner = `node ${join(fixtures, "fake-runner.mjs")}`;

let launched: LaunchedApp;
let page: Page;
let repo: string;

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "km0-exec-e2e-"));
  writeFileSync(join(repo, "app.txt"), "hello\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
  launched = await launchApp({
    KM0_FAKE_LLM: "1",
    PATH: `${fixtures}${delimiter}${process.env.PATH}`,
    FAKE_RUNNER_STEP_MS: "300",
  });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  rmSync(repo, { recursive: true, force: true });
});

const panel = () => page.getByRole("region", { name: "执行", exact: true });
const latestRun = () =>
  panel()
    .getByRole("listitem", { name: /^执行 / })
    .first();

async function precheck(): Promise<Locator> {
  await panel().getByRole("button", { name: "执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "执行前检查" });
  await expect(dialog.getByText("仓库", { exact: true })).toBeVisible();
  return dialog;
}

test("a run is checked, started, followed, stopped and redone, and its results are judged", async () => {
  // Settings → Execution: point KM0 at the Runner; the generated config needs a key for the seeded provider.
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "执行" }).click();
  await expect(page.getByText("KM0 Runner（默认）")).toBeVisible();
  await page.getByRole("textbox", { name: "Runner 启动方式（可选）" }).fill(runner);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("0.3.0")).toBeVisible();
  await expect(page.getByText("1.3.0")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/settings-execution.png", fullPage: true });

  // A small fix: one task, routed.
  await page.getByRole("link", { name: /新建任务/ }).click();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("修复登录页按钮上的错别字");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await page.getByRole("button", { name: "填入推荐答案" }).click();
  await page.getByRole("button", { name: "提交回答" }).click();
  await page.getByRole("button", { name: "完成讨论" }).click();
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);

  // The check lists what is missing and where to fix it: no repository, no key.
  let dialog = await precheck();
  await expect(dialog.getByText(/还没有关联本地仓库/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始执行" })).toBeDisabled();
  await dialog.getByRole("button", { name: "选择仓库" }).click();
  const browser = page.getByRole("dialog", { name: "选择本地仓库" });
  await browser.getByRole("textbox", { name: "路径" }).fill(repo);
  await browser.getByRole("button", { name: "前往" }).click();
  await browser.getByRole("button", { name: "选择此文件夹" }).click();
  await expect(dialog.getByText(repo, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/这些服务商没有密钥/)).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/execution-precheck.png" });
  await dialog.getByRole("link", { name: "去“设置 → 模型”" }).click();
  await page.getByRole("button", { name: "编辑 Claude Code" }).click();
  await page.getByRole("textbox", { name: "API Key（可选）" }).fill("sk-e2e-123456");
  await page.getByRole("button", { name: "保存" }).click();
  await page.goBack();
  await expect(panel()).toBeVisible();

  // Start: each task's progress shows as it goes, then the results are imported and judged.
  dialog = await precheck();
  await expect(dialog.getByText(/^T\d claude-/)).toBeVisible();
  await dialog.getByRole("button", { name: "开始执行" }).click();
  await expect(dialog).toBeHidden();
  await expect(latestRun().getByText("执行中").first()).toBeVisible();
  // The task shows up with the first progress event.
  await expect(latestRun().getByText("按确认的范围完成改动")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/execution-running.png", fullPage: true });
  await expect(latestRun().getByText("已结束", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(latestRun().getByText("通过", { exact: true })).toBeVisible();
  await expect(latestRun().getByText(/结果已导入并验收/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: /已结束，结果正在导入和验收/ })).toBeVisible();
  const acceptance = page.getByRole("region", { name: "执行结果验收" });
  await expect(acceptance.getByText("通过", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/execution-finished.png", fullPage: true });

  // Stop: KM0 asks in its own dialog, the Runner cancels what is left, and the run says so.
  dialog = await precheck();
  await dialog.getByRole("button", { name: "开始执行" }).click();
  await expect(latestRun().getByText("执行中").first()).toBeVisible();
  await latestRun().getByRole("button", { name: "停止" }).click();
  await page.getByRole("dialog", { name: "停止这次执行" }).getByRole("button", { name: "停止" }).click();
  await expect(latestRun().getByText("已取消", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // A run that did not pass can be redone on top of the earlier one.
  await expect(latestRun().getByRole("button", { name: /重做 #1/ })).toBeVisible();
  await latestRun()
    .getByRole("button", { name: /重做 #1/ })
    .click();
  await expect(latestRun().getByText(/重做 #1，基于/)).toBeVisible();
  await expect(latestRun().getByText("已结束", { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("closing the window during a run asks first, in KM0's own dialog", async () => {
  const dialog = await precheck();
  await dialog.getByRole("button", { name: "开始执行" }).click();
  await expect(latestRun().getByText("执行中").first()).toBeVisible();
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const ask = page.getByRole("dialog", { name: "还有执行没结束" });
  await expect(ask).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/execution-quit.png" });
  await ask.getByRole("button", { name: "继续执行" }).click();
  await expect(ask).toBeHidden();
  await expect(latestRun().getByText("已结束", { exact: true })).toBeVisible({ timeout: 20_000 });
});
