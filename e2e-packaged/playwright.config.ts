import { defineConfig } from "@playwright/test";

/**
 * Tests against packaged builds (`pnpm e2e:update`). Build them first with `pnpm e2e:update:build`, which
 * packages the app twice for this platform as an old and a new version.
 */
export default defineConfig({
  testDir: ".",
  timeout: 10 * 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results/packaged",
});
