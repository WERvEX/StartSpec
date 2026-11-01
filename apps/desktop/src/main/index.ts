import { existsSync } from "node:fs";
import { join, parse } from "node:path";
import { createGateway, createSimulatedLlm } from "@km0/core";
import bundledRegistry from "@km0/registry/model-registry.json";
import { type AppNotice, type EmitEvent, IPC_EVENT, IPC_INVOKE, ModelRegistry } from "@km0/shared";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import log from "electron-log/main";
import { openDatabase } from "./db/database";
import { DirectRun } from "./dispatch/direct-run";
import { removeRun } from "./dispatch/inbox";
import { ElectronSecretStore } from "./electron-secrets";
import { electronUpdater } from "./electron-updater";
import { createHandlers } from "./handlers";
import { createDispatcher } from "./ipc/router";
import { nodeExec } from "./node-exec";
import { nodeFiles } from "./node-files";
import { nodeRepoAccess } from "./node-repo-access";
import { nodeRunAccess } from "./node-run-access";
import { AgentStore } from "./services/agent-store";
import { ConfigService } from "./services/config-service";
import { DocumentService } from "./services/document-service";
import { ExecutionService } from "./services/execution-service";
import { FolderRequests } from "./services/folder-requests";
import { HandoffService } from "./services/handoff-service";
import { llmPort } from "./services/llm-port";
import { ProjectService } from "./services/project-service";
import { RegistryService } from "./services/registry-service";
import { RoutingService } from "./services/routing-service";
import { RunRecordStore } from "./services/run-records";
import { RunnerService } from "./services/runner-service";
import { SearchStore } from "./services/search-store";
import { SettingsStore } from "./services/settings-store";
import { UpdateService } from "./services/update-service";

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;

// Keep data in a stable, readable folder: %APPDATA%\KM0, ~/Library/Application Support/KM0, ~/.config/KM0.
app.setName("KM0");
// KM0_USER_DATA_DIR isolates end-to-end test runs from the real profile.
app.setPath("userData", process.env.KM0_USER_DATA_DIR ?? join(app.getPath("appData"), "KM0"));
log.initialize();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

/**
 * How Claude Desktop starts KM0's MCP server: KM0's own executable run as Node with the bundled script, which
 * ships outside the asar (extraResources); in development, the script electron-vite's build wrote.
 */
function mcpSetup(inboxDir: string) {
  const script = app.isPackaged
    ? join(process.resourcesPath, "km0-mcp.cjs")
    : join(app.getAppPath(), "out", "mcp", "km0-mcp.cjs");
  return { command: process.execPath, args: [script, "--dir", inboxDir], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** A text file over HTTPS, for the model registry update; gives up after 30 seconds. */
async function downloadText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
/** Notices raised before the window can show them, such as an error while it reloads. */
const queuedNotices: AppNotice[] = [];

/** Tell the user inside the window; the main process never opens a system dialog. */
function notify(notice: AppNotice): void {
  const contents = mainWindow?.webContents;
  if (contents && !contents.isLoading() && !contents.isCrashed()) {
    contents.send(IPC_EVENT, { event: "app.notice", payload: notice });
  } else {
    queuedNotices.push(notice);
  }
}

// Without these handlers Electron shows its own error box for an uncaught main-process error.
process.on("uncaughtException", (error) => {
  log.error("[main] uncaught exception", error);
  notify({ kind: "error", code: "main_error", detail: error.message });
});
process.on("unhandledRejection", (reason) => {
  log.error("[main] unhandled rejection", reason);
  notify({ kind: "error", code: "main_error", detail: reason instanceof Error ? reason.message : String(reason) });
});

function isAppUrl(url: string): boolean {
  if (DEV_SERVER_URL) return url.startsWith(DEV_SERVER_URL);
  return url.startsWith("file://");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "KM0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.on("did-finish-load", () => {
    for (const notice of queuedNotices.splice(0))
      window.webContents.send(IPC_EVENT, { event: "app.notice", payload: notice });
  });
  // A crashed page comes back by itself and says so, instead of leaving a blank window.
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error(`[main] renderer gone: ${details.reason}`);
    if (details.reason === "clean-exit") return;
    queuedNotices.push({ kind: "error", code: "renderer_restarted", detail: details.reason });
    window.webContents.reload();
  });

  // Links open in the user's browser; the app window never navigates away from the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (DEV_SERVER_URL) void window.loadURL(DEV_SERVER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("web-contents-created", (_event, contents) => {
  // No <webview> tags: the renderer never needs to embed foreign pages.
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  const dataDir = app.getPath("userData");
  const db = openDatabase(join(dataDir, "km0.db"));
  const secrets = new ElectronSecretStore();
  const registry = new RegistryService(db, ModelRegistry.parse(bundledRegistry), downloadText);
  const records = new RunRecordStore(db);
  const settings = new SettingsStore(
    db,
    secrets,
    () => registry.current().registry,
    () => records.all(),
  );
  const gateway = createGateway({
    recordCall: (record) => settings.recordCall(record),
    onModeDetected: (profileId, mode) => {
      if (settings.getModel(profileId).structuredMode === "auto") settings.setStructuredMode(profileId, mode);
    },
  });
  // KM0_FAKE_LLM=1 swaps in a deterministic model for end-to-end tests and demos without an API key.
  const simulated = process.env.KM0_FAKE_LLM === "1" ? createSimulatedLlm({ streamDelayMs: 15 }) : null;
  const llmFor = (projectId: number | null) => simulated ?? llmPort(gateway, settings, projectId);
  const language = () => {
    const preferred = settings.getPreferences().language;
    if (preferred !== "system") return preferred;
    return app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  };
  const emit: EmitEvent = (event, payload) => mainWindow?.webContents.send(IPC_EVENT, { event, payload });
  const search = new SearchStore(db, secrets, {
    // Local MCP servers inherit a minimal safe environment plus the variables the user configured.
    stdio: (command, args, env) =>
      new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...env }, stderr: "ignore" }),
  });
  // Folders are chosen in KM0's own browser inside the window, not in a system dialog.
  const folders = new FolderRequests(emit);
  const files = nodeFiles((path) => shell.showItemInFolder(path));
  // Saving goes through files.save; a download that still happens lands in Downloads without a save dialog.
  session.defaultSession.on("will-download", (_event, item) => {
    const { name, ext } = parse(item.getFilename());
    let target = join(app.getPath("downloads"), `${name}${ext}`);
    for (let n = 2; existsSync(target); n += 1) target = join(app.getPath("downloads"), `${name} (${n})${ext}`);
    item.setSavePath(target);
    item.once("done", (_done, state) => {
      if (state === "completed") notify({ kind: "info", code: "download_saved", detail: target });
    });
  });
  const repo = nodeRepoAccess(() => folders.ask("repo"));
  const projects = new ProjectService(db, llmFor, language, { searchPort: () => search.activePort(), repo });
  const documents = new DocumentService(db, llmFor, language, emit);
  const agents = new AgentStore(db, () => settings.listModels());
  const config = new ConfigService(settings, agents, search);
  const routing = new RoutingService(db, llmFor, language, agents, () => settings.getRoutingRules().rules, {
    registry: () => registry.current().registry,
    records,
    pastQuota: () => settings.pastQuota(),
  });
  const handoff = new HandoffService(db, routing, language);
  const runner = new RunnerService(
    db,
    nodeRunAccess(() => folders.ask("run")),
    routing,
    llmFor,
    language,
    () => (simulated ? "simulated" : settings.profileForRole("planner").model),
  );
  const execution = new ExecutionService(
    db,
    nodeExec(),
    settings,
    routing,
    handoff,
    runner,
    language,
    join(dataDir, "runs"),
    (run) => emit("execution.update", run),
    {
      inboxDir: join(dataDir, "dispatch"),
      mcp: mcpSetup(join(dataDir, "dispatch")),
      version: app.getVersion(),
      startRun: (options) => new DirectRun(options),
      forget: (runId) => removeRun(join(dataDir, "dispatch"), runId),
    },
  );
  const updaterPort = electronUpdater();
  const updates = new UpdateService(
    typeof updaterPort === "string" ? null : updaterPort,
    app.getVersion(),
    language,
    (state) => emit("update.state", state),
    typeof updaterPort === "string" ? updaterPort : "development",
  );
  // A quiet check shortly after start, when the preference allows it; the fake release (e2e) at once.
  setTimeout(
    () => void updates.checkOnStart(settings.getPreferences().autoUpdate),
    process.env.KM0_FAKE_UPDATE ? 500 : 8_000,
  );
  // Closing the window while runs are going asks first (in the page); `app.quit` stops them and closes.
  let quitting = false;
  const quit = async () => {
    quitting = true;
    await execution.stopAll();
    app.quit();
  };

  const dispatch = createDispatcher(
    createHandlers({
      settings,
      projects,
      documents,
      routing,
      handoff,
      runner,
      agents,
      search,
      config,
      registry,
      records,
      execution,
      updates,
      quit,
      repo,
      files,
      folders,
      gateway,
      appInfo: () => ({
        name: "KM0",
        version: app.getVersion(),
        platform: process.platform,
        dataDir,
        secureStorage: secrets.secure,
        simulatedModel: process.env.KM0_FAKE_LLM === "1",
      }),
    }),
    (channel, error) => log.warn(`[ipc] ${channel} failed (${error.kind}): ${error.message}`),
  );

  ipcMain.handle(IPC_INVOKE, (event, payload: { channel?: unknown; input?: unknown } | undefined) => {
    // Only our own page may call into the main process.
    const frameUrl = event.senderFrame?.url ?? "";
    if (!isAppUrl(frameUrl)) throw new Error("Rejected IPC call from an unexpected origin");
    return dispatch(payload?.channel, payload?.input);
  });

  mainWindow = createWindow();
  mainWindow.on("close", (event) => {
    if (quitting || execution.runningCount() === 0) return;
    event.preventDefault();
    emit("app.quitRequest", { running: execution.runningCount() });
  });
  mainWindow.on("closed", () => {
    folders.cancel();
    mainWindow = null;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
  app.on("will-quit", () => db.close());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
