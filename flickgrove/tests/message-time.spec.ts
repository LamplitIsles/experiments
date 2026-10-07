import sharp from "sharp";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
const design = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-time";
test.use({ timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`${width} times survive history reload, report expansion and pending confirmation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(origin + "/fixture/reset");
    const today = Date.now(),
      previous = today - 86400000;
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: {
          title: "Message time",
          messages: [
            {
              id: "old-user",
              role: "user",
              text: "Historical user message",
              at: previous,
            },
            {
              id: "old-answer",
              role: "assistant",
              text: "Historical answer with missing time",
              at: 0,
            },
            {
              id: "today-answer",
              role: "assistant",
              text:
                "Current answer.\n\n" +
                "A longer paragraph wraps naturally beside compact metadata. ".repeat(
                  5,
                ),
              at: today,
            },
          ],
        },
      })
    ).json();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Message time Orc", exact: true })
      .click();
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
    const oldTime = row("old-user").locator("time");
    await expect(oldTime).toBeVisible();
    const oldLabel = await oldTime.textContent();
    expect(oldLabel).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
    await expect(oldTime).toHaveAttribute(
      "datetime",
      new Date(previous).toISOString(),
    );
    await expect(oldTime).toHaveAttribute("title", /GMT\+8/);
    await expect(oldTime).not.toHaveAttribute("tabindex");
    await expect(row("old-answer").locator("time")).toHaveCount(0);
    await expect(row("today-answer").locator("time")).toHaveText(
      /^\d{2}:\d{2}$/,
    );
    await page.screenshot({ path: `${shots}/${width}-history.png` });
    await page.reload();
    await expect(row("old-user").locator("time")).toHaveText(oldLabel!);
    await expect(row("old-answer").locator("time")).toHaveCount(0);
    // Establish the reader's end position after asynchronous initial measurements.
    await expect
      .poll(async () =>
        page.locator(".conversation").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(1);
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: "User sends a live message",
        text: "Assistant response",
        report:
          "Time report\n\n" +
          "Long report paragraph. ".repeat(30) +
          "\n\n[Worker chart](plot.png)",
      },
    });
    const report = page.locator(".worker-report");
    await expect(report.locator("time")).toBeVisible();
    const reportTime = await report.locator("time").getAttribute("datetime");
    await expect
      .poll(() =>
        page
          .locator(".conversation")
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${shots}/${width}-report-folded.png` });
    await report.locator("summary").click();
    await expect(report.locator(".report-content")).toBeVisible();
    await expect(report.locator("time")).toHaveAttribute(
      "datetime",
      reportTime!,
    );
    await expect
      .poll(() =>
        page
          .locator(".conversation")
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${shots}/${width}-report-expanded.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.request.post(design + "/fixture/reset", {
      data: { mode: "long" },
    });
    await page.goto(design);
    if (width === 390) await page.locator(".session-open").first().click();
    await page.request.post(design + "/fixture/change", {
      data: { sendMode: "held" },
    });
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await page.getByLabel("Choose message images").setInputFiles({
      name: "time-image.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 600, height: 240, channels: 3, background: "#406f91" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await composer.fill("Time pending message");
    await composer.press("Enter");
    const pending = page
      .locator(".user-message")
      .filter({ hasText: "Time pending message" });
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("time")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some(
            (key) =>
              key.includes("/outgoing/") &&
              JSON.parse(localStorage.getItem(key) ?? "null")?.status ===
                "sending",
          ),
        ),
      )
      .toBe(true);
    await expect(pending.locator(".message-image")).toBeVisible();
    const pendingId = await pending.evaluate((el) =>
      el.closest("[data-message-id]")!.getAttribute("data-message-id"),
    );
    const pendingTime = await pending.locator("time").getAttribute("datetime");
    await page.screenshot({ path: `${shots}/${width}-pending.png` });
    await page.request.post(design + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) => key.includes("/accepted/")),
        ),
      )
      .toBe(true);
    await expect(pending).toHaveCount(1);
    await expect(page.locator(`[data-message-id="${pendingId}"]`)).toHaveCount(
      1,
    );
    const confirmedTime = await pending
      .locator("time")
      .getAttribute("datetime");
    expect(
      Math.abs(Date.parse(confirmedTime!) - Date.parse(pendingTime!)),
    ).toBeLessThan(60000);
    await expect(pending.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
    await page.reload();
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("time")).toHaveAttribute(
      "datetime",
      confirmedTime!,
    );
    await page.screenshot({ path: `${shots}/${width}-confirmed.png` });
    expect(errors).toEqual([]);
  });
}
