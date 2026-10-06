import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`Hosts management is separate from filtering and Settings at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", { data: {} });
    const info = await (await request.get(origin + "/fixture/info")).json();
    await page.goto(origin);
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await page
      .getByRole("button", {
        name: "Open Streaming voice input Orc",
        exact: true,
      })
      .click();
    await composer.fill("Hosts panel unsent draft");
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    const entry = page.getByRole("button", { name: "Hosts", exact: true });
    const filters = page.getByRole("group", { name: "Host filter" });
    const nuc = filters.getByRole("button", { name: "NUC", exact: true });
    await expect(entry).toHaveAttribute("title", "Hosts");
    await expect(filters.getByRole("button")).toHaveCount(2);
    expect(
      await filters.getByRole("button", { name: "Hosts", exact: true }).count(),
    ).toBe(0);
    const entryBox = (await entry.boundingBox())!;
    expect(entryBox.x + entryBox.width).toBeLessThanOrEqual(
      (await nuc.boundingBox())!.x,
    );
    await entry.click();
    const panel = page.getByRole("dialog", { name: "Hosts", exact: true });
    await expect(panel).toBeVisible();
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator(".host-row")).toHaveCount(2);
    await page.keyboard.press("Alt+j");
    if (width === 1440)
      await expect(page.locator(".agent-detail h1")).toHaveText(
        "Streaming voice input",
      );
    await page.screenshot({
      path: `../.scratch/flickgrove-navigation-perf/hosts-panel-${width}.png`,
      animations: "disabled",
    });
    await panel
      .getByRole("button", { name: "Edit host Neil’s Mac", exact: true })
      .click();
    await expect(
      panel.getByRole("textbox", { name: "Name", exact: true }),
    ).toHaveValue("Neil’s Mac");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "Add host", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Added fixture device");
    await panel
      .getByRole("textbox", { name: "Backend URL", exact: true })
      .fill(info.emptyUrl);
    await panel
      .getByRole("textbox", { name: "Access token", exact: true })
      .fill("invalid-fixture-token");
    await panel
      .getByRole("button", { name: "Check and save", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("authorization");
    await panel
      .getByRole("textbox", { name: "Access token", exact: true })
      .fill(info.emptyToken);
    await expect
      .poll(() =>
        panel.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: `../.scratch/flickgrove-navigation-perf/hosts-panel-${width}-add.png`,
      animations: "disabled",
    });
    await panel
      .getByRole("button", { name: "Check and save", exact: true })
      .click();
    await expect(panel.getByRole("status")).toHaveText(
      "Connection verified and saved.",
    );
    await expect(panel.locator(".host-row")).toHaveCount(3);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(entry).toBeFocused();
    await expect(
      filters.getByRole("button", {
        name: "Added fixture device",
        exact: true,
      }),
    ).toBeVisible();
    await entry.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(entry).toBeFocused();
    await entry.click();
    await expect(panel).toBeVisible();
    await page.goBack();
    await expect(panel).toHaveCount(0);
    expect(page.url()).toBe(origin + "/");
    await expect(entry).toBeFocused();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(settings.locator(".role-settings")).toHaveCount(2);
    await expect(
      settings.getByRole("button", { name: "Add host", exact: true }),
    ).toHaveCount(0);
    await expect(settings.locator(".host-table")).toHaveCount(0);
    await settings.locator(".model-select").first().selectOption("gpt-6-luna");
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(`flickgrove/${location.origin}/preferences`)!,
          ).orc.model,
      ),
    ).toBe("gpt-6-luna");
    await page
      .getByRole("button", {
        name: "Open Streaming voice input Orc",
        exact: true,
      })
      .click();
    await expect(composer).toHaveValue("Hosts panel unsent draft");
    await composer.press("Alt+j");
    await expect(composer).toBeFocused();
  });
}
