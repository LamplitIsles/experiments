import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
for (const failure of ["reads", "reads-and-optional-writes", "journal-write"]) {
  test(`unavailable ${failure}: navigation/settings work and required journal failure retains input`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    const initialInputs = (
      await (await request.get(origin + "/fixture/info")).json()
    ).inputs;
    const { agents } = await (
      await request.get(origin + "/fixture/snapshot")
    ).json();
    const draftKey = `flickgrove/${origin}/composer/${agents[0].id}`;
    await page.addInitScript(
      ({ failure, draftKey }) => {
        const local = localStorage,
          get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        set.call(local, draftKey, "Unreadable existing draft");
        Storage.prototype.getItem = function (key) {
          if (this === local && failure !== "journal-write")
            throw new DOMException("Blocked reads", "SecurityError");
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (
            this === local &&
            (failure === "journal-write"
              ? key.includes("/outgoing/")
              : failure === "reads-and-optional-writes" &&
                /\/(sidebar-open|expanded|collapsed-orgs|list-scroll|tree-order|selection|models|preferences|entry|weekly\/[^/]+)$/.test(
                  key,
                ))
          )
            throw new DOMException("Blocked writes", "SecurityError");
          return set.call(this, key, value);
        };
      },
      { failure, draftKey },
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await expect(page.locator(".workbench")).toBeVisible();
    const toggle = page.getByRole("button", {
      name: "Toggle Sidebar",
      exact: true,
    });
    await toggle.click();
    await expect(
      page.locator('[data-slot="sidebar"][data-state]'),
    ).toHaveAttribute("data-state", "collapsed");
    await toggle.click();
    await page
      .getByRole("button", { name: "Expand Workers", exact: true })
      .first()
      .click();
    const worker = agents.find(
      (agent: { ownerId?: string }) => agent.ownerId === agents[0].id,
    );
    await page.locator(`[data-agent-id="${worker.id}"]`).click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc", exact: true }),
    ).toHaveCount(0);
    await page.locator(`[data-agent-id="${agents[0].id}"]`).click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(input).toBeEnabled();
    await input.fill("Retain this in-memory draft");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeHidden();
    await expect(input).toHaveValue("Retain this in-memory draft");
    await expect(
      page.getByRole("button", { name: "Weekly usage", exact: true }),
    ).toContainText("28%");
    if (failure !== "journal-write")
      expect(await page.evaluate((key) => localStorage[key], draftKey)).toBe(
        "Unreadable existing draft",
      );
    await input.press("Enter");
    await expect(page.getByRole("alert")).toContainText(
      failure === "journal-write" ? "Blocked writes" : "Blocked reads",
    );
    await expect(input).toHaveValue("Retain this in-memory draft");
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(initialInputs);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `../.scratch/collapsible-session-sidebar/storage-denied/green-${failure}.png`,
      animations: "disabled",
    });
  });
}
