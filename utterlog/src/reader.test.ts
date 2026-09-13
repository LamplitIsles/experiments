import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { CodeRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { parseTranscript } from "./cli";
import { createConversationReader, type WatchFactory } from "./reader";
import type { NamedSession, TranscriptMessage } from "./cli";

const session: NamedSession = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Native reader",
  cwd: "/test/project",
  path: "/test/session.jsonl",
  activityMs: Date.parse("2026-09-12T12:00:00Z"),
};

function message(role: "user" | "assistant", body: string, timestampLabel = "2026-09-12 20:00"): TranscriptMessage {
  return { role, body, timestampLabel };
}

function sessionAt(path: string, cwd = "/test/project"): NamedSession {
  return { ...session, path, cwd };
}

function rawMessage(messageValue: TranscriptMessage, ordinal: number): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: `2026-09-12T12:${String(ordinal).padStart(2, "0")}:00.000Z`,
    ordinal,
    payload: {
      type: "message",
      role: messageValue.role,
      ...(messageValue.role === "assistant" ? { phase: messageValue.phase ?? "final_answer" } : {}),
      content: [{ type: messageValue.role === "user" ? "input_text" : "output_text", text: messageValue.body }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: [messageValue.role === "user" ? "user.text" : "unknown"],
      },
    },
  };
}

async function writeLog(path: string, logSession: NamedSession, messages: TranscriptMessage[]): Promise<void> {
  const meta = {
    type: "session_meta",
    timestamp: "2026-09-12T08:00:00.000Z",
    ordinal: 0,
    payload: {
      id: logSession.id,
      session_id: logSession.id,
      timestamp: "2026-09-12T08:00:00.000Z",
      cwd: logSession.cwd,
      source: "cli",
      thread_source: "user",
    },
  };
  await writeFile(
    path,
    [meta, ...messages.map((entry, index) => rawMessage(entry, index + 1))]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8",
  );
}

async function withLog<T>(callback: (logSession: NamedSession, path: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "utterlog-reader-test-"));
  const path = join(root, "session.jsonl");
  const logSession = sessionAt(path, join(root, "project"));
  try {
    return await callback(logSession, path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function render(setup: Awaited<ReturnType<typeof createTestRenderer>>, passes = 3): Promise<void> {
  for (let index = 0; index < passes; index += 1) await setup.renderOnce();
}

const noWatch: WatchFactory = () => ({ close() {} });

describe("native conversation reader", () => {
  test("mouse wheel leaves follow mode and keeps the earlier position across frames", async () => {
    const setup = await createTestRenderer({ width: 80, height: 12 });
    const messages = Array.from({ length: 20 }, (_, i) => message("user", `Earlier request ${i}`));
    const reader = await createConversationReader({ session, messages, load: async () => messages, renderer: setup.renderer, ownsRenderer: false, watchFactory: noWatch });
    try {
      reader.start();
      await reader.waitForIdle();
      await render(setup);
      const bottom = reader.snapshot().scrollTop;
      await setup.mockMouse.scroll(10, 5, "up");
      expect(reader.snapshot().scrollTop).toBeLessThan(bottom);
      expect(reader.snapshot().follow).toBe(false);
      await render(setup);
      expect(reader.snapshot().scrollTop).toBeLessThan(bottom);
      expect(reader.snapshot().follow).toBe(false);
      const position = reader.snapshot().scrollTop;
      await render(setup);
      expect(reader.snapshot().scrollTop).toBe(position);
      for (let i = 0; i < 10 && !reader.snapshot().follow; i += 1) {
        await setup.mockMouse.scroll(10, 5, "down");
        await render(setup);
      }
      expect(reader.snapshot().follow).toBe(true);
      expect(reader.snapshot().scrollTop).toBe(reader.snapshot().maxScrollTop);
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("static markdown stays readable while highlighting is pending, including untyped fences", async () => {
    const setup = await createTestRenderer({ width: 100, height: 20 });
    const messages = [message("assistant", "# Heading\n\nReadable body\n\n```\nplain fence\n```")];
    const reader = await createConversationReader({ session, messages, load: async () => messages, renderer: setup.renderer, ownsRenderer: false, watchFactory: noWatch });
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)];
    const nodes = descendants(setup.renderer.root);
    const markdown = nodes.find((node) => node instanceof MarkdownRenderable) as MarkdownRenderable;
    const code = nodes.find((node) => node instanceof CodeRenderable) as CodeRenderable;
    const original = code.treeSitterClient.highlightOnce.bind(code.treeSitterClient);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const highlight = spyOn(code.treeSitterClient, "highlightOnce").mockImplementation(async (...args) => {
      await pending;
      return original(...args);
    });
    try {
      reader.start();
      await reader.waitForIdle();
      await render(setup);
      expect(highlight).toHaveBeenCalled();
      expect(markdown.streaming).toBe(false);
      expect(setup.captureCharFrame()).toContain("Readable body");
      expect(setup.captureCharFrame()).toContain("plain fence");
      release();
      await Promise.all(nodes.filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone));
      await render(setup);
      expect(markdown.streaming).toBe(false);
      expect(setup.captureCharFrame()).toContain("Readable body");
      expect(setup.captureCharFrame()).toContain("plain fence");
    } finally {
      release();
      highlight.mockRestore();
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("copies a mouse selection only on release and removes the callback on leaving", async () => {
    const setup = await createTestRenderer({ width: 80, height: 12 });
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const messages = [message("assistant", "copy this text 中文")];
    const reader = await createConversationReader({ session, messages, load: async () => messages, renderer: setup.renderer, ownsRenderer: false, watchFactory: noWatch });
    try {
      reader.start();
      await reader.waitForIdle();
      await render(setup);
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes("copy this text"));
      const x = lines[y].indexOf("copy this text");
      await setup.mockMouse.pressDown(x, y);
      await setup.mockMouse.emitMouseEvent("drag", x + 8, y);
      expect(copy).not.toHaveBeenCalled();
      const selection = setup.renderer.getSelection()!;
      const selectedText = selection.getSelectedText();
      await setup.mockMouse.release(x + 8, y);
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0][0]).toContain("copy");
      expect(copy.mock.calls[0][0]).toBe(selectedText);
      expect(reader.snapshot().status).toContain("copy sent to terminal");
      expect(setup.renderer.getSelection()).toBeNull();
      copy.mockReturnValue(false);
      await setup.mockMouse.pressDown(x, y);
      await setup.mockMouse.emitMouseEvent("drag", x + 8, y);
      const unavailableSelection = setup.renderer.getSelection()!;
      await setup.mockMouse.release(x + 8, y);
      expect(reader.snapshot().status).toContain("terminal clipboard unavailable");
      expect(setup.renderer.getSelection()).toBe(unavailableSelection);
      reader.dispose("back");
      setup.renderer.emit("selection", unavailableSelection);
      expect(copy).toHaveBeenCalledTimes(2);
    } finally {
      reader.dispose();
      copy.mockRestore();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("keeps a parenthesized design-document path visible", async () => {
    const setup = await createTestRenderer({ width: 120, height: 12 });
    const body = "已追加到本轮设计文档 (.scratch/voice-and-relationship-design.md)，尚未修改运行代码。";
    const reader = await createConversationReader({
      session,
      messages: [message("assistant", body)],
      load: async () => [message("assistant", body)],
      renderer: setup.renderer,
      ownsRenderer: false,
      watchFactory: noWatch,
    });
    try {
      reader.start();
      await reader.waitForIdle();
      await render(setup);
      expect(setup.captureCharFrame()).toContain("(.scratch/voice-and-relationship-design.md)，尚未修改运行代码。");
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("searches visible message numbers, roles and times as well as body occurrences", async () => {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    const messages = Array.from({ length: 625 }, (_, index) =>
      index === 619
        ? message("assistant", `${"ordinary line\n".repeat(30)}body marker: message 620`, "2026-09-13 09:42")
        : message("user", `Request ${index + 1}`),
    );
    const reader = await createConversationReader({
      session, messages, load: async () => messages, renderer: setup.renderer, watchFactory: noWatch,
    });
    const search = async (query: string) => {
      setup.mockInput.pressKey("/");
      await setup.mockInput.typeText(query);
      setup.mockInput.pressEnter();
      await render(setup, 4);
    };
    try {
      reader.start();
      await reader.waitForIdle();
      await render(setup);
      await search("MESSAGE 620");
      expect(reader.snapshot().searchMatches).toBe(2);
      expect(setup.captureCharFrame()).toContain("▸ Assistant · 2026-09-13 09:42 · message 620");
      setup.mockInput.pressKey("n");
      await render(setup);
      expect(reader.snapshot().searchMatch).toBe(2);
      expect(setup.captureCharFrame()).toContain("body marker: message 620");
      setup.mockInput.pressKey("N", { shift: true });
      await render(setup);
      expect(reader.snapshot().searchMatch).toBe(1);
      expect(setup.captureCharFrame()).toContain("▸ Assistant · 2026-09-13 09:42 · message 620");
      for (const query of ["assistant", "09:42"]) {
        await search(query);
        expect(reader.snapshot().searchMatches).toBe(1);
        expect(setup.captureCharFrame()).toContain("▸ Assistant · 2026-09-13 09:42 · message 620");
      }
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("renders the latest message and responds to native navigation input", async () => {
    const setup = await createTestRenderer({ width: 72, height: 14 });
    const initialMessages = [
      ...Array.from({ length: 7 }, (_, index) => message("user", `Earlier request ${index + 1}`)),
      message("assistant", "# Latest answer\n\n- Markdown stays readable\n- 你好"),
    ];
    const reader = await createConversationReader({
      session,
      messages: initialMessages,
      load: async () => initialMessages,
      renderer: setup.renderer,
      watchFactory: noWatch,
    });

    try {
      reader.start();
      await setup.renderOnce();
      await setup.renderOnce();
      const initial = setup.captureCharFrame();
      expect(initial).toContain("Latest answer");
      expect(initial).toContain("你好");
      expect(initial).toContain("Assistant");
      expect(initial).toContain("2026-09-12 20:00");
      expect(reader.snapshot().follow).toBe(true);

      setup.mockInput.pressArrow("up");
      await setup.renderOnce();
      expect(reader.snapshot().follow).toBe(false);
      expect(reader.snapshot().scrollTop).toBeGreaterThan(0);

      setup.mockInput.pressKey("g");
      setup.mockInput.pressKey("g");
      await setup.renderOnce();
      expect(reader.snapshot().scrollTop).toBe(0);
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("quits on native Ctrl-C and destroys the renderer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const initialMessages = [message("assistant", "quit safely")];
    const reader = await createConversationReader({
      session,
      messages: initialMessages,
      load: async () => initialMessages,
      renderer: setup.renderer,
      watchFactory: noWatch,
    });

    try {
      reader.start();
      await render(setup, 2);
      const exit = reader.waitForExit();
      setup.mockInput.pressCtrlC();
      await exit;
      expect(reader.snapshot().disposed).toBe(true);
      expect(setup.renderer.isDestroyed).toBe(true);
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("supports line, half-page, gg/G navigation and literal search inside long messages", async () => {
    const setup = await createTestRenderer({ width: 64, height: 12 });
    const longBody = Array.from({ length: 120 }, (_, index) => {
      const marker = index === 73 || index === 101 ? "needle" : `line-${index}`;
      return `${marker} with enough text to wrap at this terminal width`;
    }).join("\n");
    const initialMessages = [
      ...Array.from({ length: 6 }, (_, index) => message("user", `Earlier request ${index + 1}`)),
      message("assistant", longBody),
    ];
    const reader = await createConversationReader({
      session,
      messages: initialMessages,
      load: async () => initialMessages,
      renderer: setup.renderer,
      watchFactory: noWatch,
    });

    try {
      reader.start();
      await render(setup, 4);
      expect(reader.snapshot().follow).toBe(true);
      expect(setup.captureCharFrame()).toContain("line-119");

      setup.mockInput.pressKey("g");
      setup.mockInput.pressKey("g");
      await render(setup);
      expect(reader.snapshot().scrollTop).toBe(0);
      expect(reader.snapshot().follow).toBe(false);

      setup.mockInput.pressKey("j");
      await render(setup);
      const afterLine = reader.snapshot().scrollTop;
      expect(afterLine).toBe(1);
      setup.mockInput.pressKey("d", { ctrl: true });
      await render(setup);
      expect(reader.snapshot().scrollTop).toBeGreaterThan(afterLine);
      setup.mockInput.pressKey("u", { ctrl: true });
      await render(setup);
      expect(reader.snapshot().scrollTop).toBeLessThan(afterLine + Math.floor(6 / 2));

      setup.mockInput.pressKey("G", { shift: true });
      await render(setup);
      expect(reader.snapshot().follow).toBe(true);
      expect(reader.snapshot().scrollTop).toBe(reader.snapshot().maxScrollTop);

      setup.mockInput.pressKey("/");
      await render(setup);
      expect(reader.snapshot().searchEditing).toBe(true);
      expect(reader.snapshot().follow).toBe(false);
      await setup.mockInput.typeText("needle");
      setup.mockInput.pressEnter();
      await render(setup, 4);
      expect(reader.snapshot().searchQuery).toBe("needle");
      expect(reader.snapshot().searchMatch).toBe(1);
      expect(reader.snapshot().searchMatches).toBe(2);
      const firstMatchPosition = reader.snapshot().scrollTop;
      expect(firstMatchPosition).toBeGreaterThan(0);
      expect(firstMatchPosition).toBeLessThan(reader.snapshot().maxScrollTop);
      expect(setup.captureCharFrame().toLocaleLowerCase()).toContain("needle");

      setup.mockInput.pressKey("n");
      await render(setup, 2);
      expect(reader.snapshot().searchMatch).toBe(2);
      expect(reader.snapshot().scrollTop).toBeGreaterThan(firstMatchPosition);
      setup.mockInput.pressKey("N", { shift: true });
      await render(setup, 2);
      expect(reader.snapshot().searchMatch).toBe(1);
      expect(reader.snapshot().scrollTop).toBe(firstMatchPosition);

      setup.mockInput.pressKey("/");
      await setup.mockInput.typeText("cancel");
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await render(setup);
      expect(reader.snapshot().searchEditing).toBe(false);
      expect(reader.snapshot().searchQuery).toBe("needle");
      expect(reader.snapshot().disposed).toBe(false);

      setup.mockInput.pressKey("/");
      await setup.mockInput.typeText("missing");
      setup.mockInput.pressEnter();
      await render(setup, 2);
      expect(reader.snapshot().searchMatch).toBe(0);
      expect(reader.snapshot().searchMatches).toBe(0);
      expect(reader.snapshot().status).toContain("no matches");

      setup.mockInput.pressKey("/");
      for (let index = 0; index < "missing".length; index += 1) setup.mockInput.pressBackspace();
      setup.mockInput.pressEnter();
      await render(setup, 2);
      expect(reader.snapshot().searchQuery).toBe("");
      expect(reader.snapshot().searchMatches).toBe(0);
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("reconciles a change made before the initial watcher refresh", async () => {
    const setup = await createTestRenderer({ width: 68, height: 10 });
    const initialMessages = [message("user", "initial message")];
    const updatedMessages = [...initialMessages, message("assistant", "written before watcher refresh")];
    let currentMessages = initialMessages;
    let watcherAttached = false;
    const reader = await createConversationReader({
      session: sessionAt("/initial-gap.jsonl"),
      messages: initialMessages,
      load: async () => currentMessages,
      renderer: setup.renderer,
      coalesceDelayMs: 0,
      watchFactory: (_path, _listener) => {
        watcherAttached = true;
        currentMessages = updatedMessages;
        return { close() {} };
      },
    });

    try {
      const initialRefresh = reader.waitForNextRefresh();
      reader.start();
      await initialRefresh;
      await render(setup, 3);
      expect(watcherAttached).toBe(true);
      expect(reader.snapshot().messages).toBe(updatedMessages.length);
      expect(setup.captureCharFrame()).toContain("written before watcher refresh");
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("reconciles a change during watcher reattachment", async () => {
    const setup = await createTestRenderer({ width: 68, height: 10 });
    const initialMessages = [message("user", "initial message")];
    const updatedMessages = [...initialMessages, message("assistant", "written during rewatch")];
    let currentMessages = initialMessages;
    let attachCount = 0;
    const listeners: Array<(eventType: string) => void> = [];
    let resolveRewatchAttached!: () => void;
    const rewatchAttached = new Promise<void>((resolve) => {
      resolveRewatchAttached = resolve;
    });
    const watchFactory: WatchFactory = (_path, listener) => {
      attachCount += 1;
      listeners.push(listener);
      if (attachCount === 2) {
        currentMessages = updatedMessages;
        resolveRewatchAttached();
      }
      return { close() {} };
    };
    const reader = await createConversationReader({
      session: sessionAt("/rewatch-gap.jsonl"),
      messages: initialMessages,
      load: async () => currentMessages,
      renderer: setup.renderer,
      coalesceDelayMs: 0,
      watchFactory,
    });

    try {
      const initialRefresh = reader.waitForNextRefresh();
      reader.start();
      await initialRefresh;
      await render(setup, 3);
      expect(attachCount).toBe(1);

      const renameRefresh = reader.waitForNextRefresh();
      listeners[0]!("rename");
      await renameRefresh;
      expect(attachCount).toBe(1);

      const rewatchRefresh = reader.waitForNextRefresh();
      await rewatchAttached;
      await rewatchRefresh;
      await render(setup, 3);
      expect(attachCount).toBe(2);
      expect(reader.snapshot().messages).toBe(updatedMessages.length);
      expect(setup.captureCharFrame()).toContain("written during rewatch");
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("keeps unseen search content visible and G resumes follow in the native frame", async () => {
    const setup = await createTestRenderer({ width: 72, height: 10 });
    const initialMessages = [
      message("user", "find this needle"),
      message("assistant", "initial answer"),
    ];
    let currentMessages = initialMessages;
    let notify!: () => void;
    const reader = await createConversationReader({
      session: sessionAt("/search-gap.jsonl"),
      messages: initialMessages,
      load: async () => currentMessages,
      renderer: setup.renderer,
      coalesceDelayMs: 0,
      watchFactory: (_path, listener) => {
        notify = () => listener("change");
        return { close() {} };
      },
    });

    try {
      const initialRefresh = reader.waitForNextRefresh();
      reader.start();
      await initialRefresh;
      await render(setup, 3);

      setup.mockInput.pressKey("/");
      await render(setup);
      await setup.mockInput.typeText("needle");
      setup.mockInput.pressEnter();
      await render(setup, 3);
      expect(reader.snapshot().searchQuery).toBe("needle");
      expect(setup.captureCharFrame()).toContain("match 1/1");
      expect(setup.captureCharFrame()).toContain("follow: paused");

      currentMessages = [...initialMessages, message("assistant", "new tail")];
      const appendRefresh = reader.waitForNextRefresh();
      notify();
      await appendRefresh;
      await render(setup, 3);
      const unseenFrame = setup.captureCharFrame();
      expect(reader.snapshot().follow).toBe(false);
      expect(reader.snapshot().status).toContain("new content");
      expect(unseenFrame).toContain("match 1/1");
      expect(unseenFrame).toContain("new content available");

      setup.mockInput.pressKey("G", { shift: true });
      await render(setup, 3);
      const followedFrame = setup.captureCharFrame();
      expect(reader.snapshot().follow).toBe(true);
      expect(reader.snapshot().searchQuery).toBe("needle");
      expect(reader.snapshot().status).toContain("follow: on");
      expect(followedFrame).toContain("match 1/1");
      expect(followedFrame).toContain("follow: on");
      expect(followedFrame).not.toContain("new content available");
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("refreshes a real selected log, follows new messages, preserves browsing, and recovers", async () => {
    await withLog(async (logSession, path) => {
      const initialMessages = [
        ...Array.from({ length: 9 }, (_, index) => message("user", `history-${index}`)),
        message("assistant", "initial latest"),
      ];
      await writeLog(path, logSession, initialMessages);
      const setup = await createTestRenderer({ width: 72, height: 12 });
      const reader = await createConversationReader({
        session: logSession,
        messages: initialMessages,
        load: async () => {
          const parsed = parseTranscript(await readFile(path, "utf8"), logSession);
          if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
          return parsed.messages;
        },
        renderer: setup.renderer,
      });

      try {
        reader.start();
        await render(setup, 4);
        await reader.waitForIdle();
        const followed = reader.waitForNextRefresh();
        const followedMessages = [...initialMessages, message("assistant", "new end")];
        await writeLog(path, logSession, followedMessages);
        await followed;
        await render(setup, 3);
        expect(reader.snapshot().messages).toBe(followedMessages.length);
        expect(reader.snapshot().follow).toBe(true);
        expect(setup.captureCharFrame()).toContain("new end");

        setup.mockInput.pressKey("g");
        setup.mockInput.pressKey("g");
        await render(setup, 2);
        setup.mockInput.pressKey("j");
        await render(setup, 2);
        const browsingPosition = reader.snapshot().scrollTop;
        expect(reader.snapshot().follow).toBe(false);

        const browsingRefresh = reader.waitForNextRefresh();
        const moreMessages = [...followedMessages, message("assistant", "another end")];
        await writeLog(path, logSession, moreMessages);
        await browsingRefresh;
        await render(setup, 3);
        expect(reader.snapshot().follow).toBe(false);
        expect(reader.snapshot().scrollTop).toBe(browsingPosition);
        expect(reader.snapshot().status).toContain("new content");

        setup.mockInput.pressKey("G", { shift: true });
        await render(setup, 2);
        expect(reader.snapshot().follow).toBe(true);
        expect(reader.snapshot().status).toContain("follow");

        const toolOnlyRefresh = reader.waitForNextRefresh();
        const toolRecord = {
          type: "response_item",
          timestamp: "2026-09-12T13:00:00.000Z",
          ordinal: 99,
          payload: { type: "custom_tool_call_output", output: "hidden tool output" },
        };
        await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(toolRecord)}\n`, "utf8");
        await toolOnlyRefresh;
        await render(setup, 2);
        expect(reader.snapshot().messages).toBe(moreMessages.length);
        expect(reader.snapshot().status).toContain("follow");

        const partialRefresh = reader.waitForNextRefresh();
        const partialRecord = JSON.stringify(rawMessage(message("assistant", "completed append"), 100)).slice(0, -1);
        await writeFile(path, `${await readFile(path, "utf8")}${partialRecord}`, "utf8");
        await partialRefresh;
        await render(setup, 2);
        expect(reader.snapshot().messages).toBe(moreMessages.length);
        expect(reader.snapshot().status).not.toContain("error");

        const completedRefresh = reader.waitForNextRefresh();
        await writeFile(path, `${await readFile(path, "utf8")}}\n`, "utf8");
        await completedRefresh;
        await render(setup, 2);
        expect(reader.snapshot().messages).toBe(moreMessages.length + 1);
        expect(setup.captureCharFrame()).toContain("completed append");

        const failedRefresh = reader.waitForNextRefresh();
        await writeFile(path, `${await readFile(path, "utf8")}not-json\n`, "utf8");
        await failedRefresh;
        expect(reader.snapshot().messages).toBe(moreMessages.length + 1);
        expect(reader.snapshot().status).toContain("refresh error");

        await writeLog(path, logSession, [...moreMessages, message("user", "recovered"), message("assistant", "recovered end")]);
        await reader.refresh();
        await render(setup, 3);
        expect(reader.snapshot().messages).toBe(moreMessages.length + 2);
        expect(reader.snapshot().status).not.toContain("refresh error");
      } finally {
        reader.dispose();
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      }
    });
  });

  test("coalesces watcher bursts and serializes refresh reads", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    let notify!: () => void;
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveFirst!: (messages: TranscriptMessage[]) => void;
    const firstResult = new Promise<TranscriptMessage[]>((resolve) => {
      resolveFirst = resolve;
    });
    const reader = await createConversationReader({
      session: { ...session, path: "/serialized.jsonl" },
      messages: [message("user", "initial")],
      load: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (calls === 1) {
            resolveStarted();
            return await firstResult;
          }
          return [message("assistant", `refresh result ${calls}`)];
        } finally {
          active -= 1;
        }
      },
      renderer: setup.renderer,
      coalesceDelayMs: 0,
      watchFactory: (_path, listener) => {
        notify = () => listener("change");
        return { close() {} };
      },
    });

    try {
      reader.start();
      const firstRefresh = reader.waitForNextRefresh();
      notify();
      notify();
      notify();
      await started;

      const queuedRefresh = reader.waitForNextRefresh();
      notify();
      notify();
      notify();
      resolveFirst([message("assistant", "first refresh")]);
      await Promise.all([firstRefresh, queuedRefresh]);

      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
      expect(reader.snapshot().messages).toBe(1);
      expect(reader.snapshot().status).toContain("follow");
    } finally {
      reader.dispose();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("closes the old watcher and ignores a pending result after disposal", async () => {
    const firstSetup = await createTestRenderer({ width: 60, height: 10 });
    const secondSetup = await createTestRenderer({ width: 60, height: 10 });
    let activeWatchers = 0;
    let change!: () => void;
    const watchFactory: WatchFactory = (_path, listener) => {
      activeWatchers += 1;
      change = () => listener("change");
      return {
        close() {
          activeWatchers -= 1;
        },
      };
    };
    let resolvePending!: (messages: TranscriptMessage[]) => void;
    const pending = new Promise<TranscriptMessage[]>((resolve) => {
      resolvePending = resolve;
    });
    let resolveLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      resolveLoadStarted = resolve;
    });
    const first = await createConversationReader({
      session: { ...session, path: "/first.jsonl" },
      messages: [message("user", "first")],
      load: () => {
        resolveLoadStarted();
        return pending;
      },
      renderer: firstSetup.renderer,
      watchFactory,
    });
    const second = await createConversationReader({
      session: { ...session, id: "55555555-5555-4555-8555-555555555555", path: "/second.jsonl" },
      messages: [message("user", "second")],
      load: async () => [message("user", "second")],
      renderer: secondSetup.renderer,
      watchFactory: noWatch,
    });

    try {
      first.start();
      second.start();
      await render(firstSetup, 2);
      await render(secondSetup, 2);
      change();
      const refresh = first.refresh();
      await loadStarted;
      first.dispose();
      expect(activeWatchers).toBe(0);
      await refresh;
      resolvePending([message("assistant", "stale first result")]);
      await Promise.resolve();
      expect(first.snapshot().disposed).toBe(true);
      expect(second.snapshot().messages).toBe(1);
      expect(second.snapshot().status).not.toContain("stale");
    } finally {
      first.dispose();
      second.dispose();
      if (!firstSetup.renderer.isDestroyed) firstSetup.renderer.destroy();
      if (!secondSetup.renderer.isDestroyed) secondSetup.renderer.destroy();
    }
  });
});
