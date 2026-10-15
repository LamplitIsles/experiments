import { expect, test, type Page, type Request } from "@playwright/test";
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
async function choose(page: Page, title: string, host = "Local") {
  const filter = page.getByRole("button", { name: host, exact: true });
  if (!(await filter.isVisible())) await page.keyboard.press("Escape");
  await filter.click();
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
      busy: boolean;
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
          busy: !!document.querySelector(".conversation-loading"),
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
    busy: boolean;
    bottom: number;
  }[];
  const target = frames.filter((frame) => frame.title === title);
  expect(target.length).toBeGreaterThan(0);
  for (const frame of target) {
    expect(frame.busy).toBe(false);
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
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(30);
    await page.screenshot({
      path: `../.scratch/flickgrove-switch-flash/${width}-cached-reading.png`,
    });
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    await expect(page.locator(".conversation")).toContainText(
      "Current live response",
    );
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
  await expect(history.getByRole("status")).toBeHidden();
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 0));
  await expect(history).toContainText("item 15");
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 50));
  await expect(
    page.getByRole("button", { name: "Jump to bottom" }),
  ).toBeVisible();
  const reads = (await control(page)).reads.filter(
    (cursor: string | null) => typeof cursor === "string",
  ).length;
  await choose(page, "Local reports");
  await observe(page);
  await choose(page, "Historical reports");
  await assertFrames(page, "Historical reports", "item 15", 50);
  // Selection refreshes the native recent window; cached earlier pages must
  // not be fetched again while restoring the saved reading anchor.
  expect(
    (await control(page)).reads.filter(
      (cursor: string | null) => typeof cursor === "string",
    ).length,
  ).toBe(reads);
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
  await expect(history.getByRole("status")).toBeHidden();
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = 0));
  await expect(history).toContainText("item 0");
  await expect(
    history.getByRole("button", { name: "Earlier messages" }),
  ).toHaveCount(0);
  expect((await control(page)).reads.at(-1)).toBe("15");
});
// Hold real owning-Peer responses, rather than delaying every native sync call.
// Navigation aborts the consumer; the producer can still finish at either time.
async function holdHistory(page: Page, id: string, earlier: boolean) {
  const arrival = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let cursor: string | null = null;
  let cancelled = false;
  let armed = true;
  let heldRequest: Request | undefined;
  page.on("requestfailed", (request) => {
    if (request === heldRequest) cancelled = true;
  });
  await page.route("**/api/read/messages?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      !armed ||
      url.searchParams.get("agent") !== id ||
      url.searchParams.has("cursor") !== earlier
    ) {
      await route.continue();
      return;
    }
    armed = false;
    heldRequest = route.request();
    cursor = url.searchParams.get("cursor");
    const response = await route.fetch({
      headers: { ...route.request().headers(), Origin: origin },
    });
    expect(response.status()).toBe(200);
    arrival.resolve();
    await release.promise;
    await route.fulfill({ response }).catch((error) => {
      if (!cancelled) throw error;
    });
    done.resolve();
  });
  return {
    arrival: arrival.promise,
    release: () => release.resolve(),
    done: done.promise,
    cursor: () => cursor,
    cancelled: () => cancelled,
  };
}
async function uniqueVisibleMessages(page: Page) {
  const ids = await page
    .locator("[data-message-id]")
    .evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("data-message-id")),
    );
  expect(new Set(ids).size).toBe(ids.length);
}
test("delayed real Chord history is deduplicated across rapid switches and isolated from another Peer", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  const { id } = await fixture(page, { count: 75 });
  await fixture(page, { peer: "remote", title: "Remote history", count: 35 });
  await page.goto(origin);
  await choose(page, "Local reports");
  const held = await holdHistory(page, id, false);
  await choose(page, "Historical reports");
  await held.arrival;
  await expect(page.locator(".conversation")).toContainText(
    "Historical reports item 74",
  );
  await choose(page, "Remote history", "Remote");
  await expect.poll(held.cancelled).toBe(true);
  await expect(page.locator(".historical-messages")).toContainText(
    "Remote history item 34",
  );
  await choose(page, "Historical reports");
  await expect(page.locator(".conversation")).toContainText(
    "Historical reports item 74",
  );
  await uniqueVisibleMessages(page);
  await expect(page.locator(".conversation")).not.toContainText(
    "Remote history item",
  );
  await choose(page, "Remote history", "Remote");
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
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 20;
  });
  await expect(
    page.getByRole("button", { name: "Jump to bottom" }),
  ).toBeVisible();
  held.release();
  await held.done;
  await expect(page.locator(".conversation")).not.toContainText(
    "Historical reports item",
  );
  await uniqueVisibleMessages(page);
  expect(
    await page.locator(".conversation").evaluate((el) => el.scrollTop),
  ).toBe(20);
  await page.unrouteAll({ behavior: "wait" });
  await choose(page, "Historical reports");
  await expect(page.locator(".historical-messages")).toContainText(
    "Historical reports item 74",
  );
  await uniqueVisibleMessages(page);
  await page.request.post(origin + "/fixture/offline");
  await choose(page, "Remote history", "Remote");
  await expect(page.locator(".conversation .host-outage")).toBeVisible();
  await expect(page.locator(".historical-messages")).toContainText(
    "Remote history item",
  );
  await expect(page.locator(".conversation")).not.toContainText(
    "Historical reports item",
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
    const { id } = await fixture(page, { count: 75 });
    const delivered = new Map<string, string>();
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (
        url.pathname !== "/api/read/messages" ||
        url.searchParams.get("agent") !== id ||
        !response.ok()
      )
        return;
      try {
        for (const message of (await response.json()).messages)
          delivered.set(message.id, message.text);
      } catch {
        /* A navigation may cancel the response body. */
      }
    });
    await page.goto(origin);
    await choose(page, "Historical reports");
    const history = page.locator(".historical-messages");
    const conversation = page.locator(".conversation");
    const position = (text?: string) =>
      conversation.evaluate((el, text) => {
        const top = el.getBoundingClientRect().top;
        const message = [...el.querySelectorAll(".assistant-message")].find(
          (message) =>
            text
              ? message.textContent === text
              : message.getBoundingClientRect().bottom > top,
        );
        return {
          text: message?.textContent,
          offset: message
            ? message.getBoundingClientRect().top - top
            : Infinity,
        };
      }, text);
    await expect(history).toContainText("item 74");
    await expect(history.getByRole("status")).toBeHidden();
    await conversation.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    const held = await holdHistory(page, id, true);
    await history.getByRole("button", { name: /earlier messages/i }).click();
    await held.arrival;
    await expect(page.locator(".conversation-loading")).toHaveCount(0);
    const beforeSwitch = await position();
    await choose(page, "Local reports");
    await expect.poll(held.cancelled).toBe(true);
    if (completion === "while away") {
      held.release();
      await held.done;
      await page.unrouteAll({ behavior: "wait" });
      await expect(page.locator(".conversation")).not.toContainText(
        "Historical reports item",
      );
    }
    await choose(page, "Historical reports");
    await expect
      .poll(async () =>
        Math.abs(
          (await position(beforeSwitch.text!)).offset - beforeSwitch.offset,
        ),
      )
      .toBeLessThanOrEqual(1);
    if (completion === "after return") {
      held.release();
      await held.done;
      await page.unrouteAll({ behavior: "wait" });
    }
    await expect(history.getByRole("status")).toBeHidden();
    // #3745 cancels the earlier consumer on navigation. Retry the unchanged
    // opaque cursor, then verify a real prepend preserves the current anchor.
    const retry = await holdHistory(page, id, true);
    await history.getByRole("button", { name: /earlier messages/i }).click();
    await retry.arrival;
    expect(retry.cursor()).toBe(held.cursor());
    if (completion === "after return") {
      await conversation.evaluate(async (el) => {
        el.scrollTop = 700;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
    }
    const before = await position();
    expect(before.text).toContain("Historical reports item");
    retry.release();
    await retry.done;
    await expect(history.getByRole("status")).toBeHidden();
    await expect
      .poll(async () =>
        Math.abs((await position(before.text!)).offset - before.offset),
      )
      .toBeLessThanOrEqual(1);
    await page.unrouteAll({ behavior: "wait" });
    await conversation.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(history).toContainText("item 15");
    await uniqueVisibleMessages(page);
    await history.getByRole("button", { name: /earlier messages/i }).click();
    await expect(history.getByRole("status")).toBeHidden();
    await conversation.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(history).toContainText("item 0");
    await expect(
      history.getByRole("button", { name: /earlier messages/i }),
    ).toHaveCount(0);
    await expect.poll(() => delivered.size).toBe(75);
    expect([...delivered.keys()].sort()).toEqual(
      Array.from({ length: 75 }, (_, i) => `history-${i}`).sort(),
    );
    const rendered = new Set<string>();
    const size = await conversation.evaluate((el) => ({
      height: el.scrollHeight,
      viewport: el.clientHeight,
    }));
    for (let scroll = 0; scroll < size.height; scroll += size.viewport / 2) {
      await conversation.evaluate((el, scroll) => {
        el.scrollTop = scroll;
      }, scroll);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const ids = await history
        .locator("[data-message-id]")
        .evaluateAll((elements) =>
          elements.map((el) => el.getAttribute("data-message-id")!),
        );
      expect(new Set(ids).size).toBe(ids.length);
      const indices = ids.map((id) => Number(id.slice("history-".length)));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      ids.forEach((id) => rendered.add(id));
    }
    expect([...rendered].sort()).toEqual(
      Array.from({ length: 75 }, (_, i) => `history-${i}`).sort(),
    );
  });
