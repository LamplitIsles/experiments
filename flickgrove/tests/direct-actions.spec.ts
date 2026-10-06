import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-direct-actions/screenshots";
const orcName = "Open Streaming voice input Orc";
async function swipe(page: Page, x: number, y: number, dx: number, dy = 0) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test("skill panel preserves independent multiword query, insertion, caret and Back", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page.getByRole("button", { name: orcName }).click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  const search = page.getByRole("combobox", { name: "Search skills…" });
  await input.fill("before after");
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(7, 7),
  );
  await input.press("Alt+KeyS");
  await expect(search).toBeFocused();
  await search.fill("one spec");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.screenshot({ path: `${shots}/desktop-skill.png` });
  const panel = (await page.locator(".skill-search").boundingBox())!;
  const composer = (await page.locator(".composer").boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(composer.y + 1);
  await search.press("Tab");
  await expect(input).toHaveValue("before $to-orc-impl after");
  await expect(input).toBeFocused();
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(7, 7),
  );
  await input.press("Alt+KeyS");
  await search.fill("no matching skill");
  await search.press("Enter");
  await expect(search).toBeFocused();
  await search.press("Alt+x");
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.goBack();
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(7);
  await expect(input).toHaveValue("before $to-orc-impl after");
  await input.press("Alt+KeyS");
  await search.fill("one Worker");
  await search.press("Enter");
  await expect(input).toHaveValue("before $to-orc-impl $to-orc-impl after");
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(0, 0),
  );
  await input.press("Alt+KeyS");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await expect(page.locator(".completion-description")).toHaveText(
    "Review code and verify tests",
  );
  await search.press("ArrowUp");
  await search.press("ArrowUp");
  await expect(page.locator(".completion-description")).toHaveText(
    "Implement one spec with one Worker",
  );
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await search.press("Tab");
  await expect(input).toHaveValue(
    "$review-code-and-tests before $to-orc-impl $to-orc-impl after",
  );
  await input.fill("/cl");
  await input.press("Tab");
  await expect(input).toHaveValue("/cl");
  await expect(page.locator(".completion")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("");
  await input.press("Alt+KeyS");
  await page.screenshot({ path: `${shots}/mobile-skill.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("Close shortcut uses detail before navigation, blocks surfaces/IME and never closes a Worker parent", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // navigation stays within this device
  await page.getByRole("button", { name: orcName }).click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Draft kept");
  for (const combo of ["Control+Alt+x", "Meta+Alt+x", "Shift+Alt+x"])
    await input.press(combo);
  await input.dispatchEvent("keydown", {
    key: "x",
    code: "KeyX",
    altKey: true,
    isComposing: true,
  });
  await expect(page.getByRole("button", { name: orcName })).toBeVisible();
  await page.getByRole("button", { name: "Edit title" }).click();
  await page.keyboard.press("Alt+x");
  await expect(page.locator(".title-edit")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Alt+x");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await input.fill("Close preserves draft");
  const closingId = await page.evaluate(() =>
    history.state.grove.details.at(-1),
  );
  await input.focus();
  await input.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: orcName })).toHaveCount(0);
  expect(
    await page.evaluate(
      (id) =>
        Object.entries(localStorage).find(([key]) =>
          key.endsWith(`/composer/${id}`),
        )?.[1],
      closingId,
    ),
  ).toBe("Close preserves draft");
  // Closing the last local root retains its device; switch explicitly.
  await page.keyboard.press("Alt+l");
  await expect(
    page.getByRole("button", { name: "Open Reader performance Orc" }),
  ).toBeVisible();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await expect(page.locator(".host-outage")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit title", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Alt+x");
  await expect(page.locator(".session-open")).toHaveCount(0);
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.reload();
  await page.keyboard.press("Alt+h");
  await page.getByRole("button", { name: orcName }).click();
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Open Voice input Worker" }).click();
  let closes = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/close")) closes++;
  });
  await page.keyboard.press("Alt+x");
  expect(closes).toBe(0);
});

test("mobile swipe only reveals, one row at a time; right/outside collapse and explicit Close preserves guards", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  const first = page.locator(".session-row").first();
  const box = (await first.boundingBox())!;
  await swipe(page, 300, box.y + 30, -150);
  await expect(first.locator(".tree-close-action")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/mobile-swipe.png` });
  await first.locator(".tree-close-action").click();
  await expect(first.getByRole("alert")).toContainText("Workers first");
  await page.screenshot({ path: `${shots}/mobile-close-refused.png` });
  await swipe(page, 100, box.y + 30, 150);
  await expect(page.locator(".tree-close-action")).toHaveCount(0);
  await swipe(page, 300, box.y + 30, -150);
  const second = page.locator(".session-row").nth(1);
  const secondBox = (await second.boundingBox())!;
  await swipe(page, 300, secondBox.y + 30, -150);
  await expect(page.locator(".tree-close-action")).toHaveCount(1);
  await expect(second.locator(".tree-close-action")).toBeVisible();
  await page.locator(".session-list h1").click();
  await expect(page.locator(".tree-close-action")).toHaveCount(0);
  await swipe(page, 300, 650, 0, -250);
  await expect
    .poll(() => page.locator(".session-list").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  // Wait for native touch inertia to settle before resetting the scroll position.
  let previousScroll = -1;
  let stableSamples = 0;
  await expect
    .poll(async () => {
      const scroll = await page
        .locator(".session-list")
        .evaluate((el) => el.scrollTop);
      stableSamples = scroll === previousScroll ? stableSamples + 1 : 0;
      previousScroll = scroll;
      return stableSamples;
    })
    .toBeGreaterThanOrEqual(2);
  await page.locator(".session-list").evaluate((el) => (el.scrollTop = 0));
  await expect
    .poll(() => page.locator(".session-list").evaluate((el) => el.scrollTop))
    .toBe(0);
  // Ordinary row navigation is a pointer action; the preceding gesture verifies scrolling.
  await first.locator(".session-open").click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.locator(".mobile-back > button").click();
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  const worker = page.locator(".worker-item").first();
  const wb = (await worker.boundingBox())!;
  await swipe(page, 300, wb.y + 20, -150);
  await expect(page.locator(".tree-close-action")).toHaveCount(0);
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.reload();
  const clean = (await first.boundingBox())!;
  await swipe(page, 300, clean.y + 30, -150);
  await expect(first.locator(".tree-close-action")).toBeVisible();
  await first.locator(".tree-close-action").click();
  await expect(page.getByRole("button", { name: orcName })).toHaveCount(0);
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
});

for (const width of [1440, 390])
  for (const role of ["Orc", "Worker"]) {
    test(`jump to bottom resumes follow for ${role} at ${width}px`, async ({
      page,
      request,
    }) => {
      await request.post(`${origin}/fixture/reset`, { data: { mode: "long" } });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(origin);
      await page.getByRole("button", { name: orcName }).click();
      if (role === "Worker") {
        if (width === 390) {
          await page.locator(".mobile-back > button").click();
          await page
            .getByRole("button", { name: "Expand Workers" })
            .first()
            .click();
          await page
            .getByRole("button", { name: "Open Voice input Worker" })
            .click();
        } else {
          await page
            .getByRole("button", { name: "Expand Workers" })
            .first()
            .click();
          await page
            .getByRole("button", { name: "Open Voice input Worker" })
            .click();
        }
      }
      await expect(page.locator(".role-project")).toContainText(role);
      const transcript = page.locator(".conversation");
      await expect(transcript).toContainText("Paragraph 70.");
      await expect
        .poll(() =>
          transcript.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(80);
      const jump = page.getByRole("button", { name: "Jump to bottom" });
      await expect(jump).toHaveCount(0);
      await transcript.evaluate((el) => (el.scrollTop = 200));
      await expect(jump).toBeVisible();
      await request.post(`${origin}/fixture/change`, {
        data: {
          append: {
            agentId: role === "Orc" ? "orc" : "voice",
            text: "New content while reading",
          },
        },
      });
      await expect(transcript).toContainText("New content while reading");
      expect(await transcript.evaluate((el) => el.scrollTop)).toBe(200);
      const jb = (await jump.boundingBox())!;
      const footer = (await page
        .locator(role === "Orc" ? ".composer" : ".read-only")
        .boundingBox())!;
      expect(jb.y + jb.height).toBeLessThan(footer.y);
      await page.screenshot({
        path: `${shots}/${width}-${role.toLowerCase()}-scroll.png`,
      });
      await jump.click();
      await expect(jump).toHaveCount(0);
      await request.post(`${origin}/fixture/change`, {
        data: {
          append: {
            agentId: role === "Orc" ? "orc" : "voice",
            text: "Follow after jump",
          },
        },
      });
      await expect(transcript).toContainText("Follow after jump");
      await expect
        .poll(() =>
          transcript.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(80);
      await request.post(`${origin}/fixture/reset`, {
        data: {},
      });
      await page.reload();
      await expect(jump).toHaveCount(0);
    });
  }

test("mobile dollar stays ordinary text; explicit icon preserves the replacement range", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByRole("button", { name: orcName }).click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  const search = page.getByRole("combobox", { name: "Search skills…" });
  const cdp = await page.context().newCDPSession(page);
  await input.fill("draft ");
  await page
    .getByRole("button", { name: "Search skills…", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(input).toHaveValue("draft ");
  await search.press("Escape");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("draft ");
  expect(
    await input.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([6, 6]);
  await input.fill("before after");
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(7, 12),
  );
  await page
    .getByRole("button", { name: "Search skills…", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(input).toHaveValue("before after");
  await page.goBack();
  await expect(search).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("before after");
  expect(
    await input.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([7, 12]);
  await page
    .getByRole("button", { name: "Search skills…", exact: true })
    .click();
  await expect(search).toBeFocused();
  await search.fill("one spec");
  await search.press("Tab");
  await expect(input).toHaveValue("before $to-orc-impl ");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([20, 20]);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await input.fill("draft");
  await cdp.send("Input.insertText", { text: "$" });
  await expect(input).toHaveValue("draft$");
  await expect(search).toHaveCount(0);
  await input.fill("draft ");
  await cdp.send("Input.insertText", { text: "$ other text" });
  await expect(input).toHaveValue("draft $ other text");
  await expect(search).toHaveCount(0);
  await cdp.detach();
});
