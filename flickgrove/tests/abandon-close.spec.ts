import { openSidebar } from "./browser-actions";
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
let server: ChildProcess;
test.beforeAll(async () => {
  server = spawn("bun", ["tests/abandon-close-serve.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(server.stdout!, "data");
});
test.afterAll(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
});
const action = "Abandon unconfirmed submissions and close";
const shots = "../.scratch/abandon-unconfirmed-session/screenshots";
async function seed(page: Page, target: string, other: string) {
  await page.goto("/");
  await page.evaluate(
    ({ target, other }) => {
      const root = `flickgrove/${location.origin}`;
      const journal = (agentId: string, id: string) =>
        localStorage.setItem(
          `${root}/outgoing/${encodeURIComponent(agentId)}/${id}`,
          JSON.stringify({
            agentId,
            id,
            text: "Original unknown input",
            at: Date.now(),
            status: "sending",
          }),
        );
      journal(target, "original-unknown");
      journal(other, "other-pending");
      journal("other-peer:session", "peer-pending");
    },
    { target, other },
  );
  await page.reload();
  const rows = page.getByRole("button", {
    name: "Open New session Orc",
    exact: true,
  });
  await rows.nth(1).click();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Other draft preserved");
  if (page.viewportSize()!.width < 701) await page.goBack();
  await rows.first().click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Target unsent draft");
}
async function journal(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      Object.keys(localStorage).filter((k) =>
        k.includes(`/outgoing/${encodeURIComponent(id)}/`),
      ).length,
    id,
  );
}
async function close(page: Page) {
  await page.keyboard.press("Alt+KeyX");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: action })).toBeVisible();
}
for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${name}: guarded Close → explicit abandon → pruned journal and stable reload`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const { target, other } = await (
      await request.post("/fixture/reset")
    ).json();
    await seed(page, target, other);
    if (name === "mobile") {
      await page.goBack();
      const row = page.locator(`[data-swipe-id="${target}"]`);
      const box = (await row.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + 250, y: box.y + 20 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: box.x + 160, y: box.y + 20 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
      await row
        .getByRole("button", { name: "Close this tree", exact: true })
        .click();
      await expect(page.getByRole("heading", { name: action })).toBeVisible();
    } else await close(page);
    expect(await journal(page, target)).toBe(1);
    await expect(
      page.getByText("Reception of these submissions is still unknown.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("original-unknown", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${shots}/${name}-confirmation.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await journal(page, target)).toBe(1);
    if (name === "mobile") {
      await page
        .getByRole("heading", { name: "Sessions", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open New session Orc", exact: true })
        .first()
        .click();
    }
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveValue("Target unsent draft");
    await close(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => journal(page, target)).toBe(0);
    expect(await journal(page, other)).toBe(1);
    expect(await journal(page, "other-peer:session")).toBe(1);
    expect(
      await page.evaluate(
        (other) =>
          localStorage.getItem(
            `flickgrove/${location.origin}/composer/${other}`,
          ),
        other,
      ),
    ).toBe("Other draft preserved");
    const info = await (await request.get("/fixture/info")).json();
    expect(info).toMatchObject({
      closed: true,
      lookup: null,
      inputs: 1,
      original: { id: "original-unknown", status: "uncertain" },
    });
    expect(info.active).not.toContain(target);
    await page.reload();
    const remainingRow = page.getByRole("button", {
      name: "Open New session Orc",
      exact: true,
    });
    if (name === "mobile" && (await remainingRow.isVisible()))
      await remainingRow.click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveValue("Other draft preserved");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await journal(page, target)).toBe(0);
    expect((await (await request.get("/fixture/info")).json()).inputs).toBe(1);
    await page.screenshot({ path: `${shots}/${name}-closed.png` });
  });
}

test("native failure keeps journal; explicit retry reads before confirming and blocks duplicate action", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await request.post("/fixture/change", {
    data: { closeFailure: true, closeDelay: 400 },
  });
  const confirm = page.getByRole("button", { name: action, exact: true });
  await confirm.click();
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true }),
  ).toBeDisabled();
  expect(await journal(page, target)).toBe(1);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "fixture native release failed" }),
  ).toBeVisible();
  expect(await journal(page, target)).toBe(1);
  expect((await (await request.get("/fixture/info")).json()).closed).toBe(
    false,
  );
  await request.post("/fixture/change", { data: { closeFailure: false } });
  await confirm.click();
  await expect.poll(() => journal(page, target)).toBe(0);
});

test("new unknown after confirmation is not silently abandoned", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await request.post("/fixture/change", { data: { newUnknown: true } });
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Unconfirmed submissions changed" }),
  ).toBeVisible();
  expect(await journal(page, target)).toBe(1);
  expect((await (await request.get("/fixture/info")).json()).closed).toBe(
    false,
  );
});

test("lost close response reads confirmed closed state and clears once without replay", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args) as WebSocket;
        const send = socket.send.bind(socket);
        let closeId: string | undefined;
        socket.send = (data) => {
          const frame = JSON.parse(String(data));
          if (
            (window as any).dropCloseResult &&
            frame.call?.member === "closeTree" &&
            frame.call.args[0]?.abandonUnknownOperationIds
          )
            closeId = frame.id;
          send(data);
        };
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (closeId && frame.id === closeId && frame.type === "result") {
            event.stopImmediatePropagation();
            closeId = undefined;
          }
        });
        return socket;
      },
    });
  });
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  test.setTimeout(60_000);
  await page.evaluate(() => {
    (window as any).dropCloseResult = true;
  });
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect.poll(() => journal(page, target), { timeout: 40_000 }).toBe(0);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closed: true,
    inputs: 1,
    closeCalls: 2,
  }); // Ordinary refusal + one explicit mutation.
});

test("active turn arriving during confirmation keeps journal and session open", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await request.post("/fixture/change", { data: { active: true } });
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "cannot abandon" }),
  ).toBeVisible();
  expect(await journal(page, target)).toBe(1);
  expect((await (await request.get("/fixture/info")).json()).closed).toBe(
    false,
  );
});

test("late close candidate cannot open over a different conversation", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await request.post("/fixture/change", { data: { candidateDelay: 400 } });
  await page.keyboard.press("Alt+KeyX");
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveValue(
    "Other draft preserved",
  );
  await page.waitForTimeout(600);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await journal(page, target)).toBe(1);
  expect((await (await request.get("/fixture/info")).json()).closed).toBe(
    false,
  );
});

test("committed close survives owner unavailable through catch, reconnect and reload without replay", async ({
  page,
  request,
}) => {
  let unavailable = false,
    explicitId: string | undefined,
    held = false;
  const blocked: number[] = [];
  await page.routeWebSocket("**/api/socket", (socket) => {
    if (unavailable) {
      blocked.push(Date.now());
      socket.close({ code: 1013 });
      return;
    }
    const owner = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (
        frame.call?.member === "closeTree" &&
        frame.call.args[0]?.abandonUnknownOperationIds
      ) {
        explicitId = frame.id;
        held = true;
      }
      owner.send(data);
    });
    owner.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (held && frame.type === "result" && frame.id === explicitId) {
        unavailable = true;
        held = false;
        owner.close({ code: 1011 });
        socket.close({ code: 1011 });
        return;
      }
      if (!held) socket.send(data);
    });
  });
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect.poll(() => blocked.length).toBeGreaterThan(1);
  expect(await journal(page, target)).toBe(1);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closed: true,
    lookup: null,
    closeCalls: 2,
  });
  await expect(
    page
      .getByRole("button", { name: "Check close status", exact: true })
      .first(),
  ).toBeVisible();
  await page.reload(); // Recovery identity survives a reload while the Peer is still unavailable.
  await expect(
    page
      .getByRole("button", { name: "Check close status", exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: action, exact: true }),
  ).toBeVisible();
  expect(await journal(page, target)).toBe(1);
  unavailable = false;
  await expect.poll(() => journal(page, target)).toBe(0);
  expect(await journal(page, other)).toBe(1);
  expect(await journal(page, "other-peer:session")).toBe(1);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveValue(
    "Other draft preserved",
  );
  expect(await journal(page, target)).toBe(0);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closed: true,
    lookup: null,
    closeCalls: 2,
    original: { id: "original-unknown", status: "uncertain" },
  });
});

test("scoped cleanup failure keeps reachable error and read-only retry after detail pruning", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await page.evaluate((target) => {
    const remove = Storage.prototype.removeItem;
    const key = `flickgrove/${location.origin}/outgoing/${encodeURIComponent(target)}/original-unknown`;
    Storage.prototype.removeItem = function (k) {
      if (k === key)
        throw new DOMException("owned cleanup denied", "SecurityError");
      return remove.call(this, k);
    };
  }, target);
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "owned cleanup denied" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check close status", exact: true }),
  ).toBeEnabled();
  expect(await journal(page, target)).toBe(1);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const notice = page.getByRole("status", {
      name: "Finish session close",
      exact: true,
    });
    const composer = page.locator(".composer");
    const n = (await notice.boundingBox())!,
      c = (await composer.boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(n.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await input.click();
    await input.fill("Editable B draft");
    await input.press("Home");
    await input.press("ArrowRight");
    await input.press("x");
    await expect(input).toHaveValue("Exditable B draft");
    expect(
      await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    ).toBe(2);
    await page
      .getByRole("button", { name: "Search skills…", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search skills…" })
      .press("Escape");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    ).toBe(2);
    for (const name of [
      "Discuss",
      "Implement",
      "Review",
      "Re-review",
      "Research",
      "Diagnose",
    ])
      await page.getByRole("button", { name, exact: true }).click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click({ trial: true });
    await page
      .getByRole("button", { name: "Check close status", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "owned cleanup denied" }),
    ).toBeVisible();
    await page.screenshot({
      path: `../.scratch/abandon-unconfirmed-session/visual-ownership-review/layout-${width}-cleanup-error.png`,
    });
  }
  await page.reload(); // Restores the unmodified storage API; recovery performs a fresh closed read.
  await expect.poll(() => journal(page, target)).toBe(0);
  expect(await journal(page, other)).toBe(1);
  expect(await journal(page, "other-peer:session")).toBe(1);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closed: true,
    lookup: null,
    closeCalls: 2,
  });
});

test("close-intent persistence failure prevents native close and preserves pending input", async ({
  page,
  request,
}) => {
  const { target, other } = await (await request.post("/fixture/reset")).json();
  await seed(page, target, other);
  await close(page);
  await page.evaluate((target) => {
    const set = Storage.prototype.setItem;
    const key = `flickgrove/${location.origin}/abandon-close/${encodeURIComponent(target)}`;
    Storage.prototype.setItem = function (k, value) {
      if (k === key)
        throw new DOMException("owned close intent denied", "SecurityError");
      return set.call(this, k, value);
    };
  }, target);
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "owned close intent denied" }),
  ).toBeVisible();
  expect(await journal(page, target)).toBe(1);
  expect(await (await request.get("/fixture/info")).json()).toMatchObject({
    closed: false,
    lookup: null,
    closeCalls: 1,
  });
});

async function holdRecoveryRead(page: Page, target: () => string | undefined) {
  const held: (() => void)[] = [];
  const control = { dropClose: false, closed: false, open: false, held };
  await page.routeWebSocket("**/api/socket", (socket) => {
    const owner = socket.connectToServer();
    const calls = new Map<string, { member: string; input: any }>();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.call)
        calls.set(frame.id, {
          member: frame.call.member,
          input: frame.call.args[0],
        });
      owner.send(data);
    });
    owner.onMessage((data) => {
      const frame = JSON.parse(String(data));
      const call = calls.get(frame.id);
      if (frame.type === "result" && call && call.input?.id === target()) {
        if (
          control.dropClose &&
          call.member === "closeTree" &&
          call.input.abandonUnknownOperationIds
        ) {
          control.dropClose = false;
          control.closed = true;
          owner.close({ code: 1011 });
          socket.close({ code: 1011 });
          return;
        }
        if (
          call.member === "abandonCloseCandidate" &&
          ((control.closed && frame.result?.closed) ||
            (control.open && frame.result?.closed === false))
        ) {
          held.push(() => socket.send(data));
          return;
        }
      }
      socket.send(data);
    });
  });
  return control;
}

test("A recovery preserves B's current confirmation, original IDs and draft", async ({
  page,
  request,
}) => {
  let a: string | undefined;
  const recovery = await holdRecoveryRead(page, () => a);
  const { target, other } = await (await request.post("/fixture/reset")).json();
  a = target;
  await seed(page, target, other);
  await close(page);
  recovery.dropClose = true;
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect.poll(() => recovery.held.length).toBeGreaterThan(0);
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("B unknown input");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await input.fill("B unsent draft");
  await close(page);
  const dialog = page.getByRole("dialog");
  const before = await dialog.innerText();
  const bOriginal = await page.evaluate(
    (other) =>
      JSON.parse(
        localStorage.getItem(
          Object.keys(localStorage).find(
            (k) =>
              k.includes(`/outgoing/${encodeURIComponent(other)}/`) &&
              !k.endsWith("other-pending"),
          )!,
        )!,
      ).id,
    other,
  );
  expect(before).toContain(bOriginal);
  recovery.closed = false;
  recovery.held.splice(0).forEach((release) => release());
  await expect.poll(() => journal(page, target)).toBe(0);
  expect(await dialog.innerText()).toBe(before);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("B unsent draft");
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    3,
  );
});

test("late manual A Check cannot open its confirmation over a new B visit", async ({
  page,
  request,
}) => {
  let a: string | undefined;
  const recovery = await holdRecoveryRead(page, () => a);
  const { target, other } = await (await request.post("/fixture/reset")).json();
  a = target;
  await seed(page, target, other);
  await close(page);
  await request.post("/fixture/change", { data: { closeFailure: true } });
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "fixture native release failed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  recovery.open = true;
  await page
    .getByRole("button", { name: "Check close status", exact: true })
    .click();
  await expect.poll(() => recovery.held.length).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Open New session Orc", exact: true })
    .nth(1)
    .click();
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveValue(
    "Other draft preserved",
  );
  recovery.open = false;
  recovery.held.splice(0).forEach((release) => release());
  await expect(
    page.getByRole("button", { name: "Check close status", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await (await request.get("/fixture/info")).json()).closeCalls).toBe(
    2,
  );
});

test.describe("touch unknown close", () => {
  test.use({ hasTouch: true });
  test("row close exits menu and mobile sheet before unknown recovery", async ({
    page,
    request,
  }) => {
    const unknown = "http://127.0.0.1:14327";
    const { target } = await (
      await request.post(unknown + "/fixture/reset")
    ).json();
    const before = await (await request.get(unknown + "/fixture/info")).json();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(unknown);
    await openSidebar(page);
    await page.locator(`[data-swipe-id="${target}"] .session-close`).tap();
    await expect(
      page.getByRole("heading", {
        name: "Abandon unconfirmed submissions and close",
        exact: true,
      }),
    ).toBeVisible();
    const after = await (await request.get(unknown + "/fixture/info")).json();
    expect(after.closed).toBe(false);
    expect(after.inputs).toBe(before.inputs);
    expect(after.lookup).toEqual(before.lookup);
  });
});

test("AltX unknown refusal preserves folded org and never replays", async ({
  page,
  request,
}) => {
  const origin = "http://127.0.0.1:14327";
  const { target } = await (
    await request.post(origin + "/fixture/reset")
  ).json();
  const before = await (await request.get(origin + "/fixture/info")).json();
  await page.goto(origin);
  const row = page.locator(
    `.session-open[data-location="tree"][data-agent-id="${target}"]`,
  );
  await row.click();
  await page.locator(".org-disclosure").click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Unknown close keeps this draft");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 7));
  await input.press("Alt+KeyX");
  await expect(
    page.getByRole("heading", { name: action, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Alt+KeyJ");
  await page.keyboard.press("Control+Digit2");
  await expect(
    page.getByRole("heading", { name: action, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".org-disclosure")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator('.session-open[aria-current="true"]')).toHaveCount(
    0,
  );
  await expect(input).toHaveValue("Unknown close keeps this draft");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  await page.reload();
  await expect(page.locator(".agent-detail")).toBeVisible();
  const after = await (await request.get(origin + "/fixture/info")).json();
  expect(after.inputs).toBe(before.inputs);
  expect(after.closeCalls).toBe(before.closeCalls + 1);
  expect(after.closed).toBe(false);
  expect(after.lookup).toEqual(before.lookup);
});
