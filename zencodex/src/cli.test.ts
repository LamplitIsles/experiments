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

test("reader is editable before backend connects, but sending waits for history readiness", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-early-reader-"));
  const ui = await createTestRenderer({ width: 80, height: 24 });
  const connecting = Promise.withResolvers<void>();
  const shell = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let options!: ConversationReaderOptions;
  const run = main(["--resume", "thread-fake"], {
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
  const run = main(["--resume", "thread-fake"], {
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
        ["--resume", id],
        {
          createTerminalRenderer: async () => renderer,
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
    ["--resume", ""],
    ["--resume", "id", "extra"],
    ["--unknown"],
    ["--resume", "bad\nid"],
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
