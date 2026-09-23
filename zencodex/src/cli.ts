#!/usr/bin/env bun
/** Direct utterlog picker/reader transplants wired only to official app-server. */
import { createConversationReader, createTerminalRenderer } from "./reader";
import type { CliRenderer } from "@opentui/core";
import { pickSession, type PickerState } from "./picker";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { createHerdrReporter } from "./herdr";
import { discoverSessions, latestTokenUsage } from "./discovery";
import { resumeAdmission } from "./admission";
import type { NamedSession, TranscriptMessage } from "./types";
import {
  defaultTraceDirectory,
  fileExporter,
  noTrace,
  PerformanceTrace,
  type Trace,
} from "./tracing";

const NEW = "zencodex:new";
const resumeHint = (id: string) =>
  `To continue this session, run:\n  zencodex resume ${id}`;

async function enterPickerMode(
  renderer: CliRenderer,
  waitFrame: (renderer: CliRenderer) => Promise<void>,
) {
  renderer.externalOutputMode = "passthrough";
  try {
    renderer.screenMode = "alternate-screen";
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !==
        "Cannot leave split-footer while captured output is pending"
    )
      throw error;
    // OpenTUI can defer passthrough while captured output awaits a split commit.
    // Its published frame drains that pending transition before we retry exit.
    await waitFrame(renderer);
    renderer.screenMode = "alternate-screen";
  }
  renderer.useMouse = true;
}

function enterReaderMode(renderer: CliRenderer) {
  renderer.footerHeight = 7;
  renderer.screenMode = "split-footer";
  renderer.useMouse = false;
  renderer.externalOutputMode = "capture-stdout";
}

function bar(total?: number, max?: number): string {
  if (typeof total !== "number" || typeof max !== "number" || max <= 0)
    return "context unavailable";
  const ratio = Math.min(1, total / max);
  const filled = Math.round(ratio * 12);
  return `context ${"━".repeat(filled)}${"─".repeat(12 - filled)} ${Math.round(ratio * 100)}%`;
}
function clock(ms?: number): string {
  return ms === undefined
    ? ""
    : `working ${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
}
function toTranscript(conversation: ReaderConversation): TranscriptMessage[] {
  return conversation.visible.map((message) => ({
    role: message.role,
    body: message.body,
    timestampLabel: message.timestamp,
    workedMs: message.workedMs,
  }));
}

const defaults = {
  createTerminalRenderer,
  pickSession,
  connect,
  discoverSessions,
  createConversationReader,
  createHerdrReporter,
  writeOutput: (text: string) => console.log(text),
  waitFrame: (renderer: Awaited<ReturnType<typeof createTerminalRenderer>>) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        renderer.off("frame", ready);
        renderer.off("destroy", destroyed);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const destroyed = () => {
        cleanup();
        reject(new Error("Terminal closed before first frame"));
      };
      if (renderer.isDestroyed) {
        destroyed();
        return;
      }
      renderer.once("frame", ready);
      renderer.once("destroy", destroyed);
      renderer.requestRender();
    }),
};
const usage = "Usage: zencodex [resume [thread-id]]";

export async function main(
  argv = process.argv.slice(2),
  overrides: Partial<typeof defaults> = {},
  performance: Trace = noTrace,
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage);
    return;
  }
  const pickerMode = argv.length === 1 && argv[0] === "resume";
  const newMode = argv.length === 0;
  let resumeId: string | undefined;
  if (!pickerMode && !newMode) {
    if (
      argv.length !== 2 ||
      argv[0] !== "resume" ||
      !argv[1]?.trim() ||
      argv[1].startsWith("-") ||
      /[\s\p{Cc}]/u.test(argv[1])
    )
      throw new Error(usage);
    resumeId = argv[1];
  }
  const {
    createTerminalRenderer,
    pickSession,
    connect,
    discoverSessions,
    createConversationReader,
    createHerdrReporter,
    writeOutput,
    waitFrame,
  } = { ...defaults, ...overrides };
  const cwd = process.cwd();
  const startup = performance.begin(
    pickerMode
      ? "startup.session_list"
      : newMode
        ? "startup.new"
        : "startup.direct_resume",
    {
      mode: pickerMode ? "picker" : newMode ? "new" : "resume",
      "schema.version": 1,
      "startup.pre_instrumentation_ms": process.uptime() * 1000,
    },
    Date.now() - process.uptime() * 1000,
  );
  const renderer = await startup
    .run(() =>
      performance.measure("renderer.initialize", createTerminalRenderer),
    )
    .catch((error) => {
      startup.end("error");
      throw error;
    });
  const picker: PickerState = { query: "" };
  startup.span.setAttributes({
    width: renderer.width,
    height: renderer.height,
  });
  let firstList = true;
  let lastSessionId: string | undefined;
  let exitedReader = false;
  try {
    while (!renderer.isDestroyed) {
      const listing = firstList
        ? startup
        : performance.begin("session_list.load");
      firstList = false;
      if (pickerMode) await enterPickerMode(renderer, waitFrame);
      const sessions = pickerMode
        ? await listing.run(() =>
            performance.measure("sessions.discover", () =>
              discoverSessions(cwd, undefined, performance),
            ),
          )
        : [];
      const choice: NamedSession | undefined = !pickerMode
        ? {
            id: resumeId ?? NEW,
            name: resumeId ?? "New session",
            cwd,
            path: newMode ? NEW : "",
            activityMs: 0,
          }
        : await listing.run(() =>
            pickSession(
              renderer,
              sessions,
              cwd,
              picker,
              0,
              () => {
                listing.end();
              },
              performance,
            ),
          );
      if (!choice) {
        listing.end("cancel");
        break;
      }
      if (pickerMode) listing.end();
      const beginLoading = () =>
        performance.begin("session.load", {
          mode: pickerMode ? "selected" : newMode ? "new" : "direct_resume",
        });
      const loading = pickerMode ? beginLoading() : startup.run(beginLoading);
      const measure = <T>(name: string, fn: () => Promise<T> | T) =>
        loading.run(() => performance.measure(name, fn));
      const isNew = newMode;
      const cancellation = new AbortController();
      let server: Awaited<ReturnType<typeof connect>> | undefined;
      let conversation: ReaderConversation | undefined;
      let reader:
        | Awaited<ReturnType<typeof createConversationReader>>
        | undefined;
      let preparing: Promise<void> | undefined;
      let ready = false;
      let phase = "Connecting backend · draft only";
      let reportWarning = "";
      const project = () =>
        reader?.project(conversation ? toTranscript(conversation) : []);
      // Attach rejection handling immediately: UI construction runs concurrently.
      const connection = measure("app_server.connect", () =>
        connect(cwd, undefined, { performance, signal: cancellation.signal }),
      ).then((connected) => {
        server = connected;
        return connected;
      });
      void connection.catch(() => {});
      try {
        enterReaderMode(renderer);
        reader = await measure("reader.construct", () =>
          createConversationReader({
            session: choice,
            messages: [],
            renderer,
            trace: performance,
            canSubmit: () => ready,
            hasEarlierHistory: () => conversation?.hasEarlierHistory() ?? false,
            loadEarlierHistory: async () => {
              await conversation!.loadEarlierHistory();
              return toTranscript(conversation!);
            },
            onQueue: async (input) => {
              if (!ready) return;
              await conversation!.queue(input);
              project();
            },
            onInterrupt: () => (ready ? conversation!.interrupt() : undefined),
            queuedInputs: () => conversation?.queuedInputs() ?? [],
            takeRestoredDraft: () => conversation?.takeRestoredDraft() ?? "",
            onSubmit: async (input) => {
              if (!ready) return;
              const submitted = conversation!.submit(input);
              project();
              await submitted;
              project();
            },
            loadSkills: () =>
              conversation?.listSkills(cwd) ?? Promise.resolve([]),
            skillsVersion: () =>
              conversation ? conversation.skillVersion + 1 : 0,
            loadModels: () => conversation?.listModels() ?? Promise.resolve([]),
            modelsVersion: () => (conversation ? 1 : 0),
            title: () => conversation?.runtime.name,
            statusLines: () => ({
              cwd,
              runtime: [
                conversation?.runtime.model ?? "model unavailable",
                conversation?.runtime.effort,
              ]
                .filter(Boolean)
                .join(" · "),
              telemetry: !ready
                ? phase
                : [
                    bar(
                      conversation?.tokenUsage?.last?.totalTokens,
                      conversation?.tokenUsage?.modelContextWindow,
                    ),
                    conversation?.recoveryLabel() ||
                      conversation?.notice ||
                      clock(conversation?.workingDurationMs()),
                    reportWarning,
                  ]
                    .filter(Boolean)
                    .join(" · "),
            }),
          }),
        );
        await measure("reader.shell", () => reader!.start());
        await measure("reader.shell_first_frame", () => waitFrame(renderer));
        const exiting = reader.waitForExit();
        preparing = (async () => {
          const connected = await connection;
          cancellation.signal.throwIfAborted();
          phase = "Opening thread · draft only";
          project();
          const opened = await measure(
            isNew ? "thread.start" : "thread.resume",
            () =>
              isNew
                ? connected.startThread()
                : connected.resumeThread(choice.id),
          );
          lastSessionId = opened.id;
          cancellation.signal.throwIfAborted();
          conversation = new ReaderConversation(
            connected,
            opened.id,
            createHerdrReporter(process.env, undefined, (message) => {
              reportWarning = message;
            }),
          );
          conversation.performance = performance;
          conversation.setRuntime(opened);
          if (isNew) conversation.enableAutomaticNaming();
          phase = "Loading history · draft only";
          project();
          if (!isNew && choice.path)
            conversation.seedTokenUsage(
              await measure("token_usage.seed", () =>
                latestTokenUsage(choice.path),
              ),
            );
          cancellation.signal.throwIfAborted();
          if (!isNew)
            await measure("history.load", () =>
              conversation!.loadRecentHistory(),
            );
          cancellation.signal.throwIfAborted();
          await measure("reader.prepare", () =>
            reader!.loadHistory(toTranscript(conversation!)),
          );
          cancellation.signal.throwIfAborted();
          ready = true;
          project();
          await measure("reader.first_frame", () => waitFrame(renderer));
          loading.end();
          if (!pickerMode) startup.end();
        })();
        const result = await Promise.race([
          preparing.then(() => ({ kind: "ready" as const })),
          exiting.then(() => ({ kind: "exit" as const })),
        ]);
        if (result.kind === "exit") {
          loading.end("cancel");
          exitedReader = true;
          break;
        }
        picker.notice = undefined;
        const ticker = setInterval(project, 200);
        try {
          await exiting;
          exitedReader = true;
          break;
        } finally {
          clearInterval(ticker);
        }
      } catch (error) {
        loading.end("error");
        if (!pickerMode)
          throw new Error(
            isNew
              ? `Cannot start a new session: ${error instanceof Error ? error.message : String(error)}`
              : `Cannot resume ${resumeId}: ${resumeAdmission(error)}`,
          );
        picker.notice = resumeAdmission(error);
      } finally {
        ready = false;
        cancellation.abort();
        reader?.dispose();
        await preparing?.catch(() => {});
        await connection.catch(() => {});
        loading.end("error");
        if (conversation) await conversation.close();
        else await server?.close();
      }
    }
  } catch (error) {
    startup.end("error");
    throw error;
  } finally {
    startup.end("cancel");
    if (!renderer.isDestroyed) renderer.destroy();
    if (exitedReader && lastSessionId) writeOutput(resumeHint(lastSessionId));
  }
}
if (import.meta.main) {
  const performance: Trace =
    process.env.ZENCODEX_TRACE === "0"
      ? noTrace
      : new PerformanceTrace(fileExporter(defaultTraceDirectory()));
  void main(undefined, undefined, performance)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => performance.close());
}
