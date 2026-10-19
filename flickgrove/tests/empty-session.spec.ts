import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { newSession, createSession } from "./browser-actions";
let server: ChildProcess, origin: string;
test.beforeEach(async () => {
  server = spawn("bun", ["tests/empty-session-serve.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "pipe", "inherit"],
  });
  origin = String((await once(server.stdout!, "data"))[0]).trim();
});
test.afterEach(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
});
test("a new unsent native session opens without unsupported history errors and reads normally after first input", async ({
  page,
}) => {
  await page.goto(origin);
  await newSession(page);
  await page.getByRole("option", { name: "Fixture", exact: true }).click();
  await createSession(page);
  await expect(page.locator(".first-message")).toBeVisible();
  await expect(page.locator(".conversation-loading")).toHaveCount(0);
  await expect(page.locator(".history-controls [role=alert]")).toHaveCount(0);
  const requests = await (
    await page.request.get(origin + "/fixture/requests")
  ).json();
  expect(
    requests.filter(
      (r: { method: string }) => r.method === "thread/items/list",
    ),
  ).toEqual([]);
  const id = await page.evaluate(
    () => history.state.grove.details.at(-1) as string,
  );
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("First owned input");
  await input.press("Enter");
  await expect(page.locator(".conversation")).toContainText(
    "First owned input",
  );
  const read = await page.request.get(
    origin + "/api/read/messages?" + new URLSearchParams({ agent: id }),
    { headers: { Origin: origin, "X-Grove-Peer": id.split(":")[0] } },
  );
  expect(read.ok()).toBe(true);
  expect(
    (await read.json()).messages.some(
      (m: { text: string }) => m.text === "First owned input",
    ),
  ).toBe(true);
  const observed = await (
    await page.request.get(origin + "/fixture/requests")
  ).json();
  const thread = observed
    .filter((r: { method: string }) => r.method === "thread/items/list")
    .at(-1).threadId;
  const starts = observed.filter(
    (r: { method: string; threadId: string }) =>
      r.method === "turn/start" && r.threadId === thread,
  ).length;
  expect(starts).toBe(1);
  const closeQuestions = page
    .locator(".question-panel-heading")
    .getByRole("button", { name: "Collapse questions", exact: true });
  if (await closeQuestions.isVisible()) await closeQuestions.click();
  await input.fill("Keep draft through read Retry");
  await page.request.post(origin + "/fixture/control", {
    data: { itemsUnsupported: true },
  });
  await page.reload();
  await expect(page.locator(".history-controls [role=alert]")).toHaveText(
    "JSON-RPC error -32601: thread/items/list is not supported yet",
  );
  if (await closeQuestions.isVisible()) await closeQuestions.click();
  await expect(input).toHaveValue("Keep draft through read Retry");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page.request.post(origin + "/fixture/control", {
    data: { emptyItemsUnsupported: true },
  });
  await page
    .locator(".history-controls")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.locator(".history-controls [role=alert]")).toHaveCount(0);
  const after = await (
    await page.request.get(origin + "/fixture/requests")
  ).json();
  expect(
    after.filter(
      (r: { method: string; threadId: string }) =>
        r.method === "turn/start" && r.threadId === thread,
    ),
  ).toHaveLength(starts);
});
