import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

const origin = "http://127.0.0.1:14319";
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const panel = (page: Page) => page.locator(".question-panel");
const change = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.post(origin + "/fixture/change", { data });
async function open(page: Page, request: APIRequestContext, width = 1440) {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(origin);
  if (width === 390) await page.locator(".session-open").first().click();
  await expect(composer(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
}
async function question(page: Page, request: APIRequestContext, id: string) {
  await change(request, {
    question: true,
    questionId: id,
    questionOptions: false,
  });
  await expect(panel(page).locator("h3")).toHaveText(`${id} question 1`);
}
async function geometry(page: Page) {
  return page.evaluate(() =>
    [".agent-detail", ".conversation-wrap", ".composer"].map((selector) => {
      const { x, y, width, height } = document
        .querySelector(selector)!
        .getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

for (const width of [1440, 390]) {
  test(`${width} Questions overlay preserves geometry; accepted Enter retires surface, Back and explicit history`, async ({
    page,
    request,
  }) => {
    await open(page, request, width);
    await composer(page).fill("Preserved composer draft");
    await question(page, request, "complete");
    await panel(page)
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(panel(page)).toHaveCount(0);
    await page.locator(".conversation").evaluate((el) => (el.scrollTop = 120));
    const before = await geometry(page);
    const position = await page
      .locator(".conversation")
      .evaluate((el) => el.scrollTop);
    await page
      .getByRole("button", { name: "All questions", exact: true })
      .click();
    await expect(panel(page)).toBeVisible();
    expect(await geometry(page)).toEqual(before);
    await page.screenshot({
      path: `../.scratch/flickgrove-host-shortcuts/questions/${width}-overlay.png`,
    });
    await panel(page).locator("textarea").fill("Immutable answer");
    await change(request, { sendMode: "held" });
    await panel(page).locator("textarea").press("Enter");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toContainText("Sending");
    await expect(panel(page)).toBeVisible();
    await change(request, { sendMode: "accepted" });
    await expect(panel(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => history.state.grove.surfaces))
      .toEqual([]);
    const after = await geometry(page);
    if (width === 1440) expect(after).toEqual(before);
    else expect(after[2]).toEqual(before[2]); // Answering removes the mobile Needs input header badge.
    await expect(composer(page)).toHaveValue("Preserved composer draft");
    expect(
      await page.locator(".conversation").evaluate((el) => el.scrollTop),
    ).toBe(position);
    await page
      .getByRole("button", { name: "All questions", exact: true })
      .click();
    await expect(panel(page).locator(".answered-item")).toHaveCount(1);
    await expect(panel(page)).toContainText("Immutable answer");
    await expect(panel(page)).toBeVisible();
    await panel(page)
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(panel(page)).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).backState = undefined;
      window.addEventListener(
        "popstate",
        (event) => {
          (window as any).backState = event.state?.grove;
        },
        { once: true },
      );
      history.back();
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).backState))
      .toEqual({ details: [], surfaces: [] });
    await expect(panel(page)).toHaveCount(0);
    if (width === 390)
      await expect(page.locator(".agent-detail")).toHaveCount(0);
    else await expect(composer(page)).toHaveValue("Preserved composer draft");
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((input: { text: string }) =>
        input.text.includes("Question: complete question 1"),
      ),
    ).toHaveLength(1);
  });
}

for (const mode of ["rejected", "uncertain"]) {
  test(`Questions ${mode} stays visible; only authoritative retry success closes`, async ({
    page,
    request,
  }) => {
    await open(page, request, 390);
    await question(page, request, mode);
    await change(request, { sendMode: mode });
    await panel(page).locator("textarea").fill("Retained immutable answer");
    await panel(page).locator("textarea").press("Enter");
    await expect(panel(page).locator(".answer-batch")).toContainText(
      mode === "rejected"
        ? "Synthetic rejection"
        : "Delivery could not be confirmed",
    );
    await expect(panel(page)).toBeVisible();
    expect(await page.evaluate(() => history.state.grove.surfaces)).toEqual([
      "questions",
    ]);
    if (mode === "rejected") {
      await change(request, { sendMode: "accepted" });
      await panel(page)
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await expect(panel(page)).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => history.state.grove.surfaces))
        .toEqual([]);
    } else {
      await panel(page)
        .getByRole("button", { name: "Check receipt", exact: true })
        .click();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page)).toContainText("Retained immutable answer");
    }
  });
}

test("Late answer completion from another session preserves current questions and drafts", async ({
  page,
  request,
}) => {
  await open(page, request);
  await question(page, request, "original");
  await change(request, { sendMode: "held" });
  await panel(page).locator("textarea").fill("Original answer");
  await panel(page).locator("textarea").press("Enter");
  await expect(panel(page)).toContainText("Sending");
  const originalId = await page.evaluate(() =>
    history.state.grove.details.at(-1),
  );
  const operationId = await panel(page)
    .locator(".answer-batch")
    .getAttribute("data-operation-id");
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await expect(composer(page)).toBeVisible();
  await composer(page).fill("Peer composer draft");
  await change(request, {
    question: true,
    questionId: "peer-pending",
    questionAgent: "peer",
    questionOptions: false,
  });
  await expect(panel(page).locator("h3")).toHaveText("peer-pending question 1");
  await panel(page).locator("textarea").fill("Peer answer draft");
  await change(request, { sendMode: "accepted" });
  await expect
    .poll(async () => {
      const detail = await (
        await request.get(
          origin + "/fixture/agents/" + encodeURIComponent(originalId),
        )
      ).json();
      return detail.deliveries.find(
        (delivery: { id: string }) => delivery.id === operationId,
      )?.status;
    })
    .toBe("sent");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("textarea")).toHaveValue(
    "Peer answer draft",
  );
  await expect(composer(page)).toHaveValue("Peer composer draft");
});

test("900px Completion below Settings retires Questions without stealing foreground focus or leaving a Back layer", async ({
  page,
  request,
}) => {
  await open(page, request, 900);
  await composer(page).fill("Foreground composer draft");
  await question(page, request, "foreground");
  await change(request, { sendMode: "held" });
  await panel(page).locator("textarea").fill("Foreground answer");
  await panel(page).locator("textarea").press("Enter");
  await expect(panel(page)).toContainText("Sending");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const focused = await page.evaluate(() => document.activeElement?.outerHTML);
  await change(request, { sendMode: "accepted" });
  await expect(panel(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual(["settings"]);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(
    focused,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue("Foreground composer draft");
  const parent = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.addEventListener(
          "popstate",
          (event) => resolve(event.state?.grove),
          { once: true },
        );
        history.back();
      }),
  );
  expect(parent).toEqual({ details: [], surfaces: [] });
  await expect(panel(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue("Foreground composer draft");
});
