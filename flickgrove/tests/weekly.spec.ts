import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test("page Peer quota cache survives failure, missing data, reload and a different selected Peer", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", { data: { usage: 64 } });
  await page.goto(origin);
  const ring = page.locator(".app-header .weekly-button strong");
  await expect(ring).toHaveText("64%");
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await expect(page.locator(".weekly-source")).toContainText("Resets");
  await request.post(origin + "/fixture/change", {
    data: { quotaFailure: true },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await page.reload();
  await expect(ring).toHaveText("64%");
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await request.post(origin + "/fixture/change", {
    data: { quotaFailure: false, usage: null },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await request.post(origin + "/fixture/change", {
    data: { usage: 47, quotaResets: null },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("47%");
  await expect(page.locator(".weekly-source")).not.toContainText("Resets");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-back .weekly-button strong")).toHaveText(
    "47%",
  );
});

test("model refresh failure retains available choices and recovery refreshes them", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await expect(page.locator(".app-header .weekly-button strong")).toHaveText(
    "72%",
  );
  await request.post(origin + "/fixture/change", {
    data: { modelFailure: true },
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.locator(".role-settings").first().getByRole("combobox").first(),
  ).toHaveValue("gpt-6.1-sol");
  await page.keyboard.press("Escape");
  await request.post(origin + "/fixture/change", {
    data: { modelFailure: false },
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.locator(".role-settings").first().getByRole("combobox").first(),
  ).toHaveValue("gpt-6.1-sol");
});
