import { spawnSync } from "node:child_process";
import { app } from "electron";
import log from "electron-log/main";
import updaterModule from "electron-updater";
import type { UnsupportedReason, UpdaterPort } from "./services/update-service";

/**
 * electron-updater against the GitHub Releases named in electron-builder.yml, or the generic feed in
 * KM0_UPDATE_FEED (the packaged update test serves one locally; Settings → About shows it). It never
 * downloads or restarts by itself and never shows a dialog: KM0's About page drives it. Returns why it
 * cannot run when it cannot.
 */
export function electronUpdater(): UpdaterPort | UnsupportedReason {
  if (process.env.KM0_FAKE_UPDATE) return fakeUpdater(process.env.KM0_FAKE_UPDATE);
  if (!app.isPackaged) return "development";
  // On Linux only the AppImage can replace itself.
  if (process.platform === "linux" && !process.env.APPIMAGE) return "linux";
  // macOS installs updates only into a signed app.
  if (process.platform === "darwin" && !signed()) return "unsigned";
  const { autoUpdater } = updaterModule;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;
  const feed = process.env.KM0_UPDATE_FEED || null;
  if (feed) autoUpdater.setFeedURL({ provider: "generic", url: feed });
  return {
    feed,
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      const notes = result.updateInfo.releaseNotes;
      return {
        version: result.updateInfo.version,
        notes: typeof notes === "string" ? notes : (notes?.map((note) => note.note ?? "").join("\n\n") ?? null),
      };
    },
    async download(onProgress) {
      const listener = (progress: { percent: number }) => onProgress(progress.percent);
      autoUpdater.on("download-progress", listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off("download-progress", listener);
      }
    },
    install() {
      // Quits through the normal path, so a run still going is asked about first. Silent: on Windows the
      // installer otherwise opens its setup wizard and waits for clicks instead of restarting KM0 (the
      // packaged update test caught it); elsewhere the flag does nothing.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

/**
 * A release that is always newer, for the e2e tests and for looking at the update screens
 * (`KM0_FAKE_UPDATE=1.0.1`). Installing only marks `KM0_FAKE_UPDATE_INSTALLED`; nothing is replaced.
 */
function fakeUpdater(version: string): UpdaterPort {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    async check() {
      await pause(300);
      return { version, notes: `KM0 ${version}\n\n- Fixes found after 1.0.0.` };
    },
    async download(onProgress) {
      for (let percent = 0; percent <= 100; percent += 10) {
        onProgress(percent);
        await pause(150);
      }
    },
    install() {
      process.env.KM0_FAKE_UPDATE_INSTALLED = "1";
    },
  };
}

/** Whether the running macOS app carries a valid code signature. */
function signed(): boolean {
  const bundle = app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/, "");
  return spawnSync("codesign", ["--verify", "--deep", bundle]).status === 0;
}
