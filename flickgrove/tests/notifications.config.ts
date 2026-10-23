import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const owned = resolve("../.scratch/orc-user-handoff-notifications");
mkdirSync(`${owned}/home`, { recursive: true });
const env = {
  ...process.env,
  HOME: `${owned}/home`,
  CODEX_HOME: `${owned}/home/codex`,
  XDG_CONFIG_HOME: `${owned}/home/config`,
  XDG_DATA_HOME: `${owned}/home/data`,
  PI_CODING_AGENT_DIR: `${owned}/home/pi`,
  GROVE_TEST_ASSETS: `${owned}/assets`,
};
export default defineConfig({
  testDir: ".",
  testMatch: "notifications.spec.ts",
  workers: 1,
  outputDir: `${owned}/browser-results`,
  timeout: 60000,
  use: {
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    launchOptions: { env },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: resolve("."),
    command: `bun run build --outDir '${owned}/assets' && bun tests/design-serve.ts`,
    url: "http://127.0.0.1:14319",
    reuseExistingServer: false,
    env,
  },
});
