import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:14318",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun tests/serve.ts",
      url: "http://127.0.0.1:14318",
      reuseExistingServer: false,
    },
    {
      command: "bun tests/design-serve.ts",
      url: "http://127.0.0.1:14319",
      reuseExistingServer: false,
    },
  ],
});
