import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
const origin = "http://127.0.0.1:14319";
type Observed = {
  title: string;
  body: string;
  tag: string;
  closed: boolean;
  onclick?: () => void;
};
declare global {
  interface Window {
    notices: Observed[];
    readingFocused: boolean;
  }
}
const notices = (page: Page) =>
  page.evaluate(() =>
    window.notices.map(({ title, body, tag, closed }) => ({
      title,
      body,
      tag,
      closed,
    })),
  );
const settle = (page: Page) => page.waitForTimeout(250); // Absence beyond one Chord publication interval.
async function change(request: APIRequestContext, data: unknown) {
  expect((await request.post(origin + "/fixture/change", { data })).ok()).toBe(
    true,
  );
}
async function tool(request: APIRequestContext, name: string, args: unknown) {
  const r = await request.post(origin + "/api/mcp/call", {
    headers: { Authorization: "Bearer fixture-orc" },
    data: { name, arguments: args },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
const event = (
  request: APIRequestContext,
  agentId: string,
  turnId: string,
  event: object,
) => change(request, { execution: { agentId, turnId, event } });

test("real App consumes three event types, silences collaboration and retains reading/input", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await tool(request, "worker_send", {
    workerId: "docs",
    message: "Initialize",
  });
  const reviewer = await tool(request, "reviewer_start", {
    project: "codex-for-love",
    title: "Reviewer",
    spec: "#4485",
    fixedPoint: "base",
    reviewedHead: "head",
    profile: "standards",
    message: "Review",
  });
  const researcher = await tool(request, "researcher_start", {
    project: "codex-for-love",
    title: "Researcher",
    question: "Why?",
    message: "Investigate",
  });
  await page.addInitScript(() => {
    window.notices = [];
    window.readingFocused = false;
    Object.defineProperty(document, "hasFocus", {
      value: () => window.readingFocused,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => "visible",
    });
    class OwnedNotification {
      static permission = "granted";
      static async requestPermission() {
        return "granted";
      }
      title: string;
      body: string;
      tag: string;
      closed = false;
      onclick?: () => void;
      constructor(title: string, options: NotificationOptions = {}) {
        this.title = title;
        this.body = options.body ?? "";
        this.tag = options.tag ?? "";
        window.notices.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "Notification", {
      value: OwnedNotification,
      configurable: true,
    });
  });
  await page.goto(origin);
  const composer = page.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await expect(composer).toBeEnabled();
  await settle(page);
  const state = () =>
    request.get(origin + "/fixture/info").then((r) => r.json());
  const info = await state(),
    inputs = info.inputs.length;
  for (const id of [
    "voice",
    "docs",
    "reader",
    reviewer.id,
    researcher.id,
    "orc",
  ]) {
    const turnId = info.localAgents.find(
      (a: { id: string }) => a.id === id,
    ).turnId;
    await event(request, id, turnId, {
      type: "completed",
      status: "completed",
    });
  }
  for (const id of ["voice", reviewer.id, researcher.id]) {
    await event(request, id, `member-${id}`, { type: "working" });
    await event(request, id, `member-${id}`, {
      type: "completed",
      status: "failed",
      error: "Member failed",
    });
  }
  await settle(page);
  expect(await notices(page)).toEqual([]);
  await composer.fill("Keep my unsent draft");
  await page.evaluate(() => {
    window.readingFocused = true;
  });
  await event(request, "orc", "focused-handoff", { type: "working" });
  await tool(request, "orc_handoff", {
    summary: "Already reading this result",
  });
  await event(request, "orc", "focused-handoff", {
    type: "completed",
    status: "completed",
  });
  await settle(page);
  expect(await notices(page)).toEqual([]);
  await page.evaluate(() => {
    window.readingFocused = false;
  });
  await event(request, "orc", "handoff", { type: "working" });
  await tool(request, "orc_handoff", {
    summary: "PR delivered; awaiting your next instruction",
  });
  await settle(page);
  expect(await notices(page)).toEqual([]);
  await event(request, "orc", "handoff", {
    type: "completed",
    status: "completed",
  });
  const count = (n: number) =>
    expect.poll(() => notices(page).then((a) => a.length)).toBe(n);
  await count(1);
  expect((await notices(page))[0]).toMatchObject({
    body: "PR delivered; awaiting your next instruction",
  });
  expect((await notices(page))[0].title).toContain(
    "waiting for your next instruction",
  );
  await expect(composer).toHaveValue("Keep my unsent draft");
  await event(request, "orc", "handoff", {
    type: "completed",
    status: "completed",
  });
  await change(request, { usage: 60 });
  await settle(page);
  await count(1);
  await page.getByText("Reader performance", { exact: true }).first().click();
  await page.evaluate(() => window.notices[0].onclick?.());
  await expect(
    page.getByRole("heading", { name: "Streaming voice input", exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Keep my unsent draft");
  expect((await notices(page))[0].closed).toBe(true);
  const question = (batch: string, texts: string[]) =>
    event(request, "orc", "questions", {
      type: "item",
      item: {
        type: "agentMessage",
        id: batch,
        delivery: "async",
        questions: texts.map((question) => ({ question })),
      },
    });
  await event(request, "orc", "questions", { type: "working" });
  await question("old-batch", ["Old pending question"]);
  await count(2);
  await question("new-batch", ["New first question", "New second question"]);
  await count(3);
  expect((await notices(page))[2].body).toBe(
    "New first question\nNew second question",
  );
  await question("new-batch", ["New first question", "New second question"]);
  await settle(page);
  await count(3);
  await expect(
    page.getByText("Old pending question", { exact: true }).first(),
  ).toBeVisible();
  expect((await state()).inputs.length).toBe(inputs);
  await event(request, "orc", "questions", {
    type: "error",
    willRetry: true,
    errorKind: "capacity",
    error: "same error",
  });
  await settle(page);
  await count(3);
  await event(request, "orc", "questions", {
    type: "completed",
    status: "failed",
    error: "same error",
  });
  await count(4);
  await event(request, "orc", "questions", {
    type: "completed",
    status: "failed",
    error: "changed detail",
  });
  await settle(page);
  await count(4);
  await event(request, "orc", "second-failure", { type: "working" });
  await event(request, "orc", "second-failure", {
    type: "completed",
    status: "failed",
    error: "same error",
  });
  await count(5);
  expect((await notices(page))[3].tag).not.toBe((await notices(page))[4].tag);
  await page.evaluate(() => {
    window.readingFocused = true;
  });
  await event(request, "orc", "focused", { type: "working" });
  await event(request, "orc", "focused", {
    type: "item",
    item: {
      type: "agentMessage",
      id: "focused-q",
      delivery: "async",
      questions: [{ question: "Focused question" }],
    },
  });
  await event(request, "orc", "focused", {
    type: "completed",
    status: "failed",
    error: "Focused failure",
  });
  await settle(page);
  await count(5);
  console.log("event observations", JSON.stringify(await notices(page)));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Streaming voice input", exact: true }),
  ).toBeVisible();
  await settle(page);
  expect(await notices(page)).toEqual([]);
  await change(request, { outage: true });
  await settle(page);
  await event(request, "orc", "offline", { type: "working" });
  await event(request, "orc", "offline", {
    type: "completed",
    status: "failed",
    error: "Offline failure",
  });
  await change(request, { outage: false });
  await page.waitForTimeout(1800);
  expect(await notices(page)).toEqual([]);
  await event(request, "orc", "reconnected", { type: "working" });
  await event(request, "orc", "reconnected", {
    type: "completed",
    status: "failed",
    error: "Fresh failure",
  });
  await count(1);
  expect((await state()).inputs.length).toBe(inputs);
  console.log(
    JSON.stringify({
      reconnect: await notices(page),
      additionalSends: (await state()).inputs.length - inputs,
    }),
  );
  // An internal question forwards one authorized report to Orc, silently.
  await event(request, "voice", "member-question", { type: "working" });
  await event(request, "voice", "member-question", {
    type: "item",
    item: {
      type: "agentMessage",
      id: "internal-question",
      delivery: "async",
      questions: [{ question: "Internal member decision" }],
    },
  });
  await expect
    .poll(() => state().then((s) => s.inputs.length))
    .toBe(inputs + 1);
  await settle(page);
  await count(1);
  console.log("internal question: one authorized report, no user notification");
  await page
    .getByRole("button", { name: "Collapse questions", exact: true })
    .click();
  await expect(composer).toHaveValue("Keep my unsent draft");
  for (const mode of ["denied", "unsupported", "constructor-error"]) {
    await page.evaluate((mode) => {
      if (mode === "denied")
        Object.defineProperty(Notification, "permission", {
          value: "denied",
          configurable: true,
        });
      else if (mode === "unsupported")
        Reflect.deleteProperty(window, "Notification");
      else
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: class {
            static permission = "granted";
            constructor() {
              throw new Error("OS display refused");
            }
          },
        });
    }, mode);
    await event(request, "orc", mode, { type: "working" });
    await event(request, "orc", mode, {
      type: "completed",
      status: "failed",
      error: mode,
    });
    await settle(page);
    await count(1);
    await expect(composer).toHaveValue("Keep my unsent draft");
  }
  expect((await state()).inputs.length).toBe(inputs + 1);
});
