import { expect, test, type Page } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });
const roots = (page: Page) =>
  page.locator(".session-item:not(.worker-item) .session-open");
const ids = (page: Page) =>
  roots(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")),
  );
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const order = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(`flickgrove/${location.origin}/tree-order`)!,
    ),
  );

test("desktop drags whole trees, preserves selection/draft, restores order and applies it to keyboard/mobile/new/close", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  const original = await ids(page);
  await composer(page).fill("Selected tree draft");
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  const selected = page.locator(
    `.session-open[data-agent-id="${original[0]}"]`,
  );
  const target = page.locator(`.session-open[data-agent-id="${original[1]}"]`);
  await expect(
    page.getByRole("button", { name: "Open Voice input Worker", exact: true }),
  ).toHaveAttribute("draggable", "false");
  const targetBox = (await target.boundingBox())!;
  await selected.dragTo(target, {
    targetPosition: { x: 20, y: targetBox.height - 3 },
  });
  const expected = [original[1], original[0], ...original.slice(2)];
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(composer(page)).toHaveValue("Selected tree draft");
  await expect
    .poll(() =>
      page
        .locator(".session-open")
        .evaluateAll((els) =>
          els.slice(0, 4).map((el) => el.getAttribute("data-agent-id")),
        ),
    )
    .toEqual([
      original[1],
      original[0],
      original[0]!.split(":")[0] + ":voice",
      original[0]!.split(":")[0] + ":docs",
    ]);
  await page.reload();
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect(composer(page)).toHaveValue("Selected tree draft");
  await composer(page).press("Meta+1");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Additional task 1",
  );
  await composer(page).press("Alt+j");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(composer(page)).toHaveValue("Selected tree draft");
  await composer(page).press("Meta+3");
  await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
  await page.keyboard.press("Alt+k");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await composer(page).evaluate((el) => el.blur());
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Additional task 1",
  );
  await page.screenshot({
    path: "../.scratch/flickgrove-host-shortcuts/desktop-tree-order.png",
  });
  // Same-position drop and a cancelled drag never rewrite the order.
  const before = await order(page);
  await target.dragTo(target);
  expect(await order(page)).toEqual(before);
  const sourceBox = (await selected.boundingBox())!;
  await page.mouse.move(sourceBox.x + 30, sourceBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 100, sourceBox.y + 25, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await order(page)).toEqual(before);
  await newSession(page);
  await createSession(page);
  const created = await page.evaluate(() => history.state.grove.details.at(-1));
  await expect.poll(() => ids(page)).toEqual([...expected, created]);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await expect.poll(() => ids(page)).toEqual([...expected, created]);
  await expect(roots(page).first()).toHaveAttribute("draggable", "false");
  const row = page.locator(`.session-row[data-swipe-id="${created}"]`);
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 230, y: box.y + 30 }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + 230 - i * 20, y: box.y + 30 }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await expect(
    row.getByRole("button", { name: "Close this tree", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-host-shortcuts/mobile-tree-swipe.png",
  });
  await row
    .getByRole("button", { name: "Close this tree", exact: true })
    .click();
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect
    .poll(async () => Object.values(await order(page)).flat())
    .not.toContain(created);
});

test("per-device ordering retains offline missing roots until an authoritative snapshot", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "host-selection" },
  });
  const info = await (await request.get(origin + "/fixture/info")).json();
  await page.goto(origin);
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  const original = await ids(page);
  await roots(page)
    .last()
    .dragTo(roots(page).first(), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => ids(page)).toEqual([...original].reverse());
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await page.evaluate(({ peer }) => {
    const prefix = `flickgrove/${location.origin}`;
    const order = JSON.parse(localStorage.getItem(prefix + "/tree-order")!);
    order[peer].push(peer + ":unobserved");
    localStorage.setItem(prefix + "/tree-order", JSON.stringify(order));
    localStorage.removeItem(prefix + "/peer-cache/" + peer);
    localStorage.removeItem(prefix + "/snapshot");
  }, info);
  await page.reload();
  await expect
    .poll(async () => (await order(page))[info.peer])
    .toEqual([...original].reverse().concat(info.peer + ":unobserved"));
  await request.post(origin + "/fixture/change", { data: { outage: false } });
  await expect.poll(() => ids(page)).toEqual([...original].reverse());
  await expect
    .poll(async () => (await order(page))[info.peer])
    .toEqual([...original].reverse());
  await page.keyboard.press("Alt+h");
  await expect(roots(page).first()).toContainText("Streaming voice input");
  await page.keyboard.press("Alt+l");
  await expect.poll(() => ids(page)).toEqual([...original].reverse());
});
