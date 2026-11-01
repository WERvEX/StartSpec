import { z } from "zod";

export const Language = z.enum(["system", "zh-CN", "en"]);
export type Language = z.infer<typeof Language>;

export const Theme = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;

export const Preferences = z.object({
  language: Language,
  theme: Theme,
  /** Look for a new version on start; installing always waits for the user. */
  autoUpdate: z.boolean().default(true),
});
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = { language: "system", theme: "system", autoUpdate: true };

/**
 * The in-app updater (GitHub Releases). Everything it says is shown inside KM0: no system dialog asks to
 * download or restart.
 */
export const UpdateState = z.object({
  status: z.enum(["unsupported", "idle", "checking", "available", "current", "downloading", "downloaded", "error"]),
  currentVersion: z.string(),
  /** The newer version, once one is found. */
  version: z.string().nullable(),
  /** Its release notes, as published. */
  notes: z.string().nullable(),
  /** Download progress, 0 to 100. */
  percent: z.number().nullable(),
  /** Why updating is unsupported here, or what went wrong. */
  detail: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** Where updates come from when it is not KM0's GitHub releases (KM0_UPDATE_FEED); shown so it never goes unnoticed. */
  feed: z.string().nullable(),
});
export type UpdateState = z.infer<typeof UpdateState>;

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  dataDir: z.string(),
  /** Whether the OS credential store protects API keys (false on Linux without a keyring). */
  secureStorage: z.boolean(),
  /** A deterministic stand-in model is active (KM0_FAKE_LLM=1); no API key is needed. */
  simulatedModel: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfo>;
