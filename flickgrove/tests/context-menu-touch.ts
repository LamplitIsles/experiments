import { expect, type Locator, type Page } from "@playwright/test";

// Browser touch input reaches Bits' pointer handlers; never synthesize contextmenu.
export async function longPress(page: Page, row: Locator, opensMenu = true) {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 30, y: box.y + 16 }],
  });
  if (opensMenu)
    await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
  else await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  if (opensMenu)
    await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
  else await expect(page.getByRole("menu")).toHaveCount(0);
}
