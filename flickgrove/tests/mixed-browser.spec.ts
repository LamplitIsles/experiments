import { openSidebar, openSettings } from "./browser-actions";
import { chooseOption } from "./choice-interactions";
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
    await openSidebar(page);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(
      dialog.getByRole("option", { name: "Mixed fixture", exact: true }),
    ).toBeVisible();
    await chooseOption(
      page,
      dialog.getByLabel("Orc backend", { exact: true }),
      "pi",
    );
    await expect(dialog.getByLabel("Orc model", { exact: true })).toContainText(
      "Pi fixture model",
    );
    await expect(
      dialog.getByLabel("Orc model", { exact: true }),
    ).not.toContainText("Sol");
    await chooseOption(
      page,
      dialog.getByLabel("Worker backend", { exact: true }),
      "codex",
    );
    await expect(
      dialog.getByLabel("Worker model", { exact: true }),
    ).toContainText("Sol");
    await dialog
      .getByRole("option", { name: "Mixed fixture", exact: true })
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
    await openSettings(page);
    const preferences = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(
      preferences.getByLabel("Orc backend", { exact: true }),
    ).toContainText("Pi");
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
    ).toContainText("Pi");
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

for (const width of [1440, 390])
  test(`${width} Pi resumes accepted work after restart and Stop keeps cancelled inputs visible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/hold", {
      data: { enabled: true },
    });
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "New session", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await chooseOption(
      page,
      dialog.getByLabel("Orc backend", { exact: true }),
      "pi",
    );
    await chooseOption(
      page,
      dialog.getByLabel("Worker backend", { exact: true }),
      "codex",
    );
    await dialog
      .getByRole("option", { name: "Mixed fixture", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(dialog).toBeHidden();
    await expect(page.locator(".first-message")).toBeVisible();
    const text = `Accepted work ${width}`;
    await composer.fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Stop Orc", exact: true }),
    ).toBeEnabled();
    const before = (
      await (await page.request.get(origin + "/fixture/info")).json()
    ).modelCalls;
    await page.request.post(origin + "/fixture/restart");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Stop Orc", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(origin + "/fixture/info")).json())
            .modelCalls,
      )
      .toBeGreaterThan(before);
    await expect(page.getByText(/Send a message to resume/)).toHaveCount(0);
    await composer.fill(`Queued work ${width}`);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByText(`Queued work ${width}`, { exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
    await expect(
      page
        .getByText("Accepted input was cancelled by Stop.", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop Orc", exact: true }),
    ).toHaveCount(0);
    expect(
      await page
        .locator("body")
        .evaluate((body) => body.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-stopped.png`,
      fullPage: true,
    });
    const stoppedId = await page.evaluate(
      () => history.state.grove.details.at(-1) as string,
    );
    const readStopped = async () =>
      (
        await (
          await page.request.get(
            origin + "/fixture/info?" + new URLSearchParams({ id: stoppedId }),
          )
        ).json()
      ).detail;
    const stoppedDetail = await readStopped();
    const stoppedInputs = [text, `Queued work ${width}`].map(
      (body) =>
        stoppedDetail.messages.find((m: { text: string }) => m.text === body)
          .clientId,
    );
    expect(new Set(stoppedInputs).size).toBe(2);
    const expectCancellation = async () => {
      const detail = await readStopped();
      for (const id of stoppedInputs)
        expect(
          detail.deliveries.find((d: { id: string }) => d.id === id),
        ).toMatchObject({
          status: "sent",
          error: "Accepted input was cancelled by Stop.",
        });
      await expect(
        page.getByText("Accepted input was cancelled by Stop.", {
          exact: true,
        }),
      ).toHaveCount(2);
    };
    await expectCancellation();
    // Reload triggers the actual selected-detail synchronization before another input.
    await page.reload();
    await expect(composer).toBeEnabled();
    await expectCancellation();
    const stoppedCalls = (
      await (await page.request.get(origin + "/fixture/info")).json()
    ).modelCalls;
    await page.request.post(origin + "/fixture/restart");
    await page.reload();
    await expect(composer).toBeEnabled();
    await expectCancellation();
    expect(
      (await (await page.request.get(origin + "/fixture/info")).json())
        .modelCalls,
    ).toBe(stoppedCalls);
    // Select another owned session, then return to the stopped conversation.
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .first()
      .click();
    await chooseOption(
      page,
      dialog.getByLabel("Orc backend", { exact: true }),
      "Codex",
    );
    await dialog
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(composer).toBeEnabled();
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await page.locator(`.session-open[data-agent-id="${stoppedId}"]`).click();
    await expect(composer).toBeEnabled();
    await expectCancellation();
    await page.request.post(origin + "/fixture/hold", {
      data: { enabled: false },
    });
    await composer.fill(`Continue normally ${width}`);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByText("Owned Pi fixture reply", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-settled.png`,
      fullPage: true,
    });
  });

for (const width of [1440, 390])
  test(`${width} searchable project and model choices retain identity, drafts and navigation layers`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/choices", {
      data: { enabled: true },
    });
    await page.goto(origin);
    await openSidebar(page);
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press("n");
    const dialog = page.getByRole("dialog", {
        name: "New session",
        exact: true,
      }),
      search = dialog.getByRole("combobox", {
        name: "Search projects…",
        exact: true,
      });
    await expect(search).toBeFocused();
    await expect(
      page.locator(`[id="${await search.getAttribute("aria-controls")}"]`),
    ).toHaveAttribute("role", "listbox");
    await expect(
      dialog.getByRole("option").filter({ hasNotText: "Saved history" }),
    ).toHaveCount(36);
    await search.fill("nothing matches this project");
    await expect(
      dialog.getByText("No matching registered projects"),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "New session", exact: true }),
    ).toBeDisabled();
    await search.press("Enter");
    await expect(dialog).toBeVisible();
    await search.fill("project-19");
    const project = dialog
      .getByRole("option", { name: /Orbit project 19/ })
      .filter({ hasNotText: "Saved history" });
    await expect(project).toContainText("project-19");
    await search.press("Enter");
    await expect(project).toHaveAttribute("data-checked", "true");
    await expect(dialog).toBeVisible();
    await search.fill("Orbit project");
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-projects-expanded.png`,
    });
    await search.fill("project-19");
    await dialog
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Search title or first message…" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("project-19");
    await expect(search).toBeFocused();
    await expect(project).toHaveAttribute("data-checked", "true");
    await chooseOption(
      page,
      dialog.getByRole("combobox", { name: "Orc backend", exact: true }),
      "Pi",
    );
    const modelChoice = dialog.getByRole("combobox", {
      name: "Orc model",
      exact: true,
    });
    await modelChoice.click();
    const modelSearch = page.getByRole("combobox", {
      name: "Search orc model",
      exact: true,
    });
    await expect(modelSearch).toBeFocused();
    await expect(
      page.getByRole("option").filter({ hasText: "long-model-" }),
    ).toHaveCount(40);
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-models-expanded.png`,
    });
    const popup = page.locator("[data-choice-layer]");
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      width === 390 ? 844 : 900,
    );
    const list = popup.getByRole("listbox");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    await modelSearch.fill("zzzzzzzzzz");
    await expect(popup.getByText("No models found.")).toBeVisible();
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-models-empty.png`,
    });
    await modelSearch.fill("long-model-29");
    await modelSearch.press("ArrowDown");
    await modelSearch.press("Enter");
    await expect(modelChoice).toContainText("Long model 29");
    await expect(modelChoice).toBeFocused();
    await modelChoice.press("Enter");
    await expect(modelSearch).toBeVisible();
    await expect(
      page.locator(`[id="${await modelSearch.getAttribute("aria-controls")}"]`),
    ).toHaveAttribute("role", "listbox");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(modelChoice).toBeFocused();
    await modelChoice.click();
    await expect(popup).toBeVisible();
    await page.goBack();
    await expect(popup).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(modelChoice).toContainText("Long model 29");
    await expect(modelChoice).toBeFocused();
    await page.goForward();
    await expect(popup).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("combobox", { name: "Orc reasoning effort", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: "off", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-effort-expanded.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await dialog
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".session-model")).toContainText("long-model-29");
    const settingsButton = page.getByRole("button", {
      name: "Session settings",
      exact: true,
    });
    await settingsButton.click();
    const settings = page.getByRole("dialog", {
      name: "Session settings",
      exact: true,
    });
    const selectedModel = settings.getByRole("combobox", {
      name: "Model",
      exact: true,
    });
    await chooseOption(page, selectedModel, "long-model-10");
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".session-model")).toContainText("long-model-29");
    await page.request.post(origin + "/fixture/choices", {
      data: { enabled: false },
    });
    await settingsButton.click();
    await expect(selectedModel).toContainText("unavailable");
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: `../.scratch/pi-durable-runtime/${width}-model-unavailable.png`,
    });
    await page.keyboard.press("Escape");
  });
