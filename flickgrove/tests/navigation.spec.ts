import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
for (const surface of [
  "detail",
  "settings",
  "hosts",
  "new",
  "skill",
  "worker",
  "weekly",
  "title",
  "questions",
] as const) {
  test(`mobile browser Back stays in Grove from ${surface}`, async ({
    page,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, { data: {} });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:14318/");
    await page.goto(origin);
    await expect(page.locator(".session-open").first()).toBeVisible();
    if (surface === "hosts")
      await page.getByRole("button", { name: "Hosts", exact: true }).click();
    else if (surface === "settings")
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    else if (surface === "new")
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click();
    else {
      if (surface === "worker") {
        await page
          .getByRole("button", { name: "Expand Workers" })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Open Voice input Worker" })
          .click();
      } else await page.locator(".session-open").first().click();
      await expect(page.locator(".agent-detail")).toBeVisible();
      if (surface === "skill") {
        await expect(
          page.getByRole("button", { name: "Add images", exact: true }),
        ).toBeEnabled();
        await page
          .getByRole("textbox", { name: "Message Orc", exact: true })
          .press("Alt+KeyS");
      }
      if (surface === "weekly")
        await page
          .locator(".mobile-back")
          .getByRole("button", { name: "Weekly usage", exact: true })
          .click();
      if (surface === "title")
        await page
          .getByRole("button", { name: "Edit title", exact: true })
          .click();
      if (surface === "questions")
        await page.locator(".questions-toggle").click();
    }
    const dismissed = {
      detail: ".agent-detail",
      worker: ".agent-detail",
      settings: "[role=dialog]",
      hosts: "[role=dialog]",
      new: "[role=dialog]",
      skill: ".skill-search",
      weekly: ".weekly-popover",
      title: ".title-edit",
      questions: ".question-panel",
    };
    await expect(page.locator(dismissed[surface])).toBeVisible();
    await page.goBack();
    await expect(page.locator(dismissed[surface])).toHaveCount(0);
    if (["skill", "weekly", "title", "questions"].includes(surface))
      await expect(page.locator(".agent-detail")).toBeVisible();
    expect(new URL(page.url()).port).toBe("14319");
  });
}

test("mobile list Worker, owner link, draft restore and same-level switching return to list", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:14318/");
  await page.goto(origin);
  await page.locator(".session-open").first().click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Unsent parent draft");
  await page.locator(".mobile-back > button").click();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Open Voice input Worker" }).click();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.reload();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.goBack();
  await expect(page.locator(".session-list")).toBeVisible();
  await page.goForward();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.locator(".owner-link").click();
  await expect(input).toHaveValue("Unsent parent draft");
  await page.getByRole("button", { name: "Edit title" }).click();
  await page
    .getByRole("textbox", { name: "Session title" })
    .fill("Never saved");
  await page.goBack();
  await expect(page.locator(".title-edit")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goBack();
  expect(new URL(page.url()).port).toBe("14318");
});

test("restored nested Worker history returns to its Orc without losing the draft", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  const { hub } = await (await request.get(`${origin}/fixture/info`)).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.locator(".session-open").first().click();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Nested parent draft");
  // A persisted journey from an Orc into its Worker remains valid after this UI refinement.
  await page.evaluate(
    ({ hub }) =>
      history.pushState(
        { grove: { details: [`${hub}:orc`, `${hub}:voice`], surfaces: [] } },
        "",
      ),
    { hub },
  );
  await page.reload();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.getByRole("button", { name: "‹ Orc", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveValue(
    "Nested parent draft",
  );
});

test("a late detail update cannot reopen a dismissed mobile conversation", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await request.post(`${origin}/fixture/reset`, { data: {} });
  let hold = false;
  let queued: (string | Buffer)[] = [];
  let release = () => {};
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      if (hold && JSON.parse(String(raw)).type === "update") queued.push(raw);
      else ws.send(raw);
    });
    release = () => {
      hold = false;
      for (const raw of queued) ws.send(raw);
      queued = [];
    };
  });
  await page.goto(origin);
  await page.locator(".session-open").first().click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  hold = true;
  await request.post(`${origin}/fixture/change`, {
    data: { append: { agentId: "orc", text: "Synthetic late detail" } },
  });
  await expect.poll(() => queued.length).toBeGreaterThan(0);
  await page.goBack();
  release();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(page.locator(".session-list")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
});

test("a closed mobile historical target stays closed on Forward", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  const target = page.getByRole("button", {
    name: "Open Streaming voice input Orc",
  });
  await target.click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(target).toHaveCount(0);
});
