import { expect, test } from "@playwright/test";

test("create, delegate, read a Worker, insert a skill and close the tree through Orc", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("FlickGrove", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Create session" }).click();
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
  await input.fill("$");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("$to-orc-impl ");
  await input.fill("/close");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Workers first");
  await input.fill("Close the workers");
  await input.press("Enter");
  await expect(
    page.getByText("Workers are closed.", { exact: true }),
  ).toBeVisible();
  await input.fill("/close");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByText("A place for your next task.")).toBeVisible();
});

test("multiple questions preserve drafts, contextual arrow navigation and explicit send", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Create session" }).click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Ask me questions");
  await input.press("Enter");
  const navigation = page.getByRole("group", { name: "Question navigation" });
  await expect(
    page.getByText("Question 1 of 8", { exact: true }),
  ).toBeVisible();
  const answer = page.getByRole("textbox", { name: "Your answer" });
  await answer.fill("My custom choice");
  await page.screenshot({
    path: "../.scratch/flickgrove/questions.png",
    animations: "disabled",
  });
  await answer.press("ArrowRight");
  await expect(
    page.getByText("Question 1 of 8", { exact: true }),
  ).toBeVisible();
  await navigation.focus();
  await navigation.press("ArrowRight");
  await expect(
    page.getByText("Question 2 of 8", { exact: true }),
  ).toBeVisible();
  await navigation.press("ArrowLeft");
  await expect(answer).toHaveValue("My custom choice");
  await page.reload();
  await expect(answer).toHaveValue("My custom choice");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(
    page.getByText("Question 2 of 8", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All questions" }).click();
  await expect(
    page.getByRole("button", { name: /1.*Question 1.*Sent/ }),
  ).toBeVisible();
});

test("settings affect new sessions, Markdown stays safe and offline reload restores the reading surface", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({
    path: "../.scratch/flickgrove/settings.png",
    animations: "disabled",
  });
  const orc = page.locator(".role-settings").first();
  await orc.getByRole("checkbox", { name: "Fast", exact: true }).check();
  await orc
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("luna");
  await expect(
    orc.getByRole("combobox", { name: "Reasoning effort", exact: true }),
  ).toHaveValue("low");
  await expect(
    orc.getByRole("checkbox", { name: "Fast", exact: true }),
  ).not.toBeChecked();
  await expect(
    orc.getByRole("checkbox", { name: "Fast", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".model-note")).toHaveText("luna / low");
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
  await expect(input).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Draft for later");
  await page.screenshot({
    path: "../.scratch/flickgrove/desktop.png",
    fullPage: true,
  });
});

test("N opens the project chooser with typing focus in search", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New session", exact: true }).first(),
  ).toBeEnabled();
  await page.locator("body").click({ position: { x: 100, y: 70 } });
  await page.keyboard.press("n");
  const search = page.getByRole("textbox", { name: "Search projects" });
  await expect(search).toBeFocused();
  await page.keyboard.type("Beta");
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeFocused();
});
