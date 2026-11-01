import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

let launched: LaunchedApp;
let page: Page;
let folder: string;

test.beforeAll(async () => {
  launched = await launchApp({ KM0_FAKE_LLM: "1" });
  page = launched.page;
  folder = mkdtempSync(join(tmpdir(), "km0-files-e2e-"));
});

test.afterAll(async () => {
  await launched?.close();
  rmSync(folder, { recursive: true, force: true });
});

async function goTo(browser: Locator, path: string) {
  await browser.getByRole("textbox", { name: "路径" }).fill(path);
  await browser.getByRole("button", { name: "前往" }).click();
  await expect(browser.getByRole("list", { name: path })).toBeVisible();
}

test("settings are exported and imported through KM0's own file browser", async () => {
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "通用" }).click();

  await page.getByRole("button", { name: "导出配置" }).click();
  const saveDialog = page.getByRole("dialog", { name: "导出配置" });
  await goTo(saveDialog, folder);
  const name = await saveDialog.getByRole("textbox", { name: "文件名" }).inputValue();
  expect(name).toMatch(/^km0-config-\d{4}-\d{2}-\d{2}\.json$/);
  await page.screenshot({ path: "test-results/screenshots/file-browser-save.png" });
  await saveDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(saveDialog).toBeHidden();
  const saved = join(folder, name);
  await expect(page.getByRole("status").filter({ hasText: `已保存到 ${saved}` })).toBeVisible();
  expect(JSON.parse(readFileSync(saved, "utf8")).format).toBe("km0-config");

  // Saving again asks before overwriting, inside the same dialog.
  await page.getByRole("button", { name: "导出配置" }).click();
  await expect(saveDialog.getByRole("list", { name: folder })).toBeVisible();
  await saveDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(saveDialog.getByText(`“${name}”已经存在。`)).toBeVisible();
  await saveDialog.getByRole("button", { name: "覆盖" }).click();
  await expect(saveDialog).toBeHidden();

  await page.getByRole("button", { name: "导入配置" }).click();
  const openDialog = page.getByRole("dialog", { name: "导入配置" });
  // The folder is remembered from the export.
  await expect(openDialog.getByRole("list", { name: folder })).toBeVisible();
  await openDialog.getByRole("button", { name }).click();
  await openDialog.getByRole("button", { name: "打开" }).click();
  await expect(openDialog).toBeHidden();
  await expect(page.getByText(/导入完成/)).toBeVisible();
});

test("the model registry can be imported from a file through the file browser", async () => {
  const registryFile = join(import.meta.dirname, "../packages/registry/generated/model-registry.json");
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "Agent" }).click();
  const section = page.getByRole("region", { name: "模型能力数据" });
  await expect(section.getByText(/榜单数据截至 \d{4}-\d{2}-\d{2} · 随 KM0 发布/)).toBeVisible();
  await expect(section.getByRole("link", { name: /Terminal-Bench/ })).toBeVisible();

  await section.getByRole("button", { name: "从文件导入" }).click();
  const dialog = page.getByRole("dialog", { name: "从文件导入" });
  await goTo(dialog, join(registryFile, ".."));
  await dialog.getByRole("button", { name: "model-registry.json" }).click();
  await dialog.getByRole("button", { name: "打开" }).click();
  await expect(page.getByRole("status").filter({ hasText: /已导入截至 .* 的榜单数据/ })).toBeVisible();
  await expect(section.getByText(/从文件导入/).first()).toBeVisible();
  await section.getByRole("button", { name: "恢复内置数据" }).click();
  // The data line, not the intro, which also says the data ships with KM0.
  await expect(section.getByText(/榜单数据截至 \d{4}-\d{2}-\d{2} · 随 KM0 发布/)).toBeVisible();
});
