import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-workspace-ux/screenshots";
const active = (page: Page) =>
  page.locator(".session-item.active .session-open");
const title = (page: Page) => page.locator(".agent-detail h1");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const toggle = (page: Page) => page.locator(".questions-toggle");
async function filter(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Host filter" }).click();
  await page
    .getByRole("option", {
      name: name === "All hosts" ? name : `${name} Connected`,
      exact: true,
    })
    .click();
}

test("persistent selection, circular physical shortcuts, visible numeric index and guarded drafts", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  const rows = page.locator(".session-open");
  const ids = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")),
  );
  await composer(page).fill("First unsent draft");
  await composer(page).press("Alt+k");
  await expect(active(page)).toHaveAttribute("data-agent-id", ids.at(-1)!);
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("Last draft");
  await composer(page).press("Alt+j");
  await expect(composer(page)).toHaveValue("First unsent draft");
  await composer(page).dispatchEvent("keydown", {
    key: "∆",
    code: "KeyJ",
    altKey: true,
  });
  await expect(active(page)).toHaveAttribute("data-agent-id", ids[1]!);
  await composer(page).press("Meta+1");
  await expect(composer(page)).toHaveValue("First unsent draft");
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await composer(page).press("Meta+2");
  await expect(title(page)).toHaveText("Voice input");
  await expect(composer(page)).toHaveCount(0);
  await expect(page.locator(".read-only")).toContainText("Read-only");
  await page.screenshot({ path: `${shots}/desktop-worker.png` });
  await page.keyboard.press("Meta+1");
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("First unsent draft");
  await composer(page).dispatchEvent("keydown", {
    key: "j",
    code: "KeyJ",
    altKey: true,
    isComposing: true,
  });
  await composer(page).dispatchEvent("keydown", {
    key: "2",
    code: "Digit2",
    metaKey: true,
    keyCode: 229,
  });
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).dispatchEvent("compositionstart");
  await composer(page).dispatchEvent("keydown", {
    code: "KeyJ",
    key: "j",
    altKey: true,
  });
  await composer(page).dispatchEvent("keydown", {
    code: "Digit2",
    key: "2",
    metaKey: true,
  });
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).dispatchEvent("compositionend");
  await composer(page).press("Meta+0");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Meta+2");
  await page.keyboard.press("Alt+j");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await composer(page).fill("draft ");
  await composer(page).press("$");
  await page.keyboard.press("Alt+j");
  await page.keyboard.press("Meta+2");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await filter(page, "Neil’s Mac");
  await expect(title(page)).toHaveText("Reader performance");
  await composer(page).press("Meta+9");
  await expect(title(page)).toHaveText("Reader performance");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Reader performance");
  await filter(page, "All hosts");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("ArrowUp");
  await expect(title(page)).toHaveText("Reader performance");
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(title(page)).toHaveText("Reader performance");
});

test("filter and close choose valid neighbors; Host menu floats above detail; empty range stays empty", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.getByRole("combobox", { name: "Host filter" }).click();
  await expect(page.locator(".host-filter-menu")).toBeVisible();
  await page.screenshot({ path: `${shots}/desktop-host-menu.png` });
  await page.getByRole("option", { name: "All hosts", exact: true }).click();
  await page.keyboard.press("Alt+x");
  await expect(title(page)).toHaveText("Reader performance");
  await filter(page, "NUC");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(page.locator(".detail-empty")).toBeVisible();
  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Alt+j");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop-empty.png` });
});

test("closing a middle visible session selects its next neighbor and collapsing selected Worker selects Orc", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Meta+3");
  await expect(title(page)).toHaveText("Additional task 2");
  await page.keyboard.press("Alt+x");
  await expect(title(page)).toHaveText("Additional task 3");
  await page.keyboard.press("Meta+1");
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.keyboard.press("Meta+2");
  await expect(title(page)).toHaveText("Voice input");
  await page.getByRole("button", { name: "Collapse Workers" }).first().click();
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(active(page)).toHaveAccessibleName(
    "Open Streaming voice input Orc",
  );
});

for (const width of [1440, 390])
  test(`batch answers preserve focus/drafts and freeze new arrivals at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.post(`${origin}/fixture/reset`, { data: { mode: "long" } });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    if (width === 390) await page.locator(".session-open").first().click();
    await composer(page).fill("Unsent conversation draft");
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "first", questionCount: 2 },
    });
    await expect(page.locator(".question-card")).toHaveCount(2);
    await expect(composer(page)).toBeFocused();
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "second" },
    });
    await expect(page.locator(".current-question h3")).toHaveText(
      "second question 1",
    );
    await page.screenshot({ path: `${shots}/${width}-new-question-focus.png` });
    const first = page.getByRole("textbox", {
      name: "Your answer · first question 1",
      exact: true,
    });
    await first.fill("Protected original answer");
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "third" },
    });
    await expect(first).toBeFocused();
    await expect(first).toHaveValue("Protected original answer");
    await expect(page.locator(".current-question h3")).toHaveText(
      "first question 1",
    );
    await page
      .locator(".question-card")
      .filter({ hasText: "second question 1" })
      .getByRole("radio", { name: "Alternative", exact: true })
      .check();
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "fourth" },
    });
    await expect(page.locator(".current-question h3")).toHaveText(
      "second question 1",
    );
    await page.locator(".question-panel-heading button").click();
    await expect(page.locator(".question-panel")).toHaveCount(0);
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "fourth" },
    });
    await page.reload();
    await expect(page.locator(".question-panel")).toHaveCount(0);
    await toggle(page).click();
    await expect(first).toHaveValue("Protected original answer");
    const before = (await (await request.get(`${origin}/fixture/info`)).json())
      .inputs.length;
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "held" },
    });
    await page
      .getByRole("button", { name: "Send all answers", exact: true })
      .click();
    await expect(page.locator(".answer-batch")).toContainText("Sending…");
    await expect(page.locator(".answer-batch .answered-item")).toHaveCount(5);
    await expect(page.locator(".answered-summary")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/${width}-batch-sending.png` });
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "next-batch" },
    });
    await expect(page.locator(".question-card")).toHaveCount(1);
    const next = page.getByRole("textbox", {
      name: "Your answer · next-batch question 1",
      exact: true,
    });
    await next.fill("Next batch unsent draft");
    if (width === 1440) {
      await composer(page).press("Meta+2");
      await expect(title(page)).toHaveText("Reader performance");
    }
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "accepted" },
    });
    if (width === 1440) {
      await expect(title(page)).toHaveText("Reader performance");
      await expect(page.locator(".answered-summary")).toHaveCount(0);
      await composer(page).press("Meta+1");
    }
    await expect(page.locator(".answered-summary")).toContainText(
      "All 5 answers sent",
    );
    await expect(next).toHaveValue("Next batch unsent draft");
    await expect
      .poll(
        async () =>
          (await (await request.get(`${origin}/fixture/info`)).json()).inputs
            .length,
      )
      .toBe(before + 1);
    const { hub } = await (await request.get(`${origin}/fixture/info`)).json();
    const detail = await (
      await request.get(`${origin}/fixture/agents/${hub}:orc`)
    ).json();
    expect(
      detail.deliveries.filter(
        (d: { source: string }) => d.source === "question",
      ),
    ).toHaveLength(1);
    const batch = detail.deliveries.find(
      (d: { source: string }) => d.source === "question",
    );
    expect(batch.answers[0].answer).toBe("Protected original answer");
    expect(batch.answers[2].answer).toBe("Alternative");
    expect(batch.questionIds).not.toContain("next-batch:0");
    await expect(page.locator(".conversation")).not.toContainText(
      "Protected original answer",
    );
    await page.locator(".answered-summary summary").click();
    await expect(page.locator(".sent-answer").first()).toHaveText(
      "Protected original answer",
    );
    await request.post(`${origin}/fixture/change`, {
      data: { append: { agentId: "orc", text: "Ordinary refresh" } },
    });
    await expect(page.locator(".answered-summary")).toHaveAttribute("open");
    await page.screenshot({ path: `${shots}/${width}-answer-history.png` });
    await page.locator(".question-panel-heading button").click();
    await page.screenshot({ path: `${shots}/${width}-panel-closed.png` });
    if (width === 390) {
      await page.locator(".mobile-back > button").click();
      await expect(page.locator(".agent-detail")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Expand Workers" })
        .first()
        .click();
      await page.screenshot({ path: `${shots}/mobile-list.png` });
      await page
        .getByRole("button", { name: "Open Voice input Worker" })
        .click();
      await expect(page.locator(".read-only")).toBeVisible();
      await expect(composer(page)).toHaveCount(0);
      await page.screenshot({ path: `${shots}/mobile-worker.png` });
      await page.goBack();
      await expect(page.locator(".agent-detail")).toHaveCount(0);
      await page.locator(".session-open").first().click();
    } else {
      await composer(page).press("Meta+2");
      await expect(title(page)).toHaveText("Reader performance");
      await expect(page.locator(".question-panel")).toHaveCount(0);
      await composer(page).press("Meta+1");
    }
    await toggle(page).click();
    await expect(next).toHaveValue("Next batch unsent draft");
    await expect(composer(page)).toHaveValue("Unsent conversation draft");
  });

test("unknown batch retains its immutable operation across reload and lookup, and rejection explicitly retries once", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await request.post(`${origin}/fixture/change`, {
    data: {
      question: true,
      questionId: "rejected",
      questionCount: 2,
      sendMode: "rejected",
    },
  });
  await page
    .getByRole("textbox", {
      name: "Your answer · rejected question 1",
      exact: true,
    })
    .fill("Retained rejected draft");
  await page
    .getByRole("button", { name: "Send all answers", exact: true })
    .click();
  await expect(page.locator(".answer-batch")).toContainText(
    "Synthetic rejection",
  );
  await expect(page.locator(".answer-batch")).toContainText(
    "Retained rejected draft",
  );
  const operation = await page
    .locator(".answer-batch")
    .getAttribute("data-operation-id");
  const count = (await (await request.get(`${origin}/fixture/info`)).json())
    .inputs.length;
  await request.post(`${origin}/fixture/change`, {
    data: { sendMode: "accepted" },
  });
  await page
    .locator(".answer-batch")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.locator(".answered-summary")).toContainText(
    "All 2 answers sent",
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`${origin}/fixture/info`)).json()).inputs
          .length,
    )
    .toBe(count + 1);
  await request.post(`${origin}/fixture/change`, {
    data: {
      question: true,
      questionId: "uncertain",
      questionCount: 2,
      sendMode: "uncertain",
    },
  });
  await page
    .getByRole("textbox", {
      name: "Your answer · uncertain question 1",
      exact: true,
    })
    .fill("Immutable unknown answer");
  await page
    .getByRole("button", { name: "Send all answers", exact: true })
    .click();
  await expect(page.locator(".answer-batch")).toContainText(
    "Delivery could not be confirmed",
  );
  const unknown = await page
    .locator(".answer-batch")
    .getAttribute("data-operation-id");
  const after = (await (await request.get(`${origin}/fixture/info`)).json())
    .inputs.length;
  await page.reload();
  await expect(page.locator(".answer-batch")).toHaveAttribute(
    "data-operation-id",
    unknown!,
  );
  await expect(page.locator(".answer-batch")).toContainText(
    "Immutable unknown answer",
  );
  await page
    .locator(".answer-batch")
    .getByRole("button", { name: "Check receipt", exact: true })
    .click();
  await expect(page.locator(".answer-batch")).toContainText(
    "Delivery could not be confirmed",
  );
  expect(
    (await (await request.get(`${origin}/fixture/info`)).json()).inputs.length,
  ).toBe(after);
  const { hub } = await (await request.get(`${origin}/fixture/info`)).json();
  const detail = await (
    await request.get(`${origin}/fixture/agents/${hub}:orc`)
  ).json();
  expect(
    detail.deliveries.find((d: { id: string }) => d.id === operation).status,
  ).toBe("sent");
  expect(
    detail.deliveries.find((d: { id: string }) => d.id === unknown).questionIds,
  ).toEqual(["uncertain:0", "uncertain:1"]);
  await page.screenshot({ path: `${shots}/desktop-batch-unknown.png` });
});

test("every pending question needs an answer and unselected questions do not steal the conversation", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await request.post(`${origin}/fixture/change`, {
    data: {
      question: true,
      questionId: "required",
      questionCount: 2,
      questionOptions: false,
    },
  });
  const send = page.getByRole("button", {
    name: "Send all answers",
    exact: true,
  });
  await expect(send).toBeDisabled();
  await page
    .getByRole("textbox", {
      name: "Your answer · required question 1",
      exact: true,
    })
    .fill("First draft");
  await expect(send).toBeDisabled();
  await page
    .getByRole("textbox", {
      name: "Your answer · required question 2",
      exact: true,
    })
    .fill("Second draft");
  await expect(send).toBeEnabled();
  await page.locator(".question-panel-heading button").click();
  await request.post(`${origin}/fixture/change`, {
    data: { question: true, questionId: "remote", questionAgent: "peer" },
  });
  await expect(
    page
      .locator(".session-row")
      .filter({ hasText: "Reader performance" })
      .locator(".needs-input-icon"),
  ).toBeVisible();
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await composer(page).press("Meta+2");
  await expect(title(page)).toHaveText("Reader performance");
  await toggle(page).click();
  await expect(page.locator(".question-card h3")).toHaveText(
    "remote question 1",
  );
  await page
    .getByRole("textbox", {
      name: "Your answer · remote question 1",
      exact: true,
    })
    .fill("Isolated remote draft");
  await page.locator(".question-panel-heading button").click();
  await composer(page).press("Meta+1");
  await toggle(page).click();
  await expect(
    page.getByRole("textbox", {
      name: "Your answer · required question 1",
      exact: true,
    }),
  ).toHaveValue("First draft");
  await page.locator(".question-panel-heading button").click();
  const selected = await page.evaluate(() =>
    history.state.grove.details.at(-1),
  );
  await request.post(`${origin}/fixture/change`, {
    data: { restartHub: true },
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => history.state.grove.details.at(-1)))
    .toBe(selected);
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await toggle(page).click();
  await expect(
    page.getByRole("textbox", {
      name: "Your answer · required question 2",
      exact: true,
    }),
  ).toHaveValue("Second draft");
});

test("an unadmitted batch reloads its original envelope and missing lookup never sends", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  let intercepted:
    | { operationId: string; answers: { questionId: string; answer: string }[] }
    | undefined;
  await page.routeWebSocket(
    `${origin.replace("http:", "ws:")}/api/socket`,
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.call?.member === "answerBatch")
          intercepted = message.call.args[0];
        else server.send(raw);
      });
    },
  );
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await request.post(`${origin}/fixture/change`, {
    data: { question: true, questionId: "original", questionCount: 2 },
  });
  await page
    .getByRole("textbox", {
      name: "Your answer · original question 1",
      exact: true,
    })
    .fill("Frozen before admission");
  const before = (await (await request.get(`${origin}/fixture/info`)).json())
    .inputs.length;
  await page
    .getByRole("button", { name: "Send all answers", exact: true })
    .click();
  await expect.poll(() => intercepted).toBeDefined();
  const operation = await page
    .locator(".answer-batch")
    .getAttribute("data-operation-id");
  await request.post(`${origin}/fixture/change`, {
    data: { question: true, questionId: "later" },
  });
  await page.reload();
  await expect(page.locator(".answer-batch")).toHaveAttribute(
    "data-operation-id",
    operation!,
  );
  await expect(page.locator(".answer-batch")).toContainText(
    "Frozen before admission",
  );
  await expect(page.locator(".question-card h3")).toHaveText(
    "later question 1",
  );
  await page
    .locator(".answer-batch")
    .getByRole("button", { name: "Check receipt", exact: true })
    .click();
  await expect(page.locator(".answer-batch")).toContainText(
    "No submission record found",
  );
  expect(
    (await (await request.get(`${origin}/fixture/info`)).json()).inputs.length,
  ).toBe(before);
});

test("question drawer widening releases navigation without dismissing foreground", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.locator(".session-open").first().click();
  await composer(page).fill("Responsive draft");
  await toggle(page).click();
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual([]);
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.locator(".question-panel-heading button").click();
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await composer(page).press("Meta+2");
  await expect(title(page)).toHaveText("Reader performance");
  await composer(page).press("Alt+k");
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(composer(page)).toHaveValue("Responsive draft");
  await expect(composer(page)).toBeFocused();
  await page.screenshot({ path: `${shots}/review-wide-drawer-closed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle(page).click();
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.goBack();
  await expect(page.locator(".session-list")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/review-width-roundtrip-list.png` });
  await page.locator(".session-open").first().click();
  await page.setViewportSize({ width: 1000, height: 900 });
  await toggle(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual(["settings"]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: `${shots}/review-wide-settings-retained.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.locator(".question-panel-heading button").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await expect(page.locator(".session-list")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
});

test("fresh questions wait behind New and browser Back dismisses the visible foreground first", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.locator(".session-open").first().click();
  await composer(page).fill("Foreground conversation draft");
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("n");
  const input = page.getByRole("dialog").getByRole("textbox").first();
  await input.fill("New session draft");
  await request.post(`${origin}/fixture/change`, {
    data: { question: true, questionId: "foreground" },
  });
  await expect(toggle(page)).toContainText("1");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("New session draft");
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual(["new"]);
  await page.screenshot({
    path: `${shots}/review-mobile-new-question-deferred.png`,
  });
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".question-panel")).toBeVisible();
  await expect(page.locator(".current-question h3")).toHaveText(
    "foreground question 1",
  );
  await expect(composer(page)).toHaveValue("Foreground conversation draft");
  await page.screenshot({
    path: `${shots}/review-mobile-question-after-back.png`,
  });
  await page.goBack();
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.goBack();
  await expect(page.locator(".session-list")).toBeVisible();
});
