import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "message-outline.spec.ts",
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:14320",
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: "..",
    command: "PREVIEW_ASSETS=dist bun tests/preview-serve.ts",
    url: "http://127.0.0.1:14320",
    reuseExistingServer: false,
  },
});
