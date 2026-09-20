import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { createConversationReader } from "./reader";
import type { NamedSession, TranscriptMessage } from "./types";

const session: NamedSession = {
  id: "thread",
  name: "Thread",
  cwd: "/tmp/z",
  path: "thread",
  activityMs: 0,
};
const noWatch = () => ({ close() {} });

test("transplanted reader preserves a submit origin while output appends", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const messages: TranscriptMessage[] = [
    {
      role: "user",
      body: "needle request",
      timestampLabel: "2026-09-20 10:00",
    },
  ];
  const reader = await createConversationReader({
    session,
    messages,
    load: async () => messages,
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    await setup.renderOnce();
    reader.project(
      [
        ...messages,
        {
          role: "assistant",
          body: "# completed answer",
          timestampLabel: "2026-09-20 10:01",
        },
      ],
      0,
    );
    await setup.renderOnce();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame.split("\n")[0].trim()).toBe("Thread");
    expect(frame).not.toContain("zencodex ·");
    expect(frame).toContain("needle request");
    expect(frame).not.toContain("local times");
    expect(frame).not.toContain("follow:");
    // The source reader exposes literal-search state and result navigation;
    // this seam verifies its static transcript remains readable after anchoring.
    expect(reader.snapshot().messages).toBe(2);
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("reader keeps multiline composer, context, and weak shortcuts visible in order", async () => {
  const setup = await createTestRenderer({ width: 80, height: 18 });
  let submitted = "";
  const reader = await createConversationReader({
    session,
    messages: [],
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
    statusLines: () => ({
      cwd: "/tmp/z",
      runtime: "gpt-5 · high",
      telemetry: "context ━━━━━─ 41%",
    }),
    onSubmit: (value) => {
      submitted = value;
    },
  });
  try {
    reader.start();
    await setup.renderOnce();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const compose = frame.indexOf("Message Codex");
    const context = frame.indexOf("context ━");
    const shortcuts = frame.indexOf("q quit");
    expect(compose).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(compose);
    expect(shortcuts).toBeGreaterThan(context);
    expect(frame).toContain("41%");
    expect(frame).not.toContain("105512/258400");
    expect(frame).toContain("┌");
    expect(frame).toContain("└");
    const composer = (reader as unknown as { composer: TextareaRenderable })
      .composer;
    composer.setText("first\nsecond");
    composer.submit();
    await Bun.sleep(0);
    expect(submitted).toBe("first\nsecond");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("reader keeps model and effort visible beside a truncated working directory", async () => {
  const setup = await createTestRenderer({ width: 38, height: 14 });
  const reader = await createConversationReader({
    session,
    messages: [],
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
    statusLines: () => ({
      cwd: "/an/intentionally/long/project/working/directory",
      runtime: "gpt-5 · high",
      telemetry: "context ━━━━━─ 41%",
    }),
  });
  try {
    reader.start();
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("gpt-5 · high");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("composer completion refreshes on each input and fuzzy-matches commands", async () => {
  const setup = await createTestRenderer({ width: 70, height: 16 });
  const reader = await createConversationReader({
    session,
    messages: [],
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    await setup.mockInput.typeText("/cp");
    await Promise.resolve();
    await setup.renderOnce();
    await setup.renderOnce();
    expect(reader.snapshot().completion).toBe("command");
    expect(setup.captureCharFrame()).toContain("/compact");
    await setup.mockInput.typeText("z");
    await Promise.resolve();
    await setup.renderOnce();
    expect(reader.snapshot().completion).toBeUndefined();
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("composer fuzzy-matches enabled skills without treating Ctrl-/ as reader search", async () => {
  const setup = await createTestRenderer({ width: 70, height: 16 });
  const reader = await createConversationReader({
    session,
    messages: [],
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
    loadSkills: async () => [
      { name: "review-code", description: "Review code" },
    ],
  });
  try {
    reader.start();
    await setup.renderOnce();
    setup.mockInput.pressKey("/", { ctrl: true });
    await setup.renderOnce();
    expect(reader.snapshot().searchEditing).toBe(false);
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.mockInput.typeText("$rce");
    await Promise.resolve();
    await Promise.resolve();
    await setup.renderOnce();
    await setup.renderOnce();
    expect(reader.snapshot().completion).toBe("skill");
    expect(setup.captureCharFrame()).toContain("$review-code");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("reader marks an appended reply below without moving a manual reading position", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const initial = Array.from({ length: 8 }, (_, index): TranscriptMessage => ({
    role: "user",
    body: `message ${index}`,
    timestampLabel: "2026-09-20 10:00",
  }));
  const reader = await createConversationReader({
    session,
    messages: initial,
    load: async () => initial,
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    (
      reader as unknown as { scrollBox: { scrollTo(position: number): void } }
    ).scrollBox.scrollTo(0);
    const before = reader.snapshot().scrollTop;
    reader.project([
      ...initial,
      {
        role: "assistant",
        body: "reply below",
        timestampLabel: "2026-09-20 10:01",
      },
    ]);
    await setup.renderOnce();
    expect(reader.snapshot().scrollTop).toBe(before);
    expect(setup.captureCharFrame()).toContain("new reply below");
    expect(setup.captureCharFrame()).not.toContain("follow:");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("focused Ctrl-J adds a composer newline without scrolling the transcript", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const messages = Array.from(
    { length: 12 },
    (_, index): TranscriptMessage => ({
      role: "user",
      body: `scrollable message ${index}`,
      timestampLabel: "2026-09-20 10:00",
    }),
  );
  const reader = await createConversationReader({
    session,
    messages,
    load: async () => messages,
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    const composer = (reader as unknown as { composer: TextareaRenderable })
      .composer;
    composer.setText("first");
    const before = reader.snapshot().scrollTop;
    setup.mockInput.pressKey("j", { ctrl: true });
    await setup.renderOnce();
    expect(composer.plainText).toContain("\n");
    expect(composer.plainText.replace("\n", "")).toBe("first");
    expect(reader.snapshot().scrollTop).toBe(before);
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("COMPOSING Ctrl-C clears draft/completion and Ctrl-D quits without a native interrupt", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const reader = await createConversationReader({
    session,
    messages: Array.from({ length: 10 }, (_, index): TranscriptMessage => ({
      role: "user",
      body: `message ${index}`,
      timestampLabel: "2026-09-20 10:00",
    })),
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    const composer = (reader as unknown as { composer: TextareaRenderable })
      .composer;
    composer.setText("discard me");
    (reader as any).showCompletion("command", [
      { name: "/compact", description: "", insert: "/compact" },
    ]);
    const before = reader.snapshot().scrollTop;
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.renderOnce();
    expect(composer.plainText).toBe("");
    expect(reader.snapshot().completion).toBeUndefined();
    expect(reader.snapshot().scrollTop).toBe(before);
    setup.mockInput.pressKey("d", { ctrl: true });
    expect(await reader.waitForExit()).toBe("quit");
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("READING retains Ctrl-D paging and makes Ctrl-C a no-op", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const messages = Array.from(
    { length: 20 },
    (_, index): TranscriptMessage => ({
      role: "user",
      body: `message ${index}`,
      timestampLabel: "2026-09-20 10:00",
    }),
  );
  const reader = await createConversationReader({
    session,
    messages,
    load: async () => messages,
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    (
      reader as unknown as { scrollBox: { scrollTo(value: number): void } }
    ).scrollBox.scrollTo(0);
    const before = reader.snapshot().scrollTop;
    setup.mockInput.pressKey("d", { ctrl: true });
    await setup.renderOnce();
    expect(reader.snapshot().scrollTop).toBeGreaterThan(before);
    const paged = reader.snapshot().scrollTop;
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.renderOnce();
    expect(reader.snapshot().disposed).toBe(false);
    expect(reader.snapshot().scrollTop).toBe(paged);
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});

test("reader search visibly marks every literal result and strengthens the selected result", async () => {
  const setup = await createTestRenderer({ width: 70, height: 14 });
  const reader = await createConversationReader({
    session,
    messages: [
      {
        role: "user",
        body: "needle and NEEDLE",
        timestampLabel: "2026-09-20 10:00",
      },
    ],
    load: async () => [],
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    await setup.mockInput.typeText("needle");
    setup.mockInput.pressEnter();
    await setup.waitForVisualIdle();
    await setup.renderOnce();
    const highlighted = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text === "needle" || span.text === "NEEDLE");
    expect(highlighted.map((span) => span.bg.toString()).sort()).toEqual([
      "rgba(0.40, 0.33, 0.00, 1.00)",
      "rgba(0.71, 0.33, 0.04, 1.00)",
    ]);
    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.waitForVisualIdle();
    await setup.renderOnce();
    const searchBackgrounds = new Set([
      "rgba(0.40, 0.33, 0.00, 1.00)",
      "rgba(0.71, 0.33, 0.04, 1.00)",
    ]);
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => searchBackgrounds.has(span.bg.toString())),
    ).toEqual([]);
    expect(reader.snapshot()).toMatchObject({
      disposed: false,
      searchMatches: 0,
    });
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});
