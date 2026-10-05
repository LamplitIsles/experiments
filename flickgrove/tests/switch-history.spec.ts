import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
async function fixture(page: Page, body = {}) {
  return (
    await page.request.post(origin + "/fixture/history", { data: body })
  ).json();
}
async function control(page: Page, body = {}) {
  return (
    await page.request.post(origin + "/fixture/history-control", { data: body })
  ).json();
}
async function choose(page: Page, title: string) {
  const button = page.getByRole("button", {
    name: `Open ${title} Orc`,
    exact: true,
  });
  if (!(await button.isVisible())) await page.keyboard.press("Escape");
  await button.click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    title,
  );
}
async function observe(page: Page) {
  await page.evaluate(() => {
    const frames: {
      title: string | null;
      history: string;
      scroll: number;
      bottom: number;
    }[] = [];
    (window as any).historyFrames = frames;
    const sample = () => {
      const detail = document.querySelector(".agent-detail");
      const el = detail?.querySelector(".conversation") as HTMLElement | null;
      if (el)
        frames.push({
          title: detail!.getAttribute("aria-label"),
          history:
            detail!.querySelector(".historical-messages")?.textContent ?? "",
          scroll: el.scrollTop,
          bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
        });
      if (frames.length < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
async function assertFrames(
  page: Page,
  title: string,
  text: string,
  scroll: number,
) {
  await page.waitForTimeout(180);
  const frames = (await page.evaluate(() => (window as any).historyFrames)) as {
    title: string;
    history: string;
    scroll: number;
    bottom: number;
  }[];
  const target = frames.filter((frame) => frame.title === title);
  expect(target.length).toBeGreaterThan(0);
  for (const frame of target) {
    expect(frame.history).toContain(text);
    expect(frame.scroll).toBe(scroll);
    expect(frame.bottom).toBeGreaterThan(80);
  }
}
for (const width of [1440, 390])
  test(`${width} cached history and reading position paint together, preserving drafts and live messages`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset");
    const { id } = await fixture(page);
    await page.goto(origin);
    await choose(page, "Historical reports");
    const transcript = page.locator(".conversation");
    await expect(page.locator(".historical-messages")).toContainText(
      "Historical paragraph",
    );
    await expect
      .poll(() =>
        transcript.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBe(0);
    await page
      .getByRole("textbox", { name: "Message Orc" })
      .fill("Historical draft");
    await transcript.evaluate((el) => (el.scrollTop = 30));
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    await choose(page, "Local reports");
    await page
      .getByRole("textbox", { name: "Message Orc" })
      .fill("Local draft");
    await observe(page);
    await choose(page, "Historical reports");
    await assertFrames(page, "Historical reports", "Historical paragraph", 30);
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveValue("Historical draft");
    await page.request.post(origin + "/fixture/history-live", { data: { id } });
    await expect(page.locator(".conversation")).toContainText(
      "Current live response",
    );
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(30);
    await page.screenshot({
      path: `../.scratch/flickgrove-switch-flash/${width}-cached-reading.png`,
    });
  });
test("earlier pages and cursor survive switches; failed page retains data and explicit retry", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  await fixture(page, { count: 75 });
  await page.goto(origin);
  await choose(page, "Historical reports");
  const history = page.locator(".historical-messages");
  await expect(history).toContainText("item 74");
  await history.getByRole("button", { name: "Earlier messages" }).click();
  await expect(history).toContainText("item 15");
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 50));
  await expect(
    page.getByRole("button", { name: "Jump to bottom" }),
  ).toBeVisible();
  const reads = (await control(page)).reads.length;
  await choose(page, "Local reports");
  await observe(page);
  await choose(page, "Historical reports");
  await assertFrames(page, "Historical reports", "item 15", 50);
  expect((await control(page)).reads.length).toBe(reads);
  await control(page, { fail: true });
  await history.getByRole("button", { name: "Earlier messages" }).click();
  await expect(history.getByRole("alert")).toHaveText(
    "Fixture history unavailable",
  );
  await expect(history).toContainText("item 15");
  await choose(page, "Local reports");
  await choose(page, "Historical reports");
  await expect(history.getByRole("alert")).toBeVisible();
  await control(page, { fail: false });
  await history.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(history).toContainText("item 0");
  await expect(
    history.getByRole("button", { name: "Earlier messages" }),
  ).toHaveCount(0);
  expect((await control(page)).reads.at(-1)).toBe("15");
});
test("delayed real Chord history is deduplicated across rapid switches and isolated from another Peer", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  await fixture(page);
  await fixture(page, { peer: "remote", title: "Remote history", count: 35 });
  await control(page, { delay: 1500 });
  await page.goto(origin);
  await choose(page, "Local reports");
  const reads = (await control(page)).reads.length;
  await choose(page, "Historical reports");
  await expect
    .poll(async () => (await control(page)).reads.length)
    .toBe(reads + 1);
  await choose(page, "Remote history");
  await expect(page.locator(".historical-messages")).toContainText(
    "Remote history item 34",
  );
  await choose(page, "Historical reports");
  await expect(
    page.locator(".historical-messages [role=status]"),
  ).toBeVisible();
  expect((await control(page)).reads.length).toBe(reads + 1);
  await choose(page, "Remote history");
  await expect(page.locator(".historical-messages")).toContainText(
    "Remote history item 34",
  );
  await expect
    .poll(() =>
      page
        .locator(".conversation")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBe(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 20));
  await expect(
    page.getByRole("button", { name: "Jump to bottom" }),
  ).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(page.locator(".historical-messages")).not.toContainText(
    "Historical paragraph",
  );
  await choose(page, "Historical reports");
  await expect(page.locator(".historical-messages")).toContainText(
    "Historical paragraph",
  );
  expect((await control(page)).reads.length).toBe(reads + 1);
  await page.request.post(origin + "/fixture/offline");
  await choose(page, "Remote history");
  await expect(page.locator(".conversation .host-outage")).toBeVisible();
  await expect(page.locator(".historical-messages")).toContainText(
    "Remote history item 34",
  );
  expect(
    await page.locator(".conversation").evaluate((el) => el.scrollTop),
  ).toBe(20);
});
for (const completion of ["after return", "while away"])
  test(`pending earlier page keeps its reading anchor when completed ${completion}`, async ({
    page,
  }) => {
    await page.request.post(origin + "/fixture/reset");
    await fixture(page, { count: 75 });
    await page.goto(origin);
    await choose(page, "Historical reports");
    const history = page.locator(".historical-messages");
    const position = (text?: string) =>
      page.locator(".conversation").evaluate((el, text) => {
        const top = el.getBoundingClientRect().top;
        const message = [...el.querySelectorAll(".assistant-message")].find(
          (message) =>
            text
              ? message.textContent === text
              : message.getBoundingClientRect().bottom > top,
        );
        return {
          text: message?.textContent,
          offset: message!.getBoundingClientRect().top - top,
        };
      }, text);
    await expect(history).toContainText("item 74");
    await page.locator(".conversation").evaluate((el) => (el.scrollTop = 0));
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    await control(page, { delay: 1500 });
    await history.getByRole("button", { name: /earlier messages/i }).click();
    await expect
      .poll(async () => (await control(page)).reads)
      .toEqual(["75", "45"]);
    let before = await position();
    await choose(page, "Local reports");
    if (completion === "while away") await page.waitForTimeout(1600);
    await choose(page, "Historical reports");
    if (completion === "after return") {
      await expect(history.getByRole("status")).toBeVisible();
      expect((await position()).text).toContain("item 45");
      // User continues reading during the pending request; preserve this newer anchor.
      await page
        .locator(".conversation")
        .evaluate((el) => (el.scrollTop = 700));
    }
    if (completion === "after return") before = await position();
    await expect(history).toContainText("item 15");
    // Prepend may reveal preceding content above this anchor; scroll metrics round to pixels.
    await expect
      .poll(async () =>
        Math.abs((await position(before.text!)).offset - before.offset),
      )
      .toBeLessThanOrEqual(1);
    expect(before.text).toContain(
      completion === "while away" ? "item 45" : "item 53",
    );
    expect((await control(page)).reads).toEqual(["75", "45"]);
  });
