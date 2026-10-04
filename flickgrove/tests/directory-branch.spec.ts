import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const initial = "feat/a-very-long-checkout-branch-for-directory-identification";
for (const width of [1440, 390])
  test(`directory branches fit compact rows and preserve navigation/drafts at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", {
      data: { mode: "branches" },
    });
    await page.goto(origin);
    const root = page.getByRole("button", {
      name: "Open Streaming voice input Orc",
      includeHidden: true,
    });
    const remote = page.getByRole("button", {
      name: "Open Reader performance Orc",
      includeHidden: true,
    });
    await expect(root.locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    await expect(remote.locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    const row = root.locator("..");
    const height = await row.evaluate((e) => e.getBoundingClientRect().height);
    await page.getByRole("button", { name: "Expand Workers" }).first().click();
    const workers = page.locator(".worker-item");
    await expect(workers).toHaveCount(2);
    await expect(workers.nth(0).locator(".session-branch")).toHaveCount(0);
    await expect(workers.nth(1).locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    const geometry = await root.evaluate((e) => {
      const meta = e.querySelector(".session-meta")!.getBoundingClientRect();
      const branch = e.querySelector(".session-branch > span") as HTMLElement;
      const disclosure = e
        .parentElement!.querySelector(".worker-disclosure")!
        .getBoundingClientRect();
      const indicator = e
        .querySelector(".session-indicators")!
        .getBoundingClientRect();
      return {
        metaHeight: meta.height,
        branchWidth: branch.getBoundingClientRect().width,
        truncated: branch.scrollWidth > branch.clientWidth,
        branchRight: branch.getBoundingClientRect().right,
        disclosureLeft: disclosure.left,
        indicatorRight: indicator.right,
        rowRight: e.getBoundingClientRect().right,
        tab: e.querySelector(".session-branch")!.getAttribute("tabindex"),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.metaHeight).toBe(14);
    expect(geometry.branchWidth).toBeLessThanOrEqual(85);
    expect(geometry.truncated).toBe(true);
    expect(geometry.branchRight).toBeLessThan(geometry.disclosureLeft);
    expect(geometry.indicatorRight).toBeLessThanOrEqual(geometry.rowRight);
    expect(geometry.tab).toBeNull();
    expect(geometry.overflow).toBe(false);
    expect(await row.evaluate((e) => e.getBoundingClientRect().height)).toBe(
      height,
    );
    await page.screenshot({
      path: `../.scratch/flickgrove-directory-branch/screenshots/${width}-long-branch-worker.png`,
    });
    await root.click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await input.fill("Preserve my local draft");
    await input.focus();
    const url = page.url();
    await request.post(origin + "/fixture/change", {
      data: { branch: "feat/local-changed-with-another-long-branch" },
    });
    // On mobile the list is hidden while detail is open; its DOM still updates.
    await expect(root.locator(".session-branch")).toHaveAttribute(
      "title",
      "feat/local-changed-with-another-long-branch",
    );
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Preserve my local draft");
    expect(page.url()).toBe(url);
    await expect(
      page.locator(".session-item.active .session-open"),
    ).toHaveAttribute(
      "data-agent-id",
      (await root.getAttribute("data-agent-id")) ?? "",
    );
    await expect(remote.locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    await request.post(origin + "/fixture/change", {
      data: { branchFailure: true, branch: "feat/after-controlled-failure" },
    });
    await page.waitForTimeout(200);
    await expect(root.locator(".session-branch")).toHaveAttribute(
      "title",
      "feat/local-changed-with-another-long-branch",
    );
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await expect(input).toBeFocused();
    await request.post(origin + "/fixture/change", {
      data: { branchFailure: false },
    });
    await expect(root.locator(".session-branch")).toHaveAttribute(
      "title",
      "feat/after-controlled-failure",
    );
    if (width === 390) await page.keyboard.press("Escape");
    await remote.click();
    await input.fill("Preserve remote draft");
    await request.post(origin + "/fixture/change", {
      data: {
        outage: true,
        branchPeer: true,
        branch: "feat/remote-after-outage",
      },
    });
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    await expect(remote.locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    await page.reload();
    await expect(remote.locator(".session-branch")).toHaveAttribute(
      "title",
      initial,
    );
    await expect(input).toHaveValue("Preserve remote draft");
    await request.post(origin + "/fixture/change", { data: { outage: false } });
    await expect(remote.locator(".session-branch")).toHaveAttribute(
      "title",
      "feat/remote-after-outage",
    );
    if (width === 390) await page.keyboard.press("Escape");
    await root.click();
    await expect(input).toHaveValue("Preserve my local draft");
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs.some(
        (i: { text: string }) => i.text === "Preserve my local draft",
      ),
    ).toBe(false);
  });
