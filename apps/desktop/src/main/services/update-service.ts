import type { Language } from "@km0/core";
import { AppError, type UpdateState } from "@km0/shared";

/** What the updater can do; electron-updater in the packaged desktop app, a fake in tests. */
export interface UpdaterPort {
  /** The newer release, or null when this is the latest. */
  check(): Promise<{ version: string; notes: string | null } | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quit and install the downloaded version. */
  install(): void;
  /** The update source when it is not KM0's GitHub releases. */
  feed?: string | null;
}

const TEXT = {
  "zh-CN": {
    development: "开发版本不自动更新。",
    web: "网页调试版总是最新的，不需要更新。",
    linux: "只有 AppImage 版本能在应用内更新；其他安装方式请重新下载。",
    unsigned: "这个 macOS 版本没有签名，不能在应用内更新；请从发布页下载新版本。",
    nothing: "还没有下载新版本。",
  },
  en: {
    development: "Development builds do not update themselves.",
    web: "The browser debug build is always current.",
    linux: "Only the AppImage updates itself; reinstall other builds from the download page.",
    unsigned: "This macOS build is unsigned and cannot update itself; download the new version from the release page.",
    nothing: "No new version has been downloaded yet.",
  },
} as const;

export type UnsupportedReason = "development" | "web" | "linux" | "unsigned";

/**
 * Updates from GitHub Releases, shown and confirmed inside KM0. Checking can happen on start (a
 * preference); downloading and restarting only when the user asks.
 */
export class UpdateService {
  private current: UpdateState;

  constructor(
    private readonly port: UpdaterPort | null,
    currentVersion: string,
    private readonly language: () => Language,
    private readonly emit: (state: UpdateState) => void = () => undefined,
    /** Why there is no port, when there is none. */
    unsupported: UnsupportedReason = "development",
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.current = {
      status: port ? "idle" : "unsupported",
      currentVersion,
      version: null,
      notes: null,
      percent: null,
      detail: port ? null : TEXT[language()][unsupported],
      checkedAt: null,
      feed: port?.feed ?? null,
    };
  }

  state(): UpdateState {
    return this.current;
  }

  async check(): Promise<UpdateState> {
    if (!this.port || this.current.status === "checking" || this.current.status === "downloading") return this.current;
    this.set({ status: "checking", detail: null });
    try {
      const found = await this.port.check();
      return this.set(
        found
          ? { status: "available", version: found.version, notes: found.notes, checkedAt: this.now() }
          : { status: "current", version: null, notes: null, checkedAt: this.now() },
      );
    } catch (error) {
      return this.set({ status: "error", detail: message(error), checkedAt: this.now() });
    }
  }

  async download(): Promise<UpdateState> {
    if (!this.port || this.current.status !== "available") return this.current;
    this.set({ status: "downloading", percent: 0 });
    try {
      await this.port.download((percent) => this.set({ percent: Math.round(percent) }));
      return this.set({ status: "downloaded", percent: 100 });
    } catch (error) {
      return this.set({ status: "error", detail: message(error), percent: null });
    }
  }

  install(): void {
    if (!this.port || this.current.status !== "downloaded") {
      throw new AppError("conflict", TEXT[this.language()].nothing);
    }
    this.port.install();
  }

  /** The check on start, when the preference allows it; failures stay quiet until the user looks. */
  async checkOnStart(enabled: boolean): Promise<void> {
    if (enabled) await this.check();
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.current = { ...this.current, ...patch };
    this.emit(this.current);
    return this.current;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
