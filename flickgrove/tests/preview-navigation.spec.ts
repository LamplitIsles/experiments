import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
async function navigateInside(page: Page) {
  const frame = page.frameLocator(".file-preview iframe");
  await expect(frame.locator("#module")).toHaveText(
    "Local module loaded / Local",
  );
  await frame.getByRole("link", { name: "Method", exact: true }).click();
  await expect(frame.locator("#active-meter")).toHaveText("#method");
  await frame.getByRole("radio", { name: "Meter B tab" }).check();
  await expect(frame.locator("#active-meter")).toHaveText("#meter-b");
  await frame.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(frame.locator("#active-meter")).toHaveText("#overview");
}
for (const width of [1440, 390]) {
  test(`HTML hash links/tabs Close, Forward/refresh and outer Back retain draft/reading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset");
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Local reports Orc", exact: true })
      .click();
    const composer = page.getByRole("textbox", { name: "Message Orc" });
    await composer.fill("Navigation keeps my draft");
    const info = await (
      await page.request.get(origin + "/fixture/info")
    ).json();
    await page.request.post(origin + "/fixture/history-live", {
      data: { id: info.local, text: "Reading paragraph\n\n".repeat(100) },
    });
    const transcript = page.locator(".conversation");
    await expect
      .poll(() =>
        transcript.evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeGreaterThan(1000);
    await transcript.evaluate((el) => (el.scrollTop = 100));
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const reading = await transcript.evaluate((el) => el.scrollTop);
    const url = page.url();
    const preview = page.getByRole("region", { name: "File preview" });
    const openHtml = () =>
      page
        .getByRole("link", { name: "HTML", exact: true })
        .evaluate((link: HTMLAnchorElement) => link.click());
    await openHtml();
    const first = await preview.locator("iframe").getAttribute("src");
    await navigateInside(page);
    expect(page.url()).toBe(url);
    await preview.getByRole("button", { name: "Close preview" }).click();
    await expect(preview).toHaveCount(0);
    await expect(composer).toHaveValue("Navigation keeps my draft");
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollTop))
      .toBe(reading);
    expect(await page.evaluate(() => history.state.grove.surfaces)).toEqual([]);
    // Forward restores identity, reauthorizes the capability, and refresh keeps the route.
    await page.goForward();
    await expect(preview.locator("iframe")).toBeVisible();
    expect(await preview.locator("iframe").getAttribute("src")).not.toBe(first);
    await page.reload();
    // Full refresh resets the existing in-memory timeline cache. Test the new
    // reading position across preview closure, rather than inventing persistence.
    await expect
      .poll(() =>
        transcript.evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeGreaterThan(1000);
    await transcript.evaluate(
      (el, position) => (el.scrollTop = position),
      reading,
    );
    await navigateInside(page);
    expect(
      await page.evaluate(() => JSON.stringify(history.state)),
    ).not.toContain("/preview/");
    // A higher parent layer closes first; its Back must not consume iframe hashes.
    if (width === 1440) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(preview).toBeVisible();
    }
    await preview.getByRole("button", { name: "Close preview" }).click();
    await expect(preview).toHaveCount(0);
    await expect(composer).toHaveValue("Navigation keeps my draft");
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollTop))
      .toBe(reading);
    await composer.fill("Outer composer works");
    // Back reaches the real parent root, not a leftover iframe-only step.
    const root = await page.evaluate(
      () =>
        new Promise<unknown>((resolve) => {
          window.addEventListener(
            "popstate",
            (event) => resolve(event.state.grove),
            { once: true },
          );
          history.back();
        }),
    );
    expect(root).toMatchObject({ details: [], surfaces: [] });
    if (width === 390)
      await expect(page.locator(".agent-detail")).toHaveCount(0);
    else {
      // Desktop's existing selection effect reopens its remembered conversation.
      await expect(page.locator(".agent-detail h1")).toHaveText(
        "Local reports",
      );
      expect(await page.evaluate(() => history.state.grove.surfaces)).toEqual(
        [],
      );
    }
    await page.getByRole("button", { name: "Hosts", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Open Local reports Orc", exact: true })
      .click();
    await expect(composer).toHaveValue("Outer composer works");
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollTop))
      .toBe(reading);
    // A normal session switch also unwinds all parent preview surfaces directly.
    await openHtml();
    await navigateInside(page);
    if (width === 1440) {
      await page
        .getByRole("group", { name: "Host filter" })
        .getByRole("button", { name: "Remote", exact: true })
        .click();
      await expect(preview).toHaveCount(0);
      await expect(page.locator(".agent-detail h1")).toHaveText(
        "Remote reports",
      );
      await page
        .getByRole("group", { name: "Host filter" })
        .getByRole("button", { name: "Local", exact: true })
        .click();
      await expect(composer).toHaveValue("Outer composer works");
      await expect
        .poll(() => transcript.evaluate((el) => el.scrollTop))
        .toBe(reading);
    } else {
      // Native Back first visits the child's hash; subsequent explicit Close still works.
      await page.evaluate(() => history.back());
      await expect(
        page.frameLocator(".file-preview iframe").locator("#active-meter"),
      ).toHaveText("#meter-b");
      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(preview).toHaveCount(0);
    }
  });
}

test("an invalid parent entry leaves preview visible and a fresh Close can retry", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  await navigateInside(page);
  const failed = page.waitForEvent("pageerror");
  await page.evaluate(() => {
    const nav = window.navigation;
    const traverse = nav.traverseTo.bind(nav);
    nav.traverseTo = () => {
      nav.traverseTo = traverse;
      return traverse("test-owned-missing-entry");
    };
  });
  const preview = page.getByRole("region", { name: "File preview" });
  await preview.getByRole("button", { name: "Close preview" }).click();
  expect((await failed).message).toMatch(
    /InvalidStateError|invalid|not found/i,
  );
  await expect(preview).toBeVisible();
  expect(await page.evaluate(() => history.state.grove.surfaces)).toEqual([
    "file-preview",
  ]);
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(preview).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Retry recovered");
});
