import { expect, test, type Page } from "@playwright/test";
import { openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/context-menu-only/screenshots";
const rows = (page: Page, location = "tree") =>
  page.locator(`.session-open[data-location="${location}"]`);
const heading = (page: Page) => page.locator(".agent-detail h1");
async function menu(page: Page, title: string, location = "tree") {
  await page
    .locator(location === "tree" ? ".org-group" : ".pinned-sessions")
    .locator(".session-open")
    .filter({ has: page.getByText(title, { exact: true }) })
    .click({ button: "right" });
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
  test(`Orc-only Pin trees share members and source identity at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    const initial = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    await toggle(page, "Streaming voice input");
    await expect(rows(page, "pinned")).toHaveCount(1);
    const pinToggle = page
      .locator(".pinned-sessions .worker-disclosure")
      .first();
    const treeToggle = page.locator(".org-group .worker-disclosure").first();
    await pinToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    await expect(rows(page, "pinned")).toHaveCount(3);
    for (const area of [".pinned-sessions", ".org-group"])
      await expect(
        page.locator(`${area} .session-members`).first().locator("span"),
      ).toHaveText(["2", "1"]);
    const appearances = await page
      .locator(".session-item")
      .filter({ has: page.getByText("Streaming voice input", { exact: true }) })
      .evaluateAll((items) =>
        items.map((item) =>
          [
            "strong",
            ".session-meta",
            ".session-indicators",
            ".session-members",
          ].map((selector) => {
            const el = item.querySelector(selector)!;
            const css = getComputedStyle(el);
            return [el.textContent, css.fontSize, css.lineHeight, css.color];
          }),
        ),
      );
    expect(appearances[0]).toEqual(appearances[1]);
    await page.screenshot({
      path: `${shots}/${width}-matching-orc-rows.png`,
      animations: "disabled",
    });
    const pinDocs = rows(page, "pinned").filter({ hasText: "Documentation" });
    const treeDocs = rows(page).filter({ hasText: "Documentation" });
    expect(await pinDocs.innerText()).toBe(await treeDocs.innerText());
    await expect(
      pinDocs.getByRole("img", { name: "Idle", exact: true }),
    ).toBeVisible();
    for (const member of [pinDocs, treeDocs]) {
      await member.click({ button: "right" });
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    await treeToggle.click();
    await expect(pinToggle).toHaveAttribute("aria-expanded", "false");
    await expect(pinDocs).toHaveCount(0);
    await pinToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    await pinDocs.click();
    await expect(heading(page)).toHaveText("Documentation");
    await openSidebar(page);
    const current = page.locator('.session-open[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-location", "pinned");
    await expect(treeDocs).not.toHaveAttribute("aria-current", "true");
    expect(await pinDocs.getAttribute("data-agent-id")).toBe(
      await treeDocs.getAttribute("data-agent-id"),
    );
    await page.screenshot({
      path: `${shots}/${width}-expanded-pinned-tree.png`,
      animations: "disabled",
    });
    await pinToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "false");
    await expect(heading(page)).toHaveText("Streaming voice input");
    await expect(current).toHaveAttribute("data-location", "pinned");
    await openSidebar(page);
    await treeToggle.click();
    await rows(page, "pinned").first().click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("unsent pin draft");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(3, 7),
    );
    await openSidebar(page);
    await rows(page).first().click();
    await openSidebar(page);
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-location", "tree");
    await rows(page, "pinned").first().click();
    await expect(input).toHaveValue("unsent pin draft");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([3, 7]);
    await openSidebar(page);
    await menu(page, "Streaming voice input", "pinned");
    await page.screenshot({
      path: `${shots}/${width}-menu.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".session-list")).toBeVisible();
    await menu(page, "Streaming voice input", "pinned");
    await page.goBack();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.locator(".org-disclosure").click();
    await pinDocs.click();
    await expect(heading(page)).toHaveText("Documentation");
    await openSidebar(page);
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.screenshot({ path: `${shots}/${width}-folded-member.png` });
    // Removing the Orc removes its Pin subtree, retaining the selected member/detail.
    await toggle(page, "Streaming voice input", "pinned");
    await expect(rows(page, "pinned")).toHaveCount(0);
    await expect(heading(page)).toHaveText("Documentation");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-location", "tree");
    await expect(treeDocs).toHaveAttribute("aria-current", "true");
    await rows(page).first().click();
    if (width === 390) await openSidebar(page);
    await toggle(page, "Streaming voice input");
    await page.reload();
    await openSidebar(page);
    await expect(rows(page, "pinned")).toHaveCount(3);
    await toggle(page, "Streaming voice input", "pinned");
    await expect(rows(page, "pinned")).toHaveCount(0);
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
  await expect(
    page.locator(".pinned-sessions .session-members"),
  ).toHaveAttribute("aria-label", "1 working");
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
  const member = agents.find((a: { role: string }) => a.role === "worker").id;
  await page.addInitScript(
    ({ root, member, entryId }) => {
      if (!sessionStorage.getItem("seed-pins")) {
        localStorage.setItem(
          `flickgrove/${location.origin}/pinned`,
          JSON.stringify({
            [entryId]: [root, root, member, "foreign:orc"],
            foreign: ["foreign:orc"],
          }),
        );
        sessionStorage.setItem("seed-pins", "yes");
      }
    },
    { root, member, entryId },
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
  expect(
    await page.evaluate(() =>
      Object.values(
        JSON.parse(
          localStorage.getItem(`flickgrove/${location.origin}/pinned`)!,
        ),
      ).flat(),
    ),
  ).toContain(member);
  release();
  await expect(rows(page, "pinned")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      Object.values(
        JSON.parse(
          localStorage.getItem(`flickgrove/${location.origin}/pinned`)!,
        ),
      ).flat(),
    ),
  ).not.toContain(member);
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
