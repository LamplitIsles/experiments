import { expect, test } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
async function setup(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
) {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const info = await (await request.get(origin + "/fixture/info")).json();
  await page.goto(origin);
  await expect(
    page.getByRole("button", { name: "Open Reader performance Orc" }),
  ).toBeVisible();
  return info;
}
test("direct peer outage isolates local sends; reload retains remote cache and connection resumes without replay", async ({
  page,
  request,
}) => {
  const info = await setup(page, request);
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.reload();
  await expect
    .poll(() =>
      sockets.some((url) =>
        url.startsWith(info.peerUrl.replace("http:", "ws:")),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Connectivity check");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Local survives");
  await input.press("Enter");
  await expect
    .poll(
      async () =>
        (
          await (await request.get(origin + "/fixture/info")).json()
        ).inputs.filter((i: { text: string }) => i.text === "Local survives")
          .length,
    )
    .toBe(1);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open Reader performance Orc" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Connectivity check");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await request.post(origin + "/fixture/change", { data: { outage: false } });
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Connectivity check");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await input.fill("Direct remote");
  await input.press("Enter");
  await expect
    .poll(
      async () =>
        (
          await (await request.get(origin + "/fixture/info")).json()
        ).peerInputs.filter((i: { text: string }) => i.text === "Direct remote")
          .length,
    )
    .toBe(1);
  const after = await (await request.get(origin + "/fixture/info")).json();
  expect(
    after.inputs.filter((i: { text: string }) => i.text === "Direct remote"),
  ).toHaveLength(0);
  await page.screenshot({ path: "../.scratch/grove-direct-peers/desktop.png" });
});
test("missing receipt has a distinct state; manual local dismissal survives reload and does not send", async ({
  page,
  request,
}) => {
  const info = await setup(page, request);
  const id = info.hub + ":orc";
  await page.evaluate(
    ({ id }) => {
      localStorage.setItem(
        `flickgrove/${location.origin}/outgoing/${encodeURIComponent(id)}/lost`,
        JSON.stringify({
          agentId: id,
          id: "lost",
          text: "Local ghost",
          at: Date.now(),
          status: "uncertain",
        }),
      );
    },
    { id },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const warning = page
    .locator(".delivery-error")
    .filter({ hasText: "No submission record found" });
  await expect(warning).toHaveCount(1);
  await warning.locator("summary").click();
  await warning
    .getByRole("button", { name: "I checked — remove local pending item" })
    .click();
  await expect(page.getByText("Local ghost", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Local ghost", { exact: true })).toHaveCount(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(0);
});
test("new-session preferences are browser-owned and explicit creation settings reach only the target Peer", async ({
  page,
  request,
  browser,
}) => {
  await setup(page, request);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".role-settings")
    .first()
    .getByRole("combobox")
    .first()
    .selectOption("gpt-6-luna");
  await page.getByRole("switch", { name: "Fast" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.keyboard.press("n");
  await page
    .getByRole("button", { name: "Neil’s Mac Connected", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create on Neil’s Mac", exact: true })
    .click();
  await expect(page.locator(".agent-detail")).toContainText("gpt-6-luna");
  const local = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(`flickgrove/${location.origin}/preferences`)!,
    ),
  );
  expect(local.orc.model).toBe("gpt-6-luna");
  expect(local.fast).toBe(false);
  const after = await (await request.get(origin + "/fixture/info")).json();
  expect(after.localAgents).toHaveLength(1);
  expect(after.peerAgents).toHaveLength(2);
  expect(
    after.peerAgents.find((a: { id: string }) => a.id !== "orc"),
  ).toMatchObject({ model: "gpt-6-luna", serviceTier: "default" });
  const separate = await browser.newContext();
  const other = await separate.newPage();
  await other.goto(origin);
  expect(
    await other
      .evaluate(() =>
        JSON.parse(
          localStorage.getItem(`flickgrove/${location.origin}/preferences`)!,
        ),
      )
      .then((p) => p.orc.model),
  ).toBe("gpt-6.1-sol");
  await separate.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../.scratch/grove-direct-peers/mobile.png" });
});

test("cached frontend still controls another Peer when the page Peer is unreachable", async ({
  page,
  request,
}) => {
  const info = await setup(page, request);
  let block = false;
  let cut = () => {};
  await page.routeWebSocket(
    origin.replace("http:", "ws:") + "/api/socket",
    (ws) => {
      if (block) {
        ws.close();
        return;
      }
      ws.connectToServer();
      cut = () => ws.close();
    },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  block = true;
  cut();
  await page.getByRole("textbox", { name: "Message Orc" }).fill("Still direct");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page.route(origin + "/api/identity", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Page Peer offline");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (await request.get(origin + "/fixture/info")).json()
        ).peerInputs.filter(
          (i: { text: string }) => i.text === "Page Peer offline",
        ).length,
    )
    .toBe(1);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(0);
  await newSession(page);
  await page
    .getByRole("button", { name: "Neil’s Mac Connected", exact: true })
    .click();
  await createSession(page);
  await expect(page.locator(".agent-detail")).toContainText("gpt-6.1-sol");
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).peerAgents,
  ).toHaveLength(2);
  expect(info.peer).toBeTruthy();
});
