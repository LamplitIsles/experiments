import { expect, test, type Page } from "@playwright/test";
import { openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/pinned-sessions/screenshots";
const rows = (page: Page, location = "tree") =>
  page.locator(`.session-open[data-location="${location}"]`);
const heading = (page: Page) => page.locator(".agent-detail h1");
async function menu(page: Page, title: string, location = "tree") {
  await page
    .locator(location === "tree" ? ".org-group" : ".pinned-sessions")
    .getByRole("button", { name: `Menu for ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ }),
  ).toBeVisible();
}
async function toggle(page: Page, title: string, location = "tree") {
  await menu(page, title, location);
  await page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}
for (const width of [1440, 390])
  test(`Pin identity, menus, local keys and unpin focus at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    const initial = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    await openSidebar(page);
    await rows(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(rows(page, "pinned")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Expand Workers", exact: true })
      .first()
      .click();
    // Keyboard reaches the row menu through native Tab; Shift+F10 also opens it.
    await rows(page).filter({ hasText: "Voice input" }).nth(1).focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(rows(page, "pinned")).toHaveCount(2);
    await expect(rows(page).filter({ hasText: "Voice input" })).toHaveCount(2);
    await expect(page.locator(".pinned-members")).toContainText("2");
    await rows(page, "pinned").first().click();
    await expect(heading(page)).toHaveText("Streaming voice input");
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("unsent pin draft");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(3, 7),
    );
    await openSidebar(page);
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveCount(1);
    await rows(page, "pinned").first().click();
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveAttribute("data-location", "pinned");
    if (width === 1440)
      await expect(rows(page, "pinned").first()).toBeFocused();
    await openSidebar(page);
    await rows(page).first().click();
    if (width === 1440) await expect(rows(page).first()).toBeFocused();
    await openSidebar(page);
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveAttribute("data-location", "tree");
    await rows(page, "pinned").first().click();
    await expect(input).toHaveValue("unsent pin draft");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([3, 7]);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Collapse Workers", exact: true })
      .first()
      .click();
    await rows(page, "pinned").nth(1).click();
    await expect(heading(page)).toHaveText("Voice input");
    await openSidebar(page);
    await expect(
      page.getByRole("button", { name: "Expand Workers", exact: true }).first(),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(rows(page).filter({ hasText: "Voice input" })).toHaveCount(1);
    // Left/Right in the shortcut never expands its owner; local Up wraps only pins.
    await rows(page, "pinned").nth(1).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("button", { name: "Expand Workers", exact: true }).first(),
    ).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowUp");
    if (width === 390) await openSidebar(page);
    await expect(heading(page)).toHaveText("Streaming voice input");
    await rows(page, "pinned").first().focus();
    await expect(rows(page).first()).not.toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(rows(page, "pinned").first()).toBeFocused();
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveAttribute("data-location", "pinned");

    await page.screenshot({ path: `${shots}/${width}-source-focus.png` });
    await page.keyboard.press("Tab");
    await expect(
      page.locator(".pinned-sessions .session-menu-trigger").first(),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Unpin", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(heading(page)).toHaveText("Streaming voice input");
    await page.screenshot({
      path: `${shots}/${width}-menu.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".session-list")).toBeVisible();
    if (width === 390) {
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-list")).toBeHidden();
      await openSidebar(page);
    }
    await menu(page, "Streaming voice input", "pinned");
    await page.goBack();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".session-list")).toBeVisible();
    await menu(page, "Streaming voice input", "pinned");
    await page.locator(".session-list-heading h1").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/${width}-pinned.png` });
    await page.locator(".org-disclosure").click();
    const scroll = await page
      .locator(".session-list")
      .evaluate((el) => el.scrollTop);
    await rows(page, "pinned").nth(1).click();
    await expect(heading(page)).toHaveText("Voice input");
    await openSidebar(page);
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      await page.locator(".session-list").evaluate((el) => el.scrollTop),
    ).toBe(scroll);
    await page.screenshot({ path: `${shots}/${width}-folded-member.png` });
    await toggle(page, "Voice input", "pinned");
    await expect(
      rows(page).filter({ hasText: "Voice input" }).nth(1),
    ).toBeFocused();
    await expect(heading(page)).toHaveText("Voice input");
    await rows(page, "pinned").first().click();
    await page.reload();
    await openSidebar(page);
    await expect(rows(page, "pinned")).toHaveCount(1);
    await toggle(page, "Streaming voice input", "pinned");
    await expect(rows(page, "pinned")).toHaveCount(0);
    await expect(rows(page).first()).toBeFocused();
    if (width === 390) await page.keyboard.press("Escape");
    await expect(input).toHaveValue("unsent pin draft");
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(initial);
  });

test("removed global shortcuts do not cancel runtime events or change selection", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(heading(page)).toHaveText("Streaming voice input");
  for (const target of ["body", ".composer textarea"]) {
    const results = await page.locator(target).evaluate((el) => {
      const combinations = [
        ...["KeyJ", "KeyK"].map((code) => ({
          code,
          key: code.slice(-1).toLowerCase(),
          altKey: true,
        })),
        ...Array.from({ length: 9 }, (_, i) => i + 1).flatMap((i) => [
          { code: `Digit${i}`, key: String(i), metaKey: true },
          { code: `Digit${i}`, key: String(i), ctrlKey: true },
        ]),
      ];
      return combinations.map((init) => {
        const event = new KeyboardEvent("keydown", {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      });
    });
    expect(results).toEqual(Array(20).fill(false));
    await expect(heading(page)).toHaveText("Streaming voice input");
  }
});

test("idle, offline and authoritative close retain or prune only appropriate pins", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await toggle(page, "Streaming voice input");
  await request.post(origin + "/fixture/change", {
    data: { complete: "completed" },
  });
  await expect(
    rows(page, "pinned")
      .first()
      .getByRole("img", { name: "Idle", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pinned-members")).toHaveAttribute(
    "aria-label",
    "1 working",
  );
  await expect(rows(page, "pinned")).toHaveCount(1);
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(page.locator(".connection-banner")).toBeVisible();
  await page.reload();
  await expect(rows(page, "pinned")).toHaveCount(1);
  await request.post(origin + "/fixture/change", { data: { outage: false } });
  await expect(page.locator(".connection-banner")).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(rows(page, "pinned")).toHaveCount(1);
  // Close an independent idle fixture tree through the existing guarded UI action.
  for (const agentId of ["reader-orc", "reader"])
    await request.post(origin + "/fixture/change", {
      data: {
        execution: {
          agentId,
          event: { type: "completed", status: "completed" },
        },
      },
    });
  await toggle(page, "Reader performance");
  await page
    .getByRole("button", { name: "Open Reader performance Orc", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Session settings", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Alt+x");
  await expect(rows(page, "pinned")).toHaveCount(1);
  const pins = await page.evaluate(() =>
    JSON.parse(localStorage.getItem(`flickgrove/${location.origin}/pinned`)!),
  );
  expect(Object.values(pins).flat()).toHaveLength(1);
});

test("optional storage refusal and malformed/foreign pins keep navigation usable", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.addInitScript(() => {
    localStorage.setItem(
      `flickgrove/${location.origin}/pinned`,
      JSON.stringify({ foreign: ["foreign:orc"], bad: [4] }),
    );
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith("/pinned"))
        throw new DOMException("test preference refusal", "SecurityError");
      return set.call(this, key, value);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await expect(rows(page, "pinned")).toHaveCount(0);
  await toggle(page, "Streaming voice input");
  await expect(rows(page, "pinned")).toHaveCount(1);
  await page.setViewportSize({ width: 700, height: 844 });
  await openSidebar(page);
  await expect(rows(page, "pinned")).toHaveCount(1);
  await page.setViewportSize({ width: 701, height: 844 });
  await expect(rows(page, "pinned")).toHaveCount(1);
  await toggle(page, "Streaming voice input", "pinned");
  await expect(rows(page, "pinned")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("qualified preference order isolates instances, restores after empty loading and re-pin appends", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  const { agents, entryId } = await (
    await request.get(origin + "/fixture/snapshot")
  ).json();
  const root = agents.find((a: { role: string }) => a.role === "orc").id;
  await page.addInitScript(
    ({ root, entryId }) => {
      if (!sessionStorage.getItem("seed-pins")) {
        localStorage.setItem(
          `flickgrove/${location.origin}/pinned`,
          JSON.stringify({
            [entryId]: [root, root, "foreign:orc"],
            foreign: ["foreign:orc"],
          }),
        );
        sessionStorage.setItem("seed-pins", "yes");
      }
    },
    { root, entryId },
  );
  let held = true;
  const queued: (string | Buffer)[] = [];
  let release = () => {};
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      if (held) queued.push(raw);
      else ws.send(raw);
    });
    release = () => {
      held = false;
      for (const raw of queued) ws.send(raw);
      queued.length = 0;
    };
  });
  // The page starts without available session data; only the later full snapshot is authority.
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ status: 503, body: "Synthetic loading failure" }),
  );
  await page.goto(origin);
  await expect(rows(page, "pinned")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.values(
        JSON.parse(
          localStorage.getItem(`flickgrove/${location.origin}/pinned`)!,
        ),
      ).flat(),
    ),
  ).toContain(root);
  release();
  await expect(rows(page, "pinned")).toHaveCount(1);
  await toggle(page, "Reader performance");
  await toggle(page, "Streaming voice input", "pinned");
  await toggle(page, "Streaming voice input");
  await expect(rows(page, "pinned").locator("strong")).toHaveText([
    "Reader performance",
    "Streaming voice input",
  ]);
  await page.reload();
  await expect(rows(page, "pinned").locator("strong")).toHaveText([
    "Reader performance",
    "Streaming voice input",
  ]);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem(`flickgrove/${location.origin}/pinned`)!),
  );
  expect(stored.foreign).toEqual(["foreign:orc"]);
  expect(stored[entryId]).toHaveLength(2);
  await page.setViewportSize({ width: 700, height: 844 });
  await openSidebar(page);
  await menu(page, "Streaming voice input", "pinned");
  await page.setViewportSize({ width: 701, height: 844 });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual([]);
  await rows(page, "pinned").first().click();
  await expect(heading(page)).toHaveText("Reader performance");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText("Streaming voice input");
});

for (const width of [1440, 390])
  test(`Composer Escape releases only ordinary input focus at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await rows(page).first().click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    const sharp = (await import("sharp")).default;
    await page.getByLabel("Choose message images").setInputFiles({
      name: "escape.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 8, height: 8, channels: 4, background: "blue" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    const initial = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    await input.fill("Keep Escape draft and selection");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(5, 11),
    );
    await input.press("Escape");
    await expect(input).not.toBeFocused();
    await expect(heading(page)).toHaveText("Streaming voice input");
    await expect(input).toHaveValue("Keep Escape draft and selection");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([5, 11]);
    expect(
      await page.evaluate(() =>
        document.activeElement?.matches(".session-open"),
      ),
    ).toBe(false);
    await page.screenshot({ path: `${shots}/${width}-composer-unfocused.png` });
    await page.keyboard.press("i");
    await expect(input).toBeFocused();
    await input.dispatchEvent("compositionstart");
    await input.press("Escape");
    await expect(input).toBeFocused();
    await input.dispatchEvent("compositionend");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent("keydown", {
        key: "Escape",
        code: "Escape",
        ...init,
      });
      await expect(input).toBeFocused();
    }
    await input.press("Alt+KeyS");
    const search = page.getByRole("combobox", { name: "Search skills…" });
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([5, 11]);
    await input.press("Escape");
    await expect(input).not.toBeFocused();
    await input.click();
    await input.type("x");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/x/);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(initial);
  });
