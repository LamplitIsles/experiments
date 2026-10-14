import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/sessions-new-button/screenshots";
test.use({ serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`Sessions Plus shares creation and preserves drafts at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", { data: { mode: "idle" } });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    const header = page.locator(".session-list-heading");
    const plus = header.getByRole("button", {
      name: "New session",
      exact: true,
    });
    const dialog = page.getByRole("dialog");
    const search = dialog.getByRole("textbox", { name: "Search projects" });
    await expect(plus).toBeVisible();
    await expect(plus).toHaveText("");
    expect(await plus.getAttribute("title")).toBeNull();
    const background = await plus.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await plus.hover();
    await expect
      .poll(() => plus.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(background);
    await page.screenshot({ path: `${shots}/${width}-header-hover.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator(".session-open").first().click();
    const selected = await page
      .locator(".session-item.active .session-open")
      .getAttribute("data-agent-id");
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await composer.fill("Unsent draft survives creation");
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    for (const via of ["plus", "n"] as const) {
      if (via === "plus") await plus.click();
      else {
        await page.evaluate(() =>
          (document.activeElement as HTMLElement)?.blur(),
        );
        await page.keyboard.press("n");
      }
      await expect(
        dialog.getByRole("heading", { name: "New session", exact: true }),
      ).toBeVisible();
      await expect(search).toBeFocused();
      if (via === "plus") await page.keyboard.press("Escape");
      else await page.goBack();
      await expect(dialog).toBeHidden();
      if (width === 1440)
        await expect(
          page.locator(".session-item.active .session-open"),
        ).toHaveAttribute("data-agent-id", selected!);
    }
    if (width === 390)
      await page.locator(`[data-agent-id="${selected}"]`).click();
    await expect(composer).toHaveValue("Unsent draft survives creation");
    // Existing empty Peer and a blocked socket are entirely fixture-owned.
    const { emptyUrl } = await (
      await request.get(origin + "/fixture/info")
    ).json();
    await page.goto(emptyUrl);
    await expect(page.locator(".session-open")).toHaveCount(0);
    for (const via of ["plus", "n"] as const) {
      if (via === "plus") await plus.click();
      else await page.keyboard.press("n");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
    }
    await page.routeWebSocket("**/api/socket", (ws) => ws.close());
    await page.reload();
    await expect(
      page
        .locator(".list-empty")
        .getByRole("button", { name: "New session", exact: true }),
    ).toBeDisabled();
    await expect(plus).toBeEnabled();
    const notice = page.locator(".connection-banner");
    await expect(notice).toBeVisible();
    const headingBounds = (await header.boundingBox())!;
    const noticeBounds = (await notice.boundingBox())!;
    expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(
      noticeBounds.y,
    );
    for (const copy of [
      page.locator(".list-empty h2"),
      page.locator(".list-empty p"),
    ]) {
      await expect(copy).toBeVisible();
      expect((await copy.boundingBox())!.y).toBeGreaterThanOrEqual(
        noticeBounds.y + noticeBounds.height,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await notice
      .getByRole("button", { name: "Retry", exact: true })
      .click({ trial: true });
    await page.screenshot({ path: `${shots}/${width}-offline-header.png` });
    await plus.click();
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await page.keyboard.press("n");
    await expect(search).toBeFocused();
  });
}
