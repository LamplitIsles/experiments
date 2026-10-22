import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "environments.spec.ts",
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:14325",
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command:
      "bun run build --outDir ../.scratch/codex-project-environments/assets && bun tests/environments-serve.ts",
    url: "http://127.0.0.1:14325",
    reuseExistingServer: false,
  },
});
