import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
test("reload pins have a native keyboard entry without activating on Tab", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  const { agents, entryId } = await (
    await request.get(origin + "/fixture/snapshot")
  ).json();
  const ids = agents
    .filter((a: { role: string }) => a.role === "orc")
    .slice(0, 2)
    .map((a: { id: string }) => a.id);
  await page.addInitScript(
    ({ ids, entryId }) =>
      localStorage.setItem(
        `flickgrove/${location.origin}/pinned`,
        JSON.stringify({ [entryId]: ids }),
      ),
    { ids, entryId },
  );
  await page.goto(origin);
  await page.reload();
  const pins = page.locator('.session-open[data-location="pinned"]');
  await expect(pins).toHaveCount(2);
  const initialCurrent = await page
    .locator('.session-open[aria-current="true"]')
    .getAttribute("data-agent-id");
  const initialSource = await page
    .locator('.session-open[aria-current="true"]')
    .getAttribute("data-location");
  const initialTitle = await page.locator(".agent-detail h1").textContent();
  // Enter the section through native browser focus order; no click or synthetic focus.
  for (
    let i = 0;
    i < 30 &&
    !(await pins.first().evaluate((el) => el === document.activeElement));
    i++
  ) {
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveAttribute("data-agent-id", initialCurrent!);
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveAttribute("data-location", initialSource!);
    await expect(page.locator(".agent-detail h1")).toHaveText(initialTitle!);
  }
  await expect(pins.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pins.first()).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pins.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pins.first()).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await expect(pins.nth(1)).toBeFocused();
  await expect(pins.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(page.locator('.session-open[aria-current="true"]')).toHaveCount(
    1,
  );
});

for (const width of [1440, 390])
  test(`cursor and button menus share guarded Orc close and member-only pin at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await openSidebar(page);
    const inputCount = (
      await (await request.get(origin + "/fixture/info")).json()
    ).inputs;
    const row = page.locator('.session-open[data-location="tree"]').first();
    const box = (await row.boundingBox())!;
    const point = { x: box.x + 30, y: box.y + 16 };
    const initial = await page.locator(".agent-detail h1").allTextContents();
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "Pin",
      "Close this tree",
    ]);
    const popup = (await page.getByRole("menu").boundingBox())!;
    expect(Math.abs(popup.x - point.x)).toBeLessThan(12);
    expect(Math.abs(popup.y - point.y)).toBeLessThan(12);
    await expect(page.locator(".agent-detail h1")).toHaveText(initial);
    await page.screenshot({
      path: `../.scratch/pinned-sessions/screenshots/${width}-cursor-menu.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await row.click({ button: "right" });
    await page.goBack();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".session-list")).toBeVisible();
    await page
      .getByRole("button", {
        name: "Menu for Streaming voice input",
        exact: true,
      })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Pin",
      "Close this tree",
    ]);
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(page.locator(".pinned-sessions .session-open")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Expand Workers", exact: true })
      .first()
      .click();
    const member = page
      .locator('.session-open[data-location="tree"]')
      .filter({ hasText: "Voice input" })
      .nth(1);
    await member.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["Pin"]);
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "still working or has an unconfirmed delivery" })
        .first(),
    ).toBeVisible();
    await expect(page.locator(".pinned-sessions .session-open")).toHaveCount(1);
    await openSidebar(page);
    // Existing closeTree accepts an idle tree; no new lifecycle or close endpoint.
    for (const agentId of ["reader-orc", "reader"])
      await request.post(origin + "/fixture/change", {
        data: {
          execution: {
            agentId,
            event: { type: "completed", status: "completed" },
          },
        },
      });
    await page
      .getByRole("button", { name: "Menu for Reader performance", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page
      .locator(".pinned-sessions .session-open")
      .filter({ hasText: "Reader performance" })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .click();
    await expect(page.locator(".pinned-sessions .session-open")).toHaveCount(1);
    await expect(
      page.locator(".session-open").filter({ hasText: "Reader performance" }),
    ).toHaveCount(0);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(inputCount);
  });

test("selected working Orc refusal stays visible in the foreground mobile Sidebar", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await openSidebar(page);
  await page.locator('.session-open[data-location="tree"]').first().click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("keep selected close draft");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 7));
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs;
  await openSidebar(page);
  await page
    .getByRole("button", {
      name: "Menu for Streaming voice input",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Close this tree", exact: true })
    .click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('.agent-detail [role="alert"]')).toContainText(
    "still working or has an unconfirmed delivery",
  );
  await page.screenshot({
    path: "../.scratch/pinned-sessions/screenshots/390-selected-close-refusal.png",
    animations: "disabled",
  });
  await expect(page.locator('.session-list [role="alert"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".session-list")).toBeHidden();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(input).toHaveValue("keep selected close draft");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([3, 7]);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toEqual(before);
});
