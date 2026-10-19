import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "mixed-browser.spec.ts",
  workers: 1,
  use: {
    channel: "chrome",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
    trace: "retain-on-failure",
  },
  timeout: 30000,
});
