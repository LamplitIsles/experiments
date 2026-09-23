import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli";
import { connect } from "./app-server";
import { fileExporter, PerformanceTrace, traceEvents } from "./tracing";
import type {
  createTerminalRenderer,
  createConversationReader,
} from "./reader";
import {
  createConversationReader as makeReader,
  type ConversationReaderOptions,
} from "./reader";
import { createTestRenderer } from "@opentui/core/testing";

test("a new thread opens without querying history that does not exist yet", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-new-"));
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const ready = Promise.withResolvers<void>();
  const output: string[] = [];
  let readerOptions: ConversationReaderOptions | undefined;
  let run: Promise<void> | undefined;
  try {
    run = main([], {
      createTerminalRenderer: async () => ui.renderer,
      discoverSessions: async () => {
        throw new Error("new mode must not discover sessions");
      },
      pickSession: async () => {
        throw new Error("new mode must not show the resume picker");
      },
      connect: (_cwd, _path, config) =>
        connect(
          cwd,
          fileURLToPath(
            new URL("./fake-app-server-entry.mjs", import.meta.url),
          ),
          {
            env: {
              HERDR_ENV: "0",
              CODEX_HOME: cwd,
              FAKE_HISTORY_ERROR: "thread is not loaded",
              FAKE_HISTORY_ERROR_CODE: "-32600",
            },
            signal: config?.signal,
          },
        ),
      createHerdrReporter: () => ({ idle() {}, working() {}, release() {} }),
      writeOutput: (text) => output.push(text),
      waitFrame: async () => {
        await ui.flush();
        if (readerOptions?.canSubmit?.()) ready.resolve();
      },
      createConversationReader: async (options) => {
        readerOptions = options;
        return makeReader(options);
      },
    });
    await Promise.race([
      ready.promise,
      run.then(() => {
        throw new Error("new reader exited before becoming ready");
      }),
    ]);
    expect(ui.captureCharFrame()).toContain("Enter send/steer");
    await ui.mockInput.pressKey("d", { ctrl: true });
    await run;
    expect(output).toEqual([
      "To continue this session, run:\n  zencodex resume thread-fake",
    ]);
    const calls = (
      await readFile(join(cwd, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.some((call) => call.method === "thread/start")).toBe(true);
    expect(calls.some((call) => call.method === "thread/turns/list")).toBe(
      false,
    );
  } finally {
    if (!ui.renderer.isDestroyed) ui.renderer.destroy();
    await run?.catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test("exiting a reader selected from the resume list ends without reopening the list", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-resume-list-"));
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const session = {
    id: "first",
    name: "first",
    cwd,
    path: "",
    activityMs: 0,
  };
  let picks = 0;
  let reader: Awaited<ReturnType<typeof makeReader>> | undefined;
  let readerOptions: ConversationReaderOptions | undefined;
  const output: string[] = [];
  try {
    await main(["resume"], {
      createTerminalRenderer: async () => ui.renderer,
      discoverSessions: async () => [session],
      writeOutput: (text) => output.push(text),
      pickSession: async (renderer, listed) => {
        expect(renderer).toBe(ui.renderer);
        expect(listed.map((session) => session.id)).toEqual(["first"]);
        expect(renderer.screenMode).toBe("alternate-screen");
        expect(renderer.externalOutputMode).toBe("passthrough");
        expect(renderer.useMouse).toBe(true);
        picks++;
        return session;
      },
      connect: (_cwd, _path, config) =>
        connect(
          cwd,
          fileURLToPath(
            new URL("./fake-app-server-entry.mjs", import.meta.url),
          ),
          { env: { HERDR_ENV: "0", CODEX_HOME: cwd }, signal: config?.signal },
        ),
      createConversationReader: (options) => {
        readerOptions = options;
        expect(options.renderer.screenMode).toBe("split-footer");
        expect(options.renderer.externalOutputMode).toBe("capture-stdout");
        expect(options.renderer.footerHeight).toBe(7);
        expect(options.renderer.useMouse).toBe(false);
        return makeReader(options).then((created) => {
          reader = created;
          return created;
        });
      },
      waitFrame: async () => {
        await ui.flush();
        if (!readerOptions?.canSubmit?.()) return;
        reader!.project([
          {
            role: "assistant",
            body: "Reader output",
            timestampLabel: "now",
          },
        ]);
        await reader!.waitForIdle();
        await ui.mockInput.pressKey("d", { ctrl: true });
      },
    });
    expect(picks).toBe(1);
    expect(output).toEqual([
      "To continue this session, run:\n  zencodex resume thread-fake",
    ]);
    expect(ui.externalOutput.takeText()).toContain("Reader output");
    expect(ui.renderer.isDestroyed).toBe(true);
  } finally {
    if (!ui.renderer.isDestroyed) ui.renderer.destroy();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reader is editable before backend connects, but sending waits for history readiness", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-early-reader-"));
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const connecting = Promise.withResolvers<void>();
  const shell = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let options!: ConversationReaderOptions;
  const output: string[] = [];
  const run = main(["resume", "thread-fake"], {
    createTerminalRenderer: async () => ui.renderer,
    connect: async (_cwd, _path, config) => {
      await connecting.promise;
      return connect(
        cwd,
        fileURLToPath(new URL("./fake-app-server-entry.mjs", import.meta.url)),
        {
          env: { HERDR_ENV: "0", CODEX_HOME: cwd },
          signal: config?.signal,
        },
      );
    },
    createHerdrReporter: () => ({ idle() {}, working() {}, release() {} }),
    writeOutput: (text) => output.push(text),
    createConversationReader: async (input) => {
      options = input;
      return makeReader(input);
    },
    waitFrame: async () => {
      await ui.flush();
      if (options.canSubmit?.()) ready.resolve();
      else shell.resolve();
    },
  });
  try {
    await shell.promise;
    expect(options.canSubmit?.()).toBe(false);
    expect(ui.captureCharFrame()).toContain("Connecting backend");
    await ui.mockInput.typeText("My draft");
    await ui.mockInput.pressKey("RETURN");
    await ui.mockInput.pressKey("TAB");
    connecting.resolve();
    await ready.promise;
    expect(options.canSubmit?.()).toBe(true);
    expect(ui.captureCharFrame()).toContain("My draft");
    const calls = await readFile(
      join(cwd, ".fake-app-server-requests.jsonl"),
      "utf8",
    );
    expect(calls).not.toContain('"method":"turn/start"');
    expect(calls).toContain('"method":"thread/turns/list"');
    await ui.mockInput.pressKey("d", { ctrl: true });
    await run;
    expect(output).toEqual([
      "To continue this session, run:\n  zencodex resume thread-fake",
    ]);
  } finally {
    connecting.resolve();
    if (!ui.renderer.isDestroyed) ui.renderer.destroy();
    await run.catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});

test("exiting the loading reader aborts a pending backend connection", async () => {
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const shell = Promise.withResolvers<void>();
  let cancelled = false;
  const run = main(["resume", "thread-fake"], {
    createTerminalRenderer: async () => ui.renderer,
    connect: (_cwd, _path, config) =>
      new Promise((_resolve, reject) => {
        config!.signal!.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
    waitFrame: async () => {
      await ui.flush();
      shell.resolve();
    },
    createConversationReader: (input) => makeReader(input),
  });
  try {
    await shell.promise;
    await ui.mockInput.pressKey("d", { ctrl: true });
    await run;
    expect(cancelled).toBe(true);
    expect(ui.renderer.isDestroyed).toBe(true);
  } finally {
    if (!ui.renderer.isDestroyed) ui.renderer.destroy();
    await run.catch(() => {});
  }
});

for (const [id, fails] of [
  ["thread-fake", false],
  ["thread-fake", true],
  ["zencodex:new", true],
] as const)
  test(`direct resume ${id} ${fails ? "fails without fallback" : "opens exactly the requested thread"}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zencodex-cli-"));
    const exporter = fileExporter(join(cwd, "traces"));
    const performance = new PerformanceTrace(exporter);
    const states: string[] = [];
    let renderedId: string | undefined;
    let destroyed = false;
    const output: string[] = [];
    const renderer = {
      isDestroyed: false,
      destroy() {
        destroyed = true;
      },
    } as Awaited<ReturnType<typeof createTerminalRenderer>>;
    try {
      if (fails)
        await writeFile(
          join(cwd, ".fake-app-server-control.json"),
          JSON.stringify({
            resumeError: { code: -32600, message: "thread does not exist" },
          }),
        );
      const run = main(
        ["resume", id],
        {
          createTerminalRenderer: async () => renderer,
          writeOutput: (text) => {
            expect(destroyed).toBe(true);
            output.push(text);
          },
          waitFrame: async () => {},
          discoverSessions: async () => {
            throw new Error("direct resume must not scan history");
          },
          pickSession: async () => {
            throw new Error("direct resume must not open picker");
          },
          connect: () =>
            connect(
              cwd,
              fileURLToPath(
                new URL("./fake-app-server-entry.mjs", import.meta.url),
              ),
              { env: { HERDR_ENV: "0", CODEX_HOME: cwd } },
            ),
          createHerdrReporter: () => ({
            idle: () => states.push("idle"),
            working: () => states.push("working"),
            release: () => states.push("release"),
          }),
          createConversationReader: async (options) => {
            renderedId = options.session.id;
            let exit!: (value: "quit") => void;
            const exited = new Promise<"quit">((resolve) => {
              exit = resolve;
            });
            return {
              start() {},
              loadHistory() {},
              dispose() {},
              project() {
                if (options.canSubmit?.()) setTimeout(() => exit("quit"), 0);
              },
              waitForExit: () => exited,
            } as unknown as Awaited<
              ReturnType<typeof createConversationReader>
            >;
          },
        },
        performance,
      );
      if (fails) await expect(run).rejects.toThrow(`Cannot resume ${id}`);
      else await run;
      await performance.close();
      // Application shutdown is time-bounded; artifact assertions must await
      // this test-owned exporter's outstanding filesystem work as well.
      await exporter.forceFlush?.();
      const events = (await traceEvents(join(cwd, "traces"))).traceEvents;
      expect(events.some((event) => event.name === "session.load")).toBe(true);
      if (!fails) {
        const startup = events.find(
          (event) => event.name === "startup.direct_resume",
        )!;
        const load = events.find((event) => event.name === "session.load")!;
        expect(load.args.parentSpanId).toBe(startup.args.spanId);
        expect(events.some((event) => event.name === "history.page")).toBe(
          true,
        );
        const projection = events.find(
          (event) => event.name === "history.projection",
        )!;
        const history = events.find((event) => event.name === "history.load")!;
        expect(projection.args.parentSpanId).toBe(history.args.spanId);
        expect(projection.args.traceId).toBe(history.args.traceId);
        expect(
          events.some((event) => event.name === "reader.first_frame"),
        ).toBe(true);
      }
      expect(destroyed).toBe(true);
      expect(output).toEqual(
        fails
          ? []
          : ["To continue this session, run:\n  zencodex resume thread-fake"],
      );
      expect(renderedId).toBe(id);
      expect(states).toEqual(fails ? [] : ["idle", "release"]);
      const calls = (
        await readFile(join(cwd, ".fake-app-server-requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls
          .filter((r) => r.method === "thread/resume")
          .map((r) => r.params.threadId),
      ).toEqual([id]);
      expect(calls.some((r) => r.method === "thread/start")).toBe(false);
    } finally {
      await performance.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

test("invalid resume arguments fail before creating terminal UI", async () => {
  for (const args of [
    ["--resume"],
    ["--resume", "id"],
    ["resume", ""],
    ["resume", "id", "extra"],
    ["--unknown"],
    ["resume", "bad\nid"],
  ]) {
    await expect(
      main(args, {
        createTerminalRenderer: async () => {
          throw new Error("UI must not start");
        },
      }),
    ).rejects.toThrow("Usage:");
  }
});
