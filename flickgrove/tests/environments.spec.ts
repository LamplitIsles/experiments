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
    const environment = page.getByRole("combobox", {
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
    const backend = dialog.getByRole("combobox", {
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

for (const width of [1440, 390]) {
  test(`closed remote history remains readable after restart and device loss at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    for (const fault of ["lost", "removed", "moved"]) {
      await page.goto("about:blank");
      await page.goto("/");
      await newSession(page);
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("combobox", { name: "Execution environment", exact: true })
        .click();
      await page
        .getByRole("option", { name: `Saved ${fault} Mac`, exact: true })
        .click();
      await expect(
        dialog
          .getByRole("listbox", { name: "Project", exact: true })
          .getByRole("option"),
      ).toHaveCount(fault === "moved" ? 2 : 1);
      await dialog
        .getByRole("option", {
          name: "Same project · Saved history",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByRole("button", { name: "New session", exact: true }),
      ).toBeDisabled();
      await dialog
        .getByRole("button", { name: "Find history", exact: true })
        .click();
      await dialog
        .getByRole("button")
        .filter({ has: page.getByText(`Saved ${fault} task`, { exact: true }) })
        .click();
      await dialog
        .getByRole("button", { name: "Read full message", exact: true })
        .click();
      await expect(
        dialog.getByText(`Original ${fault} native transcript`, {
          exact: true,
        }),
      ).toBeVisible();
      if (fault === "removed")
        await page.screenshot({
          animations: "disabled",
          path: `../.scratch/codex-project-environments/screenshots/closed-history-${width}.png`,
        });
      await dialog
        .getByRole("button", { name: "Resume session", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(
        fault === "lost"
          ? "unavailable"
          : fault === "removed"
            ? "no longer configured"
            : "target changed",
        { ignoreCase: true },
      );
      await expect(
        dialog.getByText(`Original ${fault} native transcript`, {
          exact: true,
        }),
      ).toBeVisible();
    }
  });
}

for (const width of [1440, 390]) {
  test(`live project dedup keeps saved bodies and creation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.goto("/");
    for (const id of ["local", "mac"]) {
      await newSession(page);
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("combobox", { name: "Execution environment", exact: true })
        .click();
      await page
        .getByRole("option", {
          name: id === "local" ? "This machine" : "Mac studio",
          exact: id === "local",
        })
        .click();
      const options = dialog
        .getByRole("listbox", { name: "Project", exact: true })
        .getByRole("option");
      await expect(options).toHaveCount(1);
      await expect(options).toHaveAccessibleName("Same project");
      await options.click();
      const create = dialog.getByRole("button", {
        name: "New session",
        exact: true,
      });
      await expect(create).toBeEnabled();
      const before = await (await page.request.get("/fixture/metrics")).json();
      if (id === "mac")
        await page.screenshot({
          animations: "disabled",
          path: `../.scratch/project-picker-saved-history-dedup/picker-${width}.png`,
        });
      await dialog
        .getByRole("button", { name: "Find history", exact: true })
        .click();
      await dialog
        .getByRole("button")
        .filter({ has: page.getByText(`Saved ${id} task`, { exact: true }) })
        .click();
      await dialog
        .getByRole("button", { name: "Read full message", exact: true })
        .click();
      await expect(
        dialog.getByText(`Original ${id} native transcript`, { exact: true }),
      ).toBeVisible();
      expect(await (await page.request.get("/fixture/metrics")).json()).toEqual(
        before,
      );
      if (id === "mac")
        await page.screenshot({
          animations: "disabled",
          path: `../.scratch/project-picker-saved-history-dedup/history-${width}.png`,
        });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(create).toBeEnabled();
      await createSession(page);
      const after = await (await page.request.get("/fixture/metrics")).json();
      expect(after.opens).toBe(before.opens + 1);
      expect(after.inputs).toBe(before.inputs);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}
