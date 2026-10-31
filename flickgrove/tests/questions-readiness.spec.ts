import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test("original notification/detail updates/HTTP readiness loop", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: process.env.GROVE_LOOP_MINIMAL ? "working" : "long" },
  });
  await page.goto(origin);
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
  const started = Date.now();
  const events: { event: string; ms: number }[] = [];
  let count = 0,
    aborted = 0;
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/read/questions")) {
      aborted++;
      events.push({ event: "abort", ms: Date.now() - started });
    }
  });
  const gates: (() => void)[] = [];
  await page.route("**/api/read/questions?*", async (route) => {
    count++;
    events.push({ event: "HTTPstart", ms: Date.now() - started });
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin },
    });
    events.push({ event: "HTTPready", ms: Date.now() - started });
    expect(response.status()).toBe(200);
    if (process.env.GROVE_LOOP_NO_GATE) gates.push(() => {});
    else await new Promise<void>((resolve) => gates.push(resolve));
    await route.fulfill({ response }).then(
      () => events.push({ event: "fulfilled", ms: Date.now() - started }),
      () => {},
    );
  });
  events.push({ event: "notification", ms: Date.now() - started });
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionId: "readiness", questionOptions: false },
  });
  await expect(page.locator(".question-panel")).toBeVisible();
  await expect.poll(() => gates.length).toBe(1);
  for (let i = 0; i < Number(process.env.GROVE_LOOP_UPDATES ?? 3); i++) {
    await request.post(origin + "/fixture/change", {
      data: { append: { agentId: "orc", text: `Ordinary update ${i}` } },
    });
    await expect(page.locator(".conversation")).toContainText(
      `Ordinary update ${i}`,
    );
  }
  gates[0]();
  const panel = page.locator(".question-panel");
  const visible = await panel
    .getByRole("heading", { level: 3 })
    .waitFor({ state: "visible", timeout: 1200 })
    .then(
      () => true,
      () => false,
    );
  console.log(
    "SIGNAL",
    JSON.stringify({
      events,
      count,
      aborted,
      visible,
      empty: await panel.locator(".list-empty").count(),
    }),
  );
  await page.unroute("**/api/read/questions?*");
  for (const release of gates) release();
  if (!visible) {
    await panel
      .getByRole("button", { name: "Collapse questions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "1 pending question", exact: true })
      .click();
  }
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText(
    "readiness question 1",
  );
  await expect(panel.locator("textarea")).toBeEditable();
  events.push({ event: "editableDOM", ms: Date.now() - started });
  console.log(
    "RECOVERY",
    JSON.stringify({ events, count, aborted, requiredToggle: !visible }),
  );
  expect(
    visible,
    "Question became editable from its completed first read without close/reopen",
  ).toBe(true);
});

test("question body does not wait for unrelated answer recovery", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.goto(origin);
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "first",
      questionOptions: false,
      sendMode: "accepted",
    },
  });
  const panel = page.locator(".question-panel");
  await panel.locator("textarea").fill("Frozen answer");
  await panel
    .getByRole("button", { name: "Send all answers", exact: true })
    .click();
  await expect(panel).not.toBeVisible();
  const gates: (() => void)[] = [];
  await page.route("**/api/read/recovery?*", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin },
    });
    expect(response.status()).toBe(200);
    await new Promise<void>((resolve) => gates.push(resolve));
    await route.fulfill({ response }).catch(() => {});
  });
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionId: "next", questionOptions: false },
  });

  const visible = await panel
    .getByRole("heading", { name: "next question 1", exact: true })
    .waitFor({ state: "visible", timeout: 1200 })
    .then(
      () => true,
      () => false,
    );
  console.log("RECOVERY_GATE", JSON.stringify({ visible, held: gates.length }));
  for (const release of gates) release();
  await page.unroute("**/api/read/recovery?*");
  expect(visible, "New question body renders while recovery is held").toBe(
    true,
  );
});
