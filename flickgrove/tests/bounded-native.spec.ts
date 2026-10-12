import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
async function choose(page: Page, title: string, host = "Local") {
  const filter = page.getByRole("button", { name: host, exact: true });
  if (!(await filter.isVisible())) await page.keyboard.press("Escape");
  await filter.click();
  const row = page.getByRole("button", {
    name: `Open ${title} Orc`,
    exact: true,
  });
  if (!(await row.isVisible())) await page.keyboard.press("Escape");
  await row.click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    title,
  );
}
for (const width of [1440, 390]) {
  test(`${width} bounded native history uses owning-Peer HTTP, preserves reading and cards, retries full body and catches reconnect arrivals`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/reset");
    const text = "Long original paragraph. ".repeat(2200);
    const messages = Array.from({ length: 111 }, (_, i) => ({
      id: `bounded-${i}`,
      role: "assistant",
      turnId: "one-turn",
      text:
        i === 110
          ? "Latest readable result"
          : i === 109
            ? "Huge original beginning.\n\n" +
              text.repeat(22) +
              "\n\nHuge original ending."
            : `Original item ${i}\n\n${text}`,
      at: 1000 + i,
    }));
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Bounded reading", peer: "remote", messages },
      })
    ).json();
    const reads: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/read/")) reads.push(r.url());
    });
    await page.goto(origin);
    await choose(page, "Bounded reading", "Remote");
    await expect(page.locator(".conversation")).toContainText(
      "Latest readable result",
    );
    await page
      .getByRole("textbox", { name: "Message Orc" })
      .fill("Draft stays available");
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    expect(
      reads.some(
        (url) => new URL(url).port === "14321" && url.includes("/messages?"),
      ),
    ).toBe(true);
    const conversation = page.locator(".conversation");
    await conversation.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(
      page.getByRole("button", { name: /earlier messages/i }),
    ).toBeVisible();
    const before = await conversation.evaluate((el) => el.scrollTop);
    await page.getByRole("button", { name: /earlier messages/i }).click();
    await expect(page.locator(".history-controls [role=status]")).toHaveCount(
      0,
    );
    expect(
      await conversation.evaluate((el) => el.scrollTop),
    ).toBeGreaterThanOrEqual(before);
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    const full = page.getByRole("button", {
      name: "Read full message",
      exact: true,
    });
    await expect(full).toBeVisible();
    let failed = false;
    await page.route("**/api/read/body?**", async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "X-Grove-Peer": id.split(":")[0],
          },
          json: { error: "Synthetic body read failed" },
        });
      } else await route.continue();
    });
    await full.click();
    await expect(page.locator(".message-body [role=alert]")).toHaveText(
      "Synthetic body read failed",
    );
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator('[data-message-id="bounded-109"]')).toContainText(
      "Huge original ending.",
    );
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        report: "Native report body.\n\nIdentical report details.",
        text: "Report request complete",
      },
    });
    await conversation.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator(".worker-report")).toHaveCount(1);
    await expect(page.locator(".worker-report")).not.toHaveAttribute("open");
    await page.locator(".worker-report summary").click();
    await expect(page.locator(".report-content")).toContainText(
      "Identical report details.",
    );
    await page.screenshot({
      path: `../.scratch/bounded-native-conversation/${width}-native-card.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.request.post(origin + "/fixture/offline");
    await expect(page.locator(".conversation .host-outage")).toBeVisible();
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        text: "Arrived during disconnection",
        input: "Offline native input",
      },
    });
    await page.request.post(origin + "/fixture/online");
    await expect(page.locator(".conversation")).toContainText(
      "Arrived during disconnection",
      { timeout: 15000 },
    );
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    expect(
      await conversation.locator('[data-message-id^="live-item"]').count(),
    ).toBeLessThanOrEqual(2);
  });
}

test("cancelled and late HTTP pages stay with their original conversation; reading failure keeps submission connected", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  const add = async (title: string, count: number) =>
    (
      await (
        await page.request.post(origin + "/fixture/history", {
          data: { title, count },
        })
      ).json()
    ).id;
  const a = await add("Cancellation A", 75),
    b = await add("Cancellation B", 35);
  await page.goto(origin);
  await choose(page, "Cancellation A");
  await expect(page.locator(".conversation")).toContainText(
    "Cancellation A item 74",
  );
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 0;
  });
  const gate = Promise.withResolvers<void>(),
    arrival = Promise.withResolvers<void>();
  let cancelled = false;
  page.on("requestfailed", (r) => {
    if (
      r.url().includes("/api/read/messages") &&
      r.url().includes(encodeURIComponent(a))
    )
      cancelled = true;
  });
  await page.route("**/api/read/messages?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      arrival.resolve();
      await gate.promise;
    }
    await route.continue().catch(() => {});
  });
  await page.getByRole("button", { name: /earlier messages/i }).click();
  await arrival.promise;
  await choose(page, "Cancellation B");
  await expect(page.locator(".conversation")).toContainText(
    "Cancellation B item 34",
  );
  gate.resolve();
  await expect.poll(() => cancelled).toBe(true);
  await expect(page.locator(".conversation")).not.toContainText(
    "Cancellation A item",
  );
  await page.unrouteAll({ behavior: "wait" });
  await choose(page, "Cancellation A");
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole("button", { name: /earlier messages/i }).click();
  await expect(page.locator(".history-controls [role=status]")).toHaveCount(0);
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator(".conversation")).toContainText(
    "Cancellation A item 15",
  );
  let fail = true;
  await page.route("**/api/read/messages?**", async (route) => {
    if (fail && new URL(route.request().url()).searchParams.has("cursor")) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: "Synthetic page unavailable" },
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: /earlier messages/i }).click();
  await expect(page.locator(".history-controls [role=alert]")).toHaveText(
    "Synthetic page unavailable",
  );
  const composer = page.getByRole("textbox", { name: "Message Orc" });
  await composer.fill("Submit while earlier history unavailable");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
  await composer.press("Enter");
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${origin}/api/read/messages?${new URLSearchParams({ agent: a })}`,
        { headers: { Origin: origin, "X-Grove-Peer": a.split(":")[0] } },
      );
      const result = await response.json();
      return result.messages.some(
        (m: { text: string; delivery?: { status: string } }) =>
          m.text === "Submit while earlier history unavailable" &&
          m.delivery?.status === "sent",
      );
    })
    .toBe(true);
  await expect(page.locator(".conversation")).toContainText(
    "Cancellation A item 15",
  );
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".history-controls [role=alert]")).toHaveCount(0);
  await page.locator(".conversation").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator(".conversation")).toContainText(
    "Cancellation A item 0",
  );
  expect(b).not.toBe(a);
});
