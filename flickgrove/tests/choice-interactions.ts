import { expect, type Locator, type Page } from "@playwright/test";
/** Choose through the rendered primitive, using the visible label/model identity. */
export async function chooseOption(page: Page, trigger: Locator, text: string) {
  await trigger.click();
  const match = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  await page.getByRole("option").filter({ hasText: match }).first().click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}
