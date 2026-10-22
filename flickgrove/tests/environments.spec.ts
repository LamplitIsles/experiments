import { expect, test } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`environment project history, errors, Pi restriction and drafts at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await newSession(page);
    const dialog = page.getByRole("dialog");
    const environment = page.getByRole("button", {
      name: "Execution environment",
      exact: true,
    });
    await expect(environment).toBeVisible();
    await expect(
      dialog.getByRole("option", { name: "Same project", exact: true }),
    ).toBeVisible();
    await environment.click();
    await page
      .getByRole("option", { name: "Mac studio", exact: false })
      .click();
    await expect(
      dialog.getByRole("listbox", { name: "Project" }),
    ).toHaveAttribute("aria-busy", "true");
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/loading-${viewport.width}.png`,
    });
    const search = page.getByRole("combobox", { name: "Search projects…" });
    await expect(
      dialog.getByRole("option", { name: "Same project", exact: true }),
    ).toBeVisible();
    await search.fill("same");
    await search.press("Enter");
    await expect(dialog).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/project-${viewport.width}.png`,
    });
    await dialog
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    await expect(
      page.getByText("Remote previous task", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Local previous task", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/history-${viewport.width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(environment).toBeVisible();
    const backend = dialog.getByRole("button", {
      name: "Orc backend",
      exact: true,
    });
    await backend.click();
    await page.getByRole("option", { name: "Pi", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Pi supports this machine only",
    );
    await expect(
      dialog.getByRole("button", { name: "New session", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/pi-${viewport.width}.png`,
    });
    await backend.click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    await createSession(page);
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Preserve my remote draft");
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/conversation-${viewport.width}.png`,
    });
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("n");
    await environment.click();
    await page
      .getByRole("option", { name: "Offline Mac", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Project device is unavailable",
    );
    await expect(
      dialog.getByRole("button", { name: "Retry", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/codex-project-environments/screenshots/offline-${viewport.width}.png`,
    });
    await environment.click();
    await page.getByRole("option", { name: "Empty Mac", exact: true }).click();
    await expect(
      dialog.getByRole("listbox", { name: "Project" }),
    ).toContainText("No matching registered projects");
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("Preserve my remote draft");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
