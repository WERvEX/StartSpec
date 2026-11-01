import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { NEW, OLD } from "./versions.mjs";

/**
 * The in-app update, for real: install the old packaged build, serve the new one from a local feed
 * (KM0_UPDATE_FEED), then check, download, restart and install from Settings → About, and start again to
 * find the new version with the user's data still there. Linux updates its AppImage, Windows its NSIS
 * install; an unsigned macOS app cannot update itself, so there is nothing to test there.
 */
const release = (version: string) => join(import.meta.dirname, "..", "apps", "desktop", "release", version);
const linux = process.platform === "linux";
const windows = process.platform === "win32";

test.skip(!linux && !windows, "An unsigned macOS app cannot update itself; only Linux and Windows are tested.");

let server: Server;
let feed: string;
const requests: string[] = [];
let installDir: string;
let dataDir: string;

/** The new version's files over HTTP, whole: the updater's differential download falls back to a full one. */
function serve(dir: string): Promise<string> {
  server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
    requests.push(name);
    const path = join(dir, basename(name));
    if (!name || !existsSync(path) || statSync(path).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": statSync(path).size, "accept-ranges": "none" });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`);
    }),
  );
}

/** Install the old version where the test can find it: a copied AppImage, or a silent NSIS install. */
function install(): string {
  installDir = mkdtempSync(join(tmpdir(), "km0-update-install-"));
  if (linux) {
    const appImage = `KM0-${OLD}-x86_64.AppImage`;
    copyFileSync(join(release(OLD), appImage), join(installDir, appImage));
    execSync(`chmod +x "${join(installDir, appImage)}"`);
    return join(installDir, appImage);
  }
  const result = spawnSync(join(release(OLD), `KM0-${OLD}-setup-x64.exe`), ["/S", `/D=${installDir}`]);
  expect(result.status).toBe(0);
  return join(installDir, "KM0.exe");
}

/** The app as installed now: on Linux the updater may have renamed the AppImage to the new version. */
function installed(): string {
  if (windows) return join(installDir, "KM0.exe");
  const appImages = readdirSync(installDir).filter((name) => name.endsWith(".AppImage"));
  expect(appImages).toHaveLength(1);
  return join(installDir, appImages[0] as string);
}

/** KM0 processes of this test (by their data folder), such as the one the updater restarts by itself. */
function ourProcesses(): number[] {
  if (windows) {
    const list = execSync('tasklist /FI "IMAGENAME eq KM0.exe" /FO CSV /NH', { encoding: "utf8" });
    return [...list.matchAll(/"KM0\.exe","(\d+)"/g)].map((match) => Number(match[1]));
  }
  const pids: number[] = [];
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${entry}/environ`, "utf8").includes(`KM0_USER_DATA_DIR=${dataDir}`))
        pids.push(Number(entry));
    } catch {
      // Gone, or not ours to read.
    }
  }
  return pids.filter((pid) => pid !== process.pid);
}

function stopOurProcesses(): void {
  for (const pid of ourProcesses()) {
    try {
      if (windows) execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function launch(executablePath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath,
    args: linux ? ["--no-sandbox"] : [],
    env: {
      ...process.env,
      KM0_USER_DATA_DIR: dataDir,
      KM0_UPDATE_FEED: feed,
      KM0_FAKE_LLM: "1",
      LANG: "zh_CN.UTF-8",
      // No FUSE needed: the AppImage unpacks itself and runs.
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false))
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page };
}

test.beforeAll(async () => {
  for (const version of [OLD, NEW]) {
    expect(existsSync(release(version)), `run \`pnpm e2e:update:build\` to package ${version}`).toBe(true);
  }
  dataDir = mkdtempSync(join(tmpdir(), "km0-update-data-"));
  feed = await serve(release(NEW));
});

test.afterAll(async () => {
  stopOurProcesses();
  await new Promise((resolve) => server?.close(resolve));
});

test(`${OLD} finds ${NEW} on its feed, installs it and starts again with the user's data`, async () => {
  const { app, page } = await launch(install());
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe(OLD);
  // The UI follows the system's language (English on CI's Windows); KM0's own setting makes it Chinese for good.
  await page.getByRole("link", { name: /^(设置|Settings)$/ }).click();
  await page.getByRole("tab").nth(4).click();
  await page.locator("#language").selectOption("zh-CN");
  await expect(page.getByRole("tab", { name: "通用" })).toBeVisible();

  // Something of the user's, to find again after the update.
  await page.getByRole("link", { name: /新建任务/ }).click();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("升级以后数据还在吗");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("从一句话开始");

  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "关于" }).click();
  const section = page.getByRole("region", { name: "更新" });
  await expect(section.getByText(`更新来源：${feed}`)).toBeVisible();
  // The check on start may have found it already; otherwise ask.
  const available = section.getByText(`KM0 ${NEW} 可以更新了。`);
  if (!(await available.isVisible())) await section.getByRole("button", { name: "检查更新" }).click();
  await expect(available).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "test-results/screenshots/update-real-available.png" });

  await section.getByRole("button", { name: "下载" }).click();
  await expect(section.getByText(`${NEW} 已下载，重启 KM0 后安装。`)).toBeVisible({ timeout: 5 * 60_000 });
  expect(requests).toEqual(expect.arrayContaining([expect.stringMatching(/^latest(-linux)?\.yml$/)]));
  expect(requests.some((name) => name.includes(NEW) && /\.(AppImage|exe)$/.test(name))).toBe(true);

  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  await section.getByRole("button", { name: "重启并安装" }).click();
  await exited;

  // The updater starts the new version by itself; that one is not under the test's control, so it is stopped
  // once it shows up (or after a while, when it cannot start here, as on Linux without a sandbox).
  await expect.poll(() => (windows ? ourProcesses().length > 0 : true), { timeout: 3 * 60_000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  stopOurProcesses();

  const next = await launch(installed());
  expect(await next.app.evaluate(({ app }) => app.getVersion())).toBe(NEW);
  await expect(next.page.getByText("升级以后数据还在吗")).toBeVisible();
  await next.page.getByRole("link", { name: "设置" }).click();
  await next.page.getByRole("tab", { name: "关于" }).click();
  await expect(next.page.getByText(`KM0 ${NEW}`).first()).toBeVisible();
  await next.page.screenshot({ path: "test-results/screenshots/update-real-after.png" });
  await next.app.close();
});
