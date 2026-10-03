import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

test("abbreviated skill query inserts the exact invocation without sending", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.route("**/api/agents/*/skills", (route) =>
    route.fulfill({
      json: [
        { name: "grill-with-docs", description: "Interview a design" },
        { name: "to-orc-impl", description: "Implement a spec" },
      ],
    }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  const search = page.getByRole("combobox", { name: "Search skills…" });
  const messagesBefore = await page.locator(".user-message").count();
  await input.fill("before after");
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(7, 7),
  );
  await input.press("$");
  await search.fill("grdo");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("grill-with-docs");
  await search.press("Tab");
  await expect(input).toHaveValue("before $grill-with-docs after");
  await expect(input).toBeFocused();
  await expect(page.locator(".user-message")).toHaveCount(messagesBefore);
  await input.press("$");
  await search.fill("toorc");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(input).toHaveValue("before $grill-with-docs $to-orc-impl after");
  await expect(page.locator(".user-message")).toHaveCount(messagesBefore);
});
