import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "abandon-close.spec.ts",
  workers: 1,
  outputDir: "../../.scratch/abandon-unconfirmed-session/playwright",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
    baseURL: "http://127.0.0.1:14327",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
