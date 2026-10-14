import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";

test("completed messages are readable during work without moving the reading anchor", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const change = (event: object) =>
    request.post(origin + "/fixture/change", {
      data: { execution: { event } },
    });
  await change({ type: "working", turnId: "long-turn" });
  const conversation = page.locator(".conversation");
  await expect(page.locator(".detail-status")).toContainText("Working");
  await expect(conversation).toContainText("Paragraph 70");
  await conversation.evaluate((el) => {
    el.scrollTop = 500;
  });
  await expect
    .poll(() => conversation.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(400);
  const anchor = await conversation.evaluate((el) => el.scrollTop);
  await change({ type: "progress" });
  for (const phase of ["commentary", "final_answer"]) {
    await change({
      type: "item",
      item: {
        type: "agentMessage",
        id: phase,
        phase,
        text: `Complete ${phase} during work`,
      },
    });
  }
  await expect
    .poll(() =>
      conversation.evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeGreaterThan(anchor);
  await expect
    .poll(() =>
      conversation.evaluate(
        (el, position) => Math.abs(el.scrollTop - position),
        anchor,
      ),
    )
    .toBeLessThan(3);
  const down = page.getByRole("button", { name: "Jump to bottom" });
  await down.click();
  await expect(conversation).toContainText("Complete commentary during work");
  await expect(conversation).toContainText("Complete final_answer during work");
  await expect(page.locator(".detail-status")).toContainText("Working");
  await change({
    type: "item",
    item: {
      type: "agentMessage",
      id: "following",
      text: "Complete following message",
    },
  });
  await expect(conversation).toContainText("Complete following message");
  await expect
    .poll(() =>
      conversation.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await page.screenshot({
    path: "../.scratch/completed-message-visibility/screenshots/working-complete.png",
  });
  await page.reload();
  await expect(conversation).toContainText("Complete commentary during work");
  await expect(
    page.getByText("Complete commentary during work", { exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".detail-status")).toContainText("Working");
});
