import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
let process: ChildProcess, origin: string;
test.beforeAll(async () => {
  process = spawn(
    "bun",
    [fileURLToPath(new URL("./mixed-serve.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  origin = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: process.stdout! });
    lines.on("line", (line) => {
      if (line.startsWith("http://")) {
        lines.close();
        resolve(line);
      }
    });
    process.once("exit", (code) =>
      reject(Error(`Owned fixture exited ${code}`)),
    );
  });
});
test.afterAll(async () => {
  if (process?.exitCode === null) {
    process.kill("SIGTERM");
    await new Promise<void>((resolve) => process.once("exit", () => resolve()));
  }
});
for (const width of [1440, 390])
  test(`${width} backend/provider models, native Pi reading and missing-account recovery`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(
      dialog.getByRole("button", { name: "Mixed fixture", exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Orc backend", { exact: true }).selectOption("pi");
    await expect(dialog.getByLabel("Orc model", { exact: true })).toContainText(
      "Pi fixture model",
    );
    await expect(
      dialog.getByLabel("Orc model", { exact: true }),
    ).not.toContainText("Sol");
    await dialog
      .getByLabel("Worker backend", { exact: true })
      .selectOption("codex");
    await expect(
      dialog.getByLabel("Worker model", { exact: true }),
    ).toContainText("Sol");
    await dialog
      .getByRole("button", { name: "Mixed fixture", exact: true })
      .click();
    const before = (
      await (await page.request.get(origin + "/fixture/info")).json()
    ).modelCalls;
    await dialog
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".session-model")).toContainText(
      "Pi · fixture/fixture / off",
    );
    await expect(
      page.getByRole("button", { name: "Weekly usage", exact: true }),
    ).toHaveCount(0);
    expect(
      (await (await page.request.get(origin + "/fixture/info")).json())
        .modelCalls,
    ).toBe(before);
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await composer.fill(`Owned browser ${width}`);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByText("Owned Pi fixture reply", { exact: true }),
    ).toBeVisible();
    await page.locator(".session-model").click();
    const settings = page.getByRole("dialog", {
      name: "Session settings",
      exact: true,
    });
    await expect(
      settings.getByRole("combobox", { name: "Model", exact: true }),
    ).toContainText("Pi fixture model");
    await expect(
      settings.getByRole("combobox", { name: "Model", exact: true }),
    ).not.toContainText("Sol");
    await expect(
      settings.getByRole("combobox", { name: "Backend", exact: true }),
    ).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(settings).toBeHidden();
    const calls = (
      await (await page.request.get(origin + "/fixture/info")).json()
    ).modelCalls;
    await page.request.post(origin + "/fixture/restart");
    await page.reload();
    await expect(
      page.getByText("Owned Pi fixture reply", { exact: true }),
    ).toBeVisible();
    await expect(composer).toBeEnabled();
    expect(
      (await (await page.request.get(origin + "/fixture/info")).json())
        .modelCalls,
    ).toBe(calls);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const preferences = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(
      preferences.getByLabel("Orc backend", { exact: true }),
    ).toHaveValue("pi");
    await page.request.post(origin + "/fixture/auth", {
      data: { enabled: false },
    });
    await preferences
      .getByRole("button", { name: "Refresh models", exact: true })
      .click();
    await expect(
      preferences.getByText(/No Pi models are available/),
    ).toBeVisible();
    await expect(
      preferences.getByLabel("Orc backend", { exact: true }),
    ).toHaveValue("pi");
    await expect(
      preferences.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    await page.request.post(origin + "/fixture/auth", {
      data: { enabled: true },
    });
    await preferences
      .getByRole("button", { name: "Refresh models", exact: true })
      .click();
    await expect(
      preferences.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
  });
