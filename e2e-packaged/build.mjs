#!/usr/bin/env node
// Package the app twice for this platform, as the old and the new version of the update test. Run
// `pnpm build` first; the installers land in apps/desktop/release/<version>/.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { NEW, OLD } from "./versions.mjs";

const target = { linux: ["--linux", "AppImage"], win32: ["--win", "nsis"], darwin: ["--mac", "zip"] }[process.platform];
if (!target) throw new Error(`No update test on ${process.platform}.`);
for (const version of [OLD, NEW]) {
  const result = spawnSync(
    "pnpm",
    ["exec", "electron-builder", ...target, "--publish", "never", `-c.extraMetadata.version=${version}`],
    {
      cwd: join(import.meta.dirname, "..", "apps", "desktop"),
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
