import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-workspace-ux/screenshots";
const active = (page: Page) =>
  page.locator(".session-item.active .session-open");
const title = (page: Page) => page.locator(".agent-detail h1");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
async function filter(page: Page, name: string) {
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name, exact: true })
    .click();
}

test("persistent selection, circular physical shortcuts, visible numeric index and guarded drafts", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  const rows = page.locator(".session-open");
  const ids = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")),
  );
  await composer(page).fill("First unsent draft");
  await composer(page).press("Alt+k");
  await expect(active(page)).toHaveAttribute("data-agent-id", ids.at(-1)!);
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("Last draft");
  await composer(page).press("Alt+j");
  await expect(composer(page)).toHaveValue("First unsent draft");
  await composer(page).dispatchEvent("keydown", {
    key: "∆",
    code: "KeyJ",
    altKey: true,
  });
  await expect(active(page)).toHaveAttribute("data-agent-id", ids[1]!);
  await composer(page).press("Meta+1");
  await expect(composer(page)).toHaveValue("First unsent draft");
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await composer(page).press("Meta+2");
  await expect(title(page)).toHaveText("Voice input");
  await expect(composer(page)).toHaveCount(0);
  await expect(page.locator(".read-only")).toContainText("Read-only");
  await page.screenshot({ path: `${shots}/desktop-worker.png` });
  await page.keyboard.press("Meta+1");
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("First unsent draft");
  await composer(page).dispatchEvent("keydown", {
    key: "j",
    code: "KeyJ",
    altKey: true,
    isComposing: true,
  });
  await composer(page).dispatchEvent("keydown", {
    key: "2",
    code: "Digit2",
    metaKey: true,
    keyCode: 229,
  });
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).dispatchEvent("compositionstart");
  await composer(page).dispatchEvent("keydown", {
    code: "KeyJ",
    key: "j",
    altKey: true,
  });
  await composer(page).dispatchEvent("keydown", {
    code: "Digit2",
    key: "2",
    metaKey: true,
  });
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).dispatchEvent("compositionend");
  await composer(page).press("Meta+0");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Meta+2");
  await page.keyboard.press("Alt+j");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await composer(page).fill("draft ");
  await composer(page).press("Alt+KeyS");
  await page.keyboard.press("Alt+j");
  await page.keyboard.press("Meta+2");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await filter(page, "Neil’s Mac");
  await expect(title(page)).toHaveText("Reader performance");
  await composer(page).press("Meta+9");
  await expect(title(page)).toHaveText("Reader performance");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Reader performance");
  await filter(page, "NUC");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Voice input");
  await page.keyboard.press("ArrowUp");
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(title(page)).toHaveText("Streaming voice input");
});

test("filter and close choose valid neighbors; empty range stays empty", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(page.getByRole("group", { name: "Host filter" })).toBeVisible();
  await filter(page, "NUC");
  await page.keyboard.press("Alt+x");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(page.locator(".detail-empty")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Alt+j");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop-empty.png` });
  await filter(page, "Neil’s Mac");
  await expect(title(page)).toHaveText("Reader performance");
  await filter(page, "NUC");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
});

test("closing a middle visible session selects its next neighbor and collapsing selected Worker selects Orc", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Meta+3");
  await expect(title(page)).toHaveText("Additional task 2");
  await page.keyboard.press("Alt+x");
  await expect(title(page)).toHaveText("Additional task 3");
  await page.keyboard.press("Meta+1");
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.keyboard.press("Meta+2");
  await expect(title(page)).toHaveText("Voice input");
  await page.getByRole("button", { name: "Collapse Workers" }).first().click();
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(active(page)).toHaveAccessibleName(
    "Open Streaming voice input Orc",
  );
});
