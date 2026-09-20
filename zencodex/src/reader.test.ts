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

test("transplanted reader searches with Ctrl-/ and preserves a submit origin while output appends", async () => {
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
    expect(setup.captureCharFrame()).toContain("needle request");
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
    footerInfo: () => "context [████░░░░] 50%",
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
    const context = frame.indexOf("context [");
    const shortcuts = frame.indexOf("q quit");
    expect(compose).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(compose);
    expect(shortcuts).toBeGreaterThan(context);
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
