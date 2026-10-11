import type { ServerWebSocket } from "bun";
import { socketWithHeaders } from "../server/socket-testing";

export function fakeVoiceProvider() {
  let mode = "success";
  const sockets = new Set<ServerWebSocket<{ taskId: string }>>();
  const stats = {
    authorization: [] as string[],
    runs: [] as any[],
    pcm: [] as number[][],
    events: [] as string[],
    frames: 0,
    bytes: 0,
    nonzero: false,
    finishes: 0,
    closed: 0,
  };
  const emit = (
    ws: ServerWebSocket<{ taskId: string }>,
    event: string,
    payload: unknown = {},
  ) =>
    ws.send(
      JSON.stringify({
        header: {
          event,
          task_id: mode === "wrong-task" ? "wrong" : ws.data.taskId,
        },
        payload,
      }),
    );
  function result(ws: ServerWebSocket<{ taskId: string }>) {
    if (mode === "failure") {
      emit(ws, "task-failed", {
        message: "synthetic-private-key MUST NOT leak",
      });
      return;
    }
    if (mode !== "empty") {
      const sentence = (id: number, text: string, end = true) =>
        emit(ws, "result-generated", {
          output: { sentence: { sentence_id: id, text, sentence_end: end } },
        });
      sentence(2, "世界");
      sentence(1, "你好");
      sentence(1, "你好");
      if (mode === "unfinished") sentence(3, "pending", false);
      if (mode === "large-text") sentence(3, "x".repeat(20_001));
    }
    emit(ws, "task-finished");
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      stats.authorization.push(req.headers.get("authorization") ?? "");
      return server.upgrade(req, { data: { taskId: "" } })
        ? undefined
        : new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      data: {} as { taskId: string },
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        if (typeof raw !== "string") {
          stats.pcm.push(Array.from(raw));
          stats.events.push("pcm");
          stats.frames++;
          stats.bytes += raw.byteLength;
          stats.nonzero ||= raw.some((value) => value !== 0);
          return;
        }
        const frame = JSON.parse(raw);
        if (frame.header.action === "run-task") {
          ws.data.taskId = frame.header.task_id;
          stats.runs.push(frame);
          if (mode === "hold-start") return;
          if (mode === "oversized") {
            ws.send("x".repeat(128 * 1024 + 1));
            return;
          }
          emit(ws, "task-started");
          if (mode === "empty-start") {
            emit(ws, "result-generated", {
              output: {
                sentence: { sentence_id: 3, sentence_end: false, text: "" },
              },
            });
            emit(ws, "result-generated", {
              output: {
                sentence: { sentence_id: 3, sentence_end: true, text: "  " },
              },
            });
          }
          // Intermediate text must never enter the browser's draft.
          emit(ws, "result-generated", {
            output: {
              sentence: {
                sentence_id: 1,
                sentence_end: false,
                text: "intermediate",
              },
            },
          });
        } else if (frame.header.action === "finish-task") {
          stats.events.push("finish");
          stats.finishes++;
          if (mode !== "hold-finish") result(ws);
        }
      },
      close(ws) {
        sockets.delete(ws);
        stats.closed++;
      },
    },
  });
  return {
    stats,
    get active() {
      return sockets.size;
    },
    connect: (key: string) =>
      socketWithHeaders(server.url.origin.replace(/^http/, "ws"), {
        Authorization: `Bearer ${key}`,
      }),
    mode(value: string) {
      mode = value;
    },
    ready() {
      for (const ws of sockets) {
        stats.events.push("ready");
        emit(ws, "task-started");
      }
    },
    release() {
      for (const ws of sockets) result(ws);
    },
    stop() {
      server.stop(true);
    },
  };
}
