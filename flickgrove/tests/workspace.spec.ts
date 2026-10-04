import { expect, test } from "@playwright/test";
import { newSession, openSettings, createSession } from "./browser-actions";

test("Worker reports stay in the timeline as one folded incoming card, including after Worker closure", async ({
  page,
}) => {
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Build a reader");
  await input.press("Enter");
  await expect(
    page.getByText("The reader is ready.", { exact: true }),
  ).toBeVisible();
  await input.fill("Request Worker report");
  await input.press("Enter");
  const report = page.locator(".worker-report");
  await expect(report).toHaveCount(1);
  await expect(report.locator("summary")).toHaveAccessibleName(
    "Worker report · Reader",
  );
  await expect(report).not.toHaveAttribute("open");
  await expect(
    report.getByText("Full diagnostic details.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "Full diagnostic details." }),
  ).toHaveCount(0);
  await report.locator("summary").click();
  await expect(
    report.getByText("Full diagnostic details.", { exact: true }),
  ).toBeVisible();
  await report.locator("summary").click();
  await expect(
    report.getByText("Full diagnostic details.", { exact: true }),
  ).toHaveCount(0);
  await input.fill("Worker “Reader” reports:\n\nThis was typed by the user.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "This was typed by the user." }),
  ).toHaveCount(1);
  await expect(report).toHaveCount(1);
  await input.fill("Close the workers");
  await input.press("Enter");
  await expect(
    page.getByText("Workers are closed.", { exact: true }),
  ).toBeVisible();
  await expect(report.locator("summary")).toContainText("Reader");
  await report.locator("summary").click();
  await expect(
    report.getByText("The report preserves its complete content.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-shadcn/worker-report.png",
    animations: "disabled",
  });
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
});

test("create, delegate, read a Worker, insert a skill and close the tree through Orc", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("FlickGrove", { exact: true })).toBeVisible();
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Build a reader");
  await input.press("Enter");
  await expect(
    page.getByText("The reader is ready.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand Workers" }).click();
  await page.getByRole("button", { name: "Open Reader Worker" }).click();
  await expect(page.getByText("Read-only conversation")).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove/worker.png",
    animations: "disabled",
  });
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Send instructions through Orc" })
    .click();
  await input.fill("");
  await input.press("$");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await expect(page.getByRole("option", { name: /to-orc-impl/ })).toBeVisible();
  await page.getByRole("combobox", { name: "Search skills…" }).press("Tab");
  await expect(input).toHaveValue("$to-orc-impl ");
  await page.keyboard.press("Alt+x");
  await expect(page.getByRole("alert")).toContainText("Workers first");
  await input.fill("Close the workers");
  await input.press("Enter");
  await expect(
    page.getByText("Workers are closed.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("A place for your next task.")).toBeVisible();
});

test("all pending questions preserve drafts and use one explicit batch submission", async ({
  page,
}) => {
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Ask me questions");
  await input.press("Enter");
  await expect(page.locator(".question-card")).toHaveCount(1);
  const answer = page.getByRole("textbox", {
    name: "Your answer · Question 1",
    exact: true,
  });
  await answer.fill("My custom choice");
  await answer.press("ArrowRight");
  await expect(answer).toHaveValue("My custom choice");
  await page.reload();
  await expect(answer).toHaveValue("My custom choice");
  await page
    .getByRole("button", { name: "Send all answers", exact: true })
    .click();
  await expect(page.locator(".question-card")).toHaveCount(0);
  await expect(page.locator(".answered-summary")).toContainText(
    "My custom choice",
  );
  await expect(page.locator(".sent-answer").first()).toHaveText(
    "My custom choice",
  );
});

test("settings affect new sessions, Markdown stays safe and offline reload restores the reading surface", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await openSettings(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove/settings.png",
    animations: "disabled",
  });
  await expect(
    page.getByRole("switch", { name: "Fast", exact: true }),
  ).toHaveCount(1);
  const orc = page.locator(".role-settings").first();
  await page.getByRole("switch", { name: "Fast", exact: true }).check();
  await orc
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("luna");
  await expect(
    orc.getByRole("combobox", { name: "Reasoning effort", exact: true }),
  ).toHaveValue("low");
  await expect(
    page.getByRole("switch", { name: "Fast", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Fast", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save changes" }).click();
  await newSession(page);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await createSession(page);
  await expect(page.locator(".detail-model")).toHaveText("luna / low");
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Show Markdown");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Reader notes" }),
  ).toBeVisible();
  const link = page.getByRole("link", { name: "Documentation" });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { injected?: boolean }).injected,
    ),
  ).toBeUndefined();
  await input.fill("Draft for later");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => resolve(),
          { once: true },
        ),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("Connection lost. Reconnecting…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reader notes" }),
  ).toBeVisible();
  await expect(input).toHaveValue("Draft for later");
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Draft for later");
  await page.screenshot({
    path: "../.scratch/flickgrove/desktop.png",
    fullPage: true,
  });
});

test("N focuses creation, I focuses Composer, and list navigation survives detail", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeEnabled();
  await page.locator("body").click({ position: { x: 100, y: 70 } });
  await page.keyboard.press("n");
  const search = page.getByRole("textbox", { name: "Search projects" });
  await expect(search).toBeFocused();
  await page.keyboard.type("Beta");
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: /Create on/ })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeFocused();
  const composer = page.getByRole("textbox", { name: "Message Orc" });
  await composer.fill("draft");
  await page.locator(".role-project").click();
  await expect(composer).not.toBeFocused();
  await page.keyboard.press("i");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("draft");
  await composer.press("i");
  await expect(composer).toHaveValue("drafti");
  const previous = await page
    .locator(".session-item.active .session-open")
    .getAttribute("data-agent-id");
  await page.keyboard.press("Escape");
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator(".session-item.active .session-open"),
  ).not.toHaveAttribute("data-agent-id", previous!);
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
});

test("Tab completes without moving focus, skill search preserves drafts, and close toast expires", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await newSession(page);
  await expect(
    page.getByRole("textbox", { name: "Search projects" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Draft before skill ");
  await input.press("Tab");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Draft before skill ");
  await input.press("$");
  const search = page.getByRole("combobox", { name: "Search skills…" });
  await expect(search).toBeFocused();
  await expect(input).toHaveValue("Draft before skill ");
  await search.fill("no-such-skill");
  await search.press("Tab");
  await expect(search).toBeFocused();
  await expect(input).toHaveValue("Draft before skill ");
  await search.press("Escape");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Draft before skill ");
  await input.press("$");
  await search.fill("toorc");
  await search.press("Tab");
  await expect(input).toHaveValue("Draft before skill $to-orc-impl ");
  await expect(input).toBeFocused();
  await input.fill("/cl");
  await input.press("Tab");
  await expect(input).toHaveValue("/cl");
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeVisible();
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await page.mouse.move(0, 0); // Sonner pauses its duration while hovered.
  await expect(page.getByText("Tree closed.", { exact: true })).toHaveCount(0, {
    timeout: 6500,
  });
  expect(errors).toEqual([]);
});

test("Orc closure of a running Worker shows Closing and automatically removes it after the final report", async ({
  page,
}) => {
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Start a long Worker");
  await input.press("Enter");
  await expect(
    page.getByText("Long Worker started.", { exact: true }),
  ).toBeVisible();
  await input.fill("Close the workers");
  await input.press("Enter");
  await expect(
    page.getByText("Workers are closed.", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".session-item.active")
    .getByRole("button", { name: "Expand Workers" })
    .click();
  await page.getByRole("button", { name: "Open Long Reader Worker" }).click();
  await expect(page.locator(".detail-status")).toContainText("Closing");
  await expect(
    page.getByText("Waiting for current work to finish", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-shadcn/worker-closing.png",
    animations: "disabled",
  });
  await page.locator(".owner-link").click();
  await input.fill("Finish the long Worker");
  await input.press("Enter");
  await expect(
    page.getByText("Long Worker finished.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Long Reader Worker" }),
  ).toHaveCount(0);
  const report = page
    .locator(".worker-report")
    .filter({ hasText: "Long Worker final report" });
  await expect(report).toHaveCount(1);
  await report.locator("summary").click();
  await expect(report.locator(".report-content")).toContainText(
    "Long Worker final report",
  );
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
});

test("Orc titles edit in place, cancel safely, retain failed drafts and persist across reload", async ({
  page,
}) => {
  let failTitle = false;
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (failTitle && frame.call?.member === "rename") {
        failTitle = false;
        ws.send(
          JSON.stringify({
            type: "error",
            id: frame.id,
            error: "Title save failed",
          }),
        );
      } else server.send(raw);
    });
  });
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  const title = page.getByRole("textbox", {
    name: "Session title",
    exact: true,
  });
  await expect(title).toBeFocused();
  await title.fill("Cancelled edit");
  await title.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New session", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await title.fill(" ");
  await expect(page.getByRole("button", { name: "Save title" })).toBeDisabled();
  await title.fill("Reader implementation");
  failTitle = true;
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(title).toHaveValue("Reader implementation");
  await expect(
    page.getByText("Title save failed", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(title).toHaveValue("Reader implementation");
  await expect(
    page.getByText("Title save failed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-shadcn/title-edit.png",
    animations: "disabled",
  });
  await expect(page.locator(".title-edit")).toContainText("Title save failed");
  await page.getByRole("button", { name: "Save title" }).press("Escape");
  await expect(
    page.getByRole("heading", { name: "New session", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await title.fill("Reader implementation");
  await title.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Reader implementation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open Reader implementation Orc",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".user-message")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Reader implementation", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Build a reader");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("The reader is ready.", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".session-item.active")
    .getByRole("button", { name: "Expand Workers" })
    .click();
  await page
    .getByRole("button", { name: "Open Reader Worker", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit title", exact: true }),
  ).toHaveCount(0);
  await page.locator(".owner-link").click();
  const composer = page.getByRole("textbox", { name: "Message Orc" });
  await composer.fill("Close the workers");
  await composer.press("Enter");
  await expect(
    page.getByText("Workers are closed.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
});
