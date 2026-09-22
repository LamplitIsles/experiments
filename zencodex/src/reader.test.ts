import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createConversationReader,
  type ConversationReaderOptions,
} from "./reader";
import type { TranscriptMessage } from "./types";
import { PerformanceTrace } from "./tracing";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
const message = (body: string): TranscriptMessage => ({
  role: "assistant",
  body,
  timestampLabel: "now",
});
async function fixture(
  messages: TranscriptMessage[],
  options: Partial<ConversationReaderOptions> = {},
) {
  const ui = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  });
  const reader = await createConversationReader({
    renderer: ui.renderer,
    session: {
      id: "test",
      name: "Thread",
      cwd: "/fixture",
      path: "",
      activityMs: 0,
    },
    messages,
    ...options,
  });
  await reader.start();
  await ui.flush();
  return {
    ui,
    reader,
    close: async () => {
      await reader.waitForIdle();
      reader.dispose();
      ui.renderer.destroy();
    },
  };
}
test("replay and append export submission spans under their rendering operation", async () => {
  const exported: any[] = [];
  const trace = new PerformanceTrace({
    export(spans, callback) {
      const data = JSON.parse(
        new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)!),
      );
      for (const resource of data.resourceSpans)
        for (const scope of resource.scopeSpans) exported.push(...scope.spans);
      callback({ code: 0 });
    },
    async shutdown() {},
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture([message("First")], { trace });
    f.reader.project([message("First"), message("Second")]);
    await f.reader.waitForIdle();
    await trace.close();
    const submissions = exported.filter(
      (span) => span.name === "scrollback.submit",
    );
    expect(submissions).toHaveLength(2);
    for (const name of ["history.replay", "history.append"]) {
      const parent = exported.find((span) => span.name === name)!;
      const child = submissions.find(
        (span) => span.parentSpanId === parent.spanId,
      )!;
      expect(child.traceId).toBe(parent.traceId);
      expect(child.attributes).toContainEqual({
        key: "outcome",
        value: { stringValue: "ok" },
      });
    }
  } finally {
    await f?.close();
    await trace.close();
  }
});
test("footer ends at shortcuts with completion open or closed", async () => {
  const f = await fixture([]);
  const initialRows = f.ui.captureCharFrame().split("\n").length;
  const expectNoBottomGap = () => {
    const rows = f.ui.captureCharFrame().split("\n");
    if (rows.at(-1) === "") rows.pop();
    expect(rows.at(-1)).toContain("Enter send/steer");
  };
  try {
    expectNoBottomGap();
    await f.ui.mockInput.typeText("/cmp");
    await f.ui.flush();
    expect(f.ui.captureCharFrame()).toContain("Compact this thread");
    expect(f.ui.captureCharFrame().split("\n").length).toBe(initialRows);
    expectNoBottomGap();
    await f.ui.mockInput.pressKey("TAB");
    await f.ui.flush();
    expect(f.ui.captureCharFrame()).not.toContain("Compact this thread");
    expectNoBottomGap();
  } finally {
    await f.close();
  }
});
test("loading keeps Enter and Tab drafts unsent until ready", async () => {
  let ready = false;
  const sent: string[] = [];
  const queued: string[] = [];
  const f = await fixture([], {
    canSubmit: () => ready,
    onSubmit: (input) => {
      sent.push(input);
    },
    onQueue: (input) => {
      queued.push(input);
    },
  });
  try {
    await f.ui.mockInput.typeText("Draft while connecting");
    await f.ui.mockInput.pressKey("RETURN");
    await f.ui.mockInput.pressKey("TAB");
    await f.ui.flush();
    expect(sent).toEqual([]);
    expect(queued).toEqual([]);
    expect(f.ui.captureCharFrame()).toContain("Draft while connecting");
    ready = true;
    await f.ui.mockInput.pressKey("RETURN");
    expect(sent).toEqual(["Draft while connecting"]);
  } finally {
    await f.close();
  }
});
test("completed messages append once and retain a live multiline composer", async () => {
  const sent: string[] = [],
    queued: string[] = [];
  const f = await fixture([message("First answer")], {
    onSubmit: (v) => {
      sent.push(v);
    },
    onQueue: (v) => {
      queued.push(v);
    },
  });
  try {
    expect(f.ui.externalOutput.takeText()).toContain("First answer");
    f.reader.project([message("First answer"), message("Second answer")]);
    await f.reader.waitForIdle();
    await f.ui.flush();
    const output = f.ui.externalOutput.takeText();
    expect(output).toContain("Second answer");
    expect(output).not.toContain("First answer");
    f.reader.project([message("First answer"), message("Second answer")]);
    await f.reader.waitForIdle();
    await f.ui.flush();
    expect(f.ui.externalOutput.takeText()).toBe("");
    await f.ui.mockInput.typeText("next job");
    await f.ui.mockInput.pressKey("TAB");
    expect(queued).toEqual(["next job"]);
    expect(sent).toEqual([]);
    await f.ui.mockInput.typeText("line one");
    await f.ui.mockInput.pressKey("j", { ctrl: true });
    await f.ui.mockInput.typeText("line two");
    await f.ui.mockInput.pressKey("RETURN");
    expect(sent).toEqual(["line one\nline two"]);
  } finally {
    await f.close();
  }
});
test("replay keeps a whole contiguous suffix and latest oversized message", async () => {
  const large = Array.from({ length: 1002 }, (_, i) => `row ${i}  `).join("\n");
  const f = await fixture([message("Older omitted"), message(large)]);
  try {
    const output = f.ui.externalOutput.takeText();
    expect(output).toContain("Earlier history omitted");
    expect(output).not.toContain("Older omitted");
    expect(output).toContain("row 0");
    expect(output).toContain("row 1001");
  } finally {
    await f.close();
  }
});

test("history arriving after the editable shell still uses the replay budget", async () => {
  const f = await fixture([]);
  try {
    await f.ui.mockInput.typeText("Keep my draft");
    const large = Array.from({ length: 1002 }, (_, i) => `loaded ${i}  `).join(
      "\n",
    );
    await f.reader.loadHistory([message("Older omitted"), message(large)]);
    await f.ui.flush();
    const output = f.ui.externalOutput.takeText();
    expect(output).toContain("Earlier history omitted");
    expect(output).not.toContain("Older omitted");
    expect(output).toContain("loaded 1001");
    expect(f.ui.captureCharFrame()).toContain("Keep my draft");
  } finally {
    await f.close();
  }
});
test("completion consumes Tab before queueing and restored input stays editable", async () => {
  const queued: string[] = [];
  let restored = "";
  const f = await fixture([], {
    onQueue: (v) => {
      queued.push(v);
    },
    takeRestoredDraft: () => {
      const text = restored;
      restored = "";
      return text;
    },
  });
  try {
    await f.ui.mockInput.typeText("/cmp");
    await f.ui.flush();
    await f.ui.mockInput.pressKey("TAB");
    await f.ui.flush();
    expect(queued).toEqual([]);
    expect(f.ui.captureCharFrame()).toContain("/compact");
    await f.ui.mockInput.pressKey("TAB");
    expect(queued).toEqual(["/compact"]);
    restored = "Recovered job";
    f.reader.project([]);
    await f.ui.flush();
    expect(f.ui.captureCharFrame()).toContain("Recovered job");
  } finally {
    await f.close();
  }
});

test("resize preserves host history and long cwd does not hide runtime identity", async () => {
  const f = await fixture([message("Short complete answer")], {
    statusLines: () => ({
      cwd: "/" + "long-directory/".repeat(15),
      runtime: "model-x · high",
      telemetry: "context 20%",
    }),
  });
  try {
    expect(f.ui.renderer.useMouse).toBe(false);
    expect(f.ui.captureCharFrame()).toContain("model-x · high");
    f.ui.externalOutput.clear();
    f.ui.resize(60, 20);
    await f.reader.waitForIdle();
    await f.ui.flush();
    expect(f.ui.externalOutput.takeText()).toBe("");
    expect(f.ui.captureCharFrame()).toContain("model-x · high");
  } finally {
    await f.close();
  }
});

test("a prepared history page is submitted as one complete snapshot", async () => {
  const f = await fixture([]);
  try {
    f.ui.externalOutput.clear();
    const messages = Array.from({ length: 40 }, (_, i) =>
      message(`Completed ${i}`),
    );
    await f.reader.loadHistory(messages);
    await f.ui.flush();
    const commits = f.ui.externalOutput.take();
    expect(commits).toHaveLength(1);
    expect(commits[0].text).toContain("Completed 0");
    expect(commits[0].text).toContain("Completed 39");
  } finally {
    await f.close();
  }
});

test("replay does not skip an oversized older message to include even older text", async () => {
  const middle = Array.from({ length: 1001 }, (_, i) => `middle ${i}  `).join(
    "\n",
  );
  const f = await fixture([
    message("Oldest tiny"),
    message(middle),
    message("Latest complete"),
  ]);
  try {
    const output = f.ui.externalOutput.takeText();
    expect(output).toContain("Latest complete");
    expect(output).toContain("Earlier history omitted");
    expect(output).not.toContain("Oldest tiny");
    expect(output).not.toContain("middle 0");
  } finally {
    await f.close();
  }
});
