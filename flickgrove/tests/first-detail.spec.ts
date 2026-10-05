import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const change = (page: Page, data: object) =>
  page.request.post(origin + "/fixture/change", { data });
async function choose(page: Page, title: string) {
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
for (const width of [1440, 390])
  test(`${width} first open paints target scaffold, retains Composer node/draft/caret and starts transcript at bottom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset", {
      data: { mode: "long" },
    });
    await page.goto(origin);
    await choose(page, "Streaming voice input");
    await expect(
      page.getByRole("button", { name: "Session settings", exact: true }),
    ).toBeEnabled();
    await change(page, { detailDelay: 1200 });
    await page.evaluate(() => {
      (window as any).firstFrames = [];
      let i = 0;
      const sample = () => {
        const d = document.querySelector(".agent-detail");
        const row = document.querySelector(
          '.session-open[aria-current="true"]',
        );
        (window as any).firstFrames.push({
          selected: row?.getAttribute("aria-label"),
          title: d?.getAttribute("aria-label"),
          composer: !!d?.querySelector(".composer"),
          whole: !!document.querySelector(".detail-empty"),
          text: d?.querySelector(".conversation")?.textContent,
          bottom: (() => {
            const el = d?.querySelector(".conversation");
            return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
          })(),
        });
        if (++i < 240) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await choose(page, "Reader performance");
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await expect(page.locator(".detail-loading")).toBeVisible();
    await input.fill("first pending draft");
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(3, 9);
      (window as any).pendingInput = el;
      (window as any).pendingHeading =
        document.querySelector(".detail-heading");
      (window as any).pendingBounds = document
        .querySelector(".composer")!
        .getBoundingClientRect()
        .toJSON();
    });
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Session settings", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Tree Fast", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Alt+m");
    await expect(
      page.getByRole("dialog", { name: "Session settings" }),
    ).toBeHidden();
    await page.screenshot({
      path: `../.scratch/flickgrove-first-detail-tree-fast/${width}-pending.png`,
    });
    await expect(page.locator(".detail-loading")).toBeHidden({
      timeout: 10000,
    });
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el === (window as any).pendingInput,
        document.querySelector(".detail-heading") ===
          (window as any).pendingHeading,
        document.activeElement === el,
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([true, true, true, 3, 9]);
    await expect(input).toHaveValue("first pending draft");
    const proof = await page.evaluate(() => ({
      frames: (window as any).firstFrames.filter(
        (f: any) => f.selected === "Open Reader performance Orc",
      ),
      bounds: document
        .querySelector(".composer")!
        .getBoundingClientRect()
        .toJSON(),
      pending: (window as any).pendingBounds,
      bottom: (() => {
        const el = document.querySelector(".conversation")!;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
      })(),
    }));
    expect(proof.frames.length).toBeGreaterThan(2);
    expect(
      proof.frames.every(
        (f: any) =>
          f.title === "Reader performance" &&
          f.composer &&
          !f.whole &&
          !f.text?.includes("Streaming voice input: Paragraph"),
      ),
    ).toBe(true);
    expect(proof.bounds.y).toBe(proof.pending.y);
    expect(proof.bounds.height).toBe(proof.pending.height);
    expect(proof.bottom).toBeLessThan(2);
    expect(
      proof.frames
        .filter((f: any) => f.text?.includes("Reader performance: Paragraph"))
        .every((f: any) => f.bottom < 2),
    ).toBe(true);
    console.log(
      JSON.stringify({
        width,
        ...proof,
        frames: proof.frames.map((f: any) => ({
          ...f,
          text: f.text?.slice(0, 100),
        })),
      }),
    );
    await page.screenshot({
      path: `../.scratch/flickgrove-first-detail-tree-fast/${width}-ready.png`,
    });
  });
test("first-open failure retains target and draft, explicit Retry fills same frame; rapid selections and offline target remain isolated", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset", {
    data: { mode: "long" },
  });
  await page.goto(origin);
  await choose(page, "Streaming voice input");
  await change(page, { detailFailure: true, detailDelay: 200 });
  await choose(page, "Reader performance");
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("recoverable draft");
  await expect(page.locator(".detail-loading")).toContainText(
    "Synthetic detail unavailable",
  );
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/1440-detail-error.png",
  });
  await change(page, { detailFailure: false });
  await page
    .locator(".detail-loading")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.locator(".detail-loading")).toBeHidden();
  await expect(input).toHaveValue("recoverable draft");
  await change(page, { detailDelay: 800 });
  await choose(page, "Streaming voice input");
  await choose(page, "Reader performance");
  await choose(page, "Streaming voice input");
  await page.waitForTimeout(1800);
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    "Streaming voice input",
  );
  await expect(page.locator(".conversation")).not.toContainText(
    "Reader historical",
  );
  await change(page, { outage: true });
  await choose(page, "Reader performance");
  await expect(input).toHaveValue("recoverable draft");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
});

test("390 pending Worker remains read-only and Back dismisses it before late detail arrives", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.request.post(origin + "/fixture/reset", {
    data: { mode: "working" },
  });
  await page.goto(origin);
  await choose(page, "Reader performance");
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page
    .locator(".session-item")
    .filter({
      has: page.getByRole("button", {
        name: "Open Reader performance Orc",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Expand Workers" })
    .click();
  await change(page, { detailDelay: 1200 });
  await page
    .getByRole("button", {
      name: "Open Reader implementation Worker",
      exact: true,
    })
    .click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    "Reader implementation",
  );
  await expect(page.locator(".detail-loading")).toBeVisible();
  await expect(page.locator(".read-only")).toBeVisible();
  await expect(page.locator(".composer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-worker-pending.png",
  });
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.waitForTimeout(1800);
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Open Reader implementation Worker",
      exact: true,
    }),
  ).toBeVisible();
});
