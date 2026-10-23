import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: ".",
  testMatch:
    process.env.GROVE_TPS_LIVENESS === "1"
      ? "tps-liveness.spec.ts"
      : "tps.spec.ts",
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:14328",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: resolve(import.meta.dirname, ".."),
    command:
      "bun run build --outDir ../.scratch/codex-tps-workspace/assets && bun tests/tps-serve.ts",
    url: "http://127.0.0.1:14328",
    reuseExistingServer: false,
  },
});
