import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });
const title = (page: Page) => page.locator(".agent-detail h1");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const filters = (page: Page) =>
  page.getByRole("group", { name: "Host filter", includeHidden: true });
async function shortcut(page: Page, code = "KeyL", extra = {}) {
  return page.evaluate(
    ({ code, extra }) => {
      const event = new KeyboardEvent("keydown", {
        key: code === "KeyH" ? "˙" : "¬",
        code,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      (document.activeElement ?? window).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { code, extra },
  );
}
for (const width of [1440, 390]) {
  test(`physical host shortcuts wrap and restore button selection/drafts at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "host-selection" },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    if (width === 390) await page.locator(".session-open").first().click();
    await expect(title(page)).toHaveText("Streaming voice input");
    const conversation = page.locator(".conversation");
    const measuredEnd = () =>
      conversation.evaluate((el) => {
        const timeline = el.querySelector<HTMLElement>(".message-timeline")!;
        const last = el.querySelector<HTMLElement>(
          '[data-message-id="row-39"]',
        );
        const footer = el.querySelector<HTMLElement>(".timeline-footer")!;
        return (
          !!last &&
          Math.abs(
            last.getBoundingClientRect().bottom -
              timeline.getBoundingClientRect().top -
              footer.offsetTop,
          ) <= 1 &&
          Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1
        );
      });
    await expect.poll(measuredEnd).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect.poll(measuredEnd).toBe(true);
    await conversation.evaluate((el) => {
      el.scrollTop = 800;
    });
    await expect
      .poll(() =>
        conversation.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeGreaterThan(1000);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const anchor = await conversation.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [
        ...el.querySelectorAll<HTMLElement>(".timeline-message"),
      ].find((row) => row.getBoundingClientRect().bottom > top)!;
      return {
        id: row.dataset.messageId!,
        offset: row.getBoundingClientRect().top - top,
      };
    });
    await composer(page).fill("NUC draft");
    await composer(page).evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(2, 4),
    );
    expect(await shortcut(page, "KeyH")).toBe(true); // first -> last
    await expect(title(page)).toHaveText("Reader performance");
    await composer(page).fill("Mac draft");
    await composer(page).focus();
    expect(await shortcut(page, "KeyL")).toBe(true); // last -> first
    await expect(title(page)).toHaveText("Streaming voice input");
    await expect(composer(page)).toHaveValue("NUC draft");
    await expect
      .poll(() =>
        conversation.evaluate((el, anchor) => {
          const row = [
            ...el.querySelectorAll<HTMLElement>(".timeline-message"),
          ].find((row) => row.dataset.messageId === anchor.id);
          return row
            ? Math.abs(
                row.getBoundingClientRect().top -
                  el.getBoundingClientRect().top -
                  anchor.offset,
              )
            : Infinity;
        }, anchor),
      )
      .toBeLessThanOrEqual(1);

    // Target caret follows the existing button path (new Composer at draft end).
    const caret = await composer(page).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]);
    expect(caret).toEqual([9, 9]);
    await composer(page).focus();
    await shortcut(page, "KeyL"); // ordinary next
    await expect(title(page)).toHaveText("Reader performance");
    await expect(composer(page)).toHaveValue("Mac draft");
    await composer(page).focus();
    await shortcut(page, "KeyH"); // ordinary previous
    await expect(title(page)).toHaveText("Streaming voice input");
    await page.screenshot({
      path: `../.scratch/flickgrove-host-shortcuts/${width}-restored.png`,
    });
  });
}
test("composition, modifiers and every foreground navigation layer retain focus/caret", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "host-selection" },
  });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).fill("Guarded draft");
  await composer(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(2, 5),
  );
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
  ]) {
    expect(await shortcut(page, "KeyL", extra)).toBe(false);
  }
  await composer(page).dispatchEvent("compositionstart");
  expect(await shortcut(page)).toBe(false);
  await composer(page).dispatchEvent("compositionend");
  expect(
    await composer(page).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 5]);
  for (const surface of [
    "new",
    "settings",
    "hosts",
    "skill",
    "title",
    "session-settings",
  ]) {
    if (surface === "new") {
      await composer(page).evaluate((el) => el.blur());
      await page.keyboard.press("n");
    } else if (surface === "skill") await composer(page).press("Alt+s");
    else if (surface === "title")
      await page
        .getByRole("button", { name: "Edit title", exact: true })
        .click();
    else if (surface === "session-settings")
      await page
        .getByRole("button", { name: "Session settings", exact: true })
        .click();
    else
      await page
        .getByRole("button", {
          name: surface === "hosts" ? "Hosts" : "Settings",
          exact: true,
        })
        .click();
    await expect
      .poll(() => page.evaluate(() => history.state.grove.surfaces))
      .toContain(surface);
    expect(await shortcut(page)).toBe(false);
    await expect(
      filters(page).getByRole("button", { name: "NUC", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect
      .poll(() => page.evaluate(() => history.state.grove.surfaces))
      .toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator(".questions-toggle").click();
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toContain("questions");
  expect(await shortcut(page)).toBe(false);
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual([]);
  await composer(page).focus();
  await expect(composer(page)).toHaveValue("Guarded draft");
});
test("nested Worker and rapid held keys retain qualified memory; offline stays selectable", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: {} });
  const { hub } = await (await request.get(origin + "/fixture/info")).json();
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.evaluate(
    (hub) =>
      history.pushState(
        { grove: { details: [hub + ":orc", hub + ":voice"], surfaces: [] } },
        "",
      ),
    hub,
  );
  await page.reload();
  await expect(title(page)).toHaveText("Voice input");
  await page.evaluate(() => {
    for (const code of ["KeyL", "KeyH", "KeyL"])
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code,
          altKey: true,
          repeat: true,
          cancelable: true,
        }),
      );
  });
  await expect(title(page)).toHaveText("Reader performance");
  await shortcut(page, "KeyH");
  await expect(title(page)).toHaveText("Voice input");
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(
    filters(page).getByRole("button", { name: "Neil’s Mac", exact: true }),
  ).toBeEnabled();
  await shortcut(page, "KeyL");
  await expect(
    filters(page).getByRole("button", { name: "Neil’s Mac", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(title(page)).toHaveText("Reader performance");
  await shortcut(page, "KeyH");
  await expect(title(page)).toHaveText("Voice input");
});
for (const count of [0, 1]) {
  test(`${count} device shortcut is a harmless no-op`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", { data: {} });
    await page.addInitScript(() =>
      localStorage.setItem(`flickgrove/${location.origin}/peers`, "[]"),
    );
    if (!count)
      await page.route("**/api/identity", (route) =>
        route.fulfill({ status: 503, body: "Synthetic unconfigured entry" }),
      );
    await page.goto(origin);
    await expect(filters(page).getByRole("button")).toHaveCount(count);
    if (count) await expect(title(page)).toHaveText("Streaming voice input");
    const before = await page.evaluate(() => history.state);
    await shortcut(page, "KeyH");
    await shortcut(page, "KeyL");
    expect(await page.evaluate(() => history.state)).toEqual(before);
  });
}

test("file preview owns the foreground", async ({ page, request }) => {
  const previewOrigin = "http://127.0.0.1:14320";
  await request.post(previewOrigin + "/fixture/reset");
  await page.goto(previewOrigin);
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await page.getByRole("link", { name: "Chart", exact: true }).click();
  await expect(page.locator(".file-preview img")).toBeVisible();
  const before = await page.evaluate(() => history.state);
  expect(await shortcut(page, "KeyH")).toBe(false);
  expect(await shortcut(page, "KeyL")).toBe(false);
  expect(await page.evaluate(() => history.state)).toEqual(before);
});
