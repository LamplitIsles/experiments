import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket } from "./chord-socket";
import { socketWithHeaders } from "./socket-testing";
import { openGrove } from "../src/chord-client";
import type { View } from "../src/chord-contract";

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Feedback did not settle");
    await Bun.sleep(10);
  }
}

test("isolated native notifications through Workspace and real Chord preserve retry evidence and turn/thread isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-feedback-"));
  let origin = "";
  const control = join(directory, ".fake-app-server-control.json");
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => origin,
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
    },
  });
  const app = new Workspace({
    directory: join(directory, "workspace"),
    runtime,
    projects: async () => [
      { alias: "fixture", name: "Fixture", path: directory },
    ],
  });
  const service = new HostService(app, {
    directory: join(directory, "host"),
    origin: () => origin,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch(req, server) {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, server);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  let client: Awaited<ReturnType<typeof openGrove>> | undefined;
  let view: View | undefined;
  let serial = 0;
  const notifications: unknown[] = [];
  const inject = async (method: string, params: Record<string, unknown>) => {
    notifications.push({ id: ++serial, method, params });
    await writeFile(control, JSON.stringify({ hold: true, notifications }));
  };
  try {
    await writeFile(control, JSON.stringify({ hold: true }));
    // Keep the selected thread separate from the fixture's first-thread async question injection.
    const b = await app.createOrc("fixture"),
      a = await app.createOrc("fixture");
    const id = qualify(service.identity.id, a.id);
    client = await openGrove(
      socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
        Origin: origin,
      }),
      (next) => {
        view = next;
      },
      () => {},
    );
    await client.call("select", { ids: [id] });
    await client.call("send", { id, text: "begin", operationId: "first" });
    await app.send(b.id, "other agent", "other");
    const detail = () => view?.details[id];
    const current = app.detail(a.id),
      turnId = current.turnId!,
      threadId = current.threadId!;
    const since = current.workingSince;
    const error = {
      message: "Selected model is at capacity",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: "Full native cause",
    };
    await inject("error", { threadId, turnId, willRetry: true, error });
    await until(() => detail()?.execution?.retrying === true);
    expect(detail()?.state).toBe("working");
    expect(detail()?.workingSince).toBe(since);
    expect(detail()?.error).toContain("Full native cause");
    expect(app.detail(b.id).error).toBeUndefined();
    await inject("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    });
    await inject("item/started", {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: { type: "userMessage", id: "steered-user", content: [] },
    });
    await Bun.sleep(40);
    expect(app.detail(a.id).execution?.retrying).toBe(true);
    await client.call("send", {
      id,
      text: "steer while retrying",
      operationId: "steer",
    });
    expect(app.detail(a.id).execution?.retrying).toBe(true);
    await inject("error", {
      threadId,
      turnId: "old-turn",
      willRetry: false,
      error,
    });
    await inject("item/agentMessage/delta", {
      threadId: app.detail(b.id).threadId,
      turnId,
      itemId: "other",
      delta: "other thread",
    });
    await inject("item/agentMessage/delta", {
      threadId,
      turnId: "old-turn",
      itemId: "old",
      delta: "late",
    });
    await Bun.sleep(60);
    expect(app.detail(a.id).execution?.retrying).toBe(true);
    await inject("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "current",
      delta: "recovered",
    });
    await until(() => detail()?.error === undefined);
    expect(detail()?.workingSince).toBe(since);
    await inject("error", { threadId, turnId, willRetry: true, error });
    await until(() => detail()?.execution?.retrying === true);
    await inject("item/started", {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: "reasoning",
        id: "native-reasoning",
        summary: [],
        content: [],
      },
    });
    await until(() => detail()?.error === undefined);
    expect(detail()?.workingSince).toBe(since);
    for (const phase of ["final_answer", "commentary"]) {
      await inject("error", { threadId, turnId, willRetry: true, error });
      await until(() => detail()?.execution?.retrying === true);
      // Completion itself is progress; no delta or item start precedes it.
      await inject("item/completed", {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: `recovered-${phase}`,
          text: `Recovered ${phase}`,
          phase,
          delivery: null,
          questions: null,
          memoryCitation: null,
        },
      });
      await until(() => app.detail(a.id).execution === undefined);
      await until(() => detail()?.execution === undefined);
      expect(detail()?.error).toBeUndefined();
      expect(detail()?.workingSince).toBe(since);
      expect(
        detail()?.messages.some((m) => m.id === `recovered-${phase}`),
      ).toBe(false);
    }
    await inject("error", { threadId, turnId, willRetry: false, error });
    await until(() => detail()?.state === "error");
    expect(detail()?.execution).toEqual({ kind: "capacity", retrying: false });
    expect(detail()?.workingSince).toBeUndefined();
    // Terminal failures are not revived by late retry/progress.
    await inject("error", { threadId, turnId, willRetry: true, error });
    await Bun.sleep(40);
    expect(app.detail(a.id).execution?.retrying).toBe(false);
    await inject("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "late",
      delta: "late",
    });
    await inject("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", items: [], error },
    });
    await until(() => app.detail(a.id).turnId === undefined);
    expect(app.detail(a.id).error).toContain("capacity");
    expect(
      app.detail(a.id).messages.some((m) => m.id === "recovered-final_answer"),
    ).toBe(true);
    expect(
      app.detail(a.id).messages.some((m) => m.id === "recovered-commentary"),
    ).toBe(false);
    // A distinct native turn start resets the old failure; old turn events cannot change it.
    await inject("turn/started", {
      threadId,
      turn: { id: "new-turn", status: "inProgress", items: [], error: null },
    });
    await until(() => detail()?.turnId === "new-turn");
    await inject("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    });
    await inject("error", { threadId, turnId, willRetry: true, error });
    await inject("error", {
      threadId,
      turnId: "new-turn",
      willRetry: false,
      error: {
        message: "Selected model is at capacity — opaque unknown failure",
        codexErrorInfo: "other",
        additionalDetails: null,
      },
    });
    await until(
      () =>
        detail()?.error ===
        "Selected model is at capacity — opaque unknown failure",
    );
    expect(detail()?.execution).toEqual({ kind: "error", retrying: false });
    await inject("turn/completed", {
      threadId,
      turn: { id: "new-turn", status: "completed", items: [], error: null },
    });
    await until(() => detail()?.state === "idle");
    expect(detail()?.error).toBeUndefined();
    expect(detail()?.execution).toBeUndefined();
    await inject("turn/started", {
      threadId,
      turn: {
        id: "fallback-turn",
        status: "inProgress",
        items: [],
        error: null,
      },
    });
    await until(() => detail()?.turnId === "fallback-turn");
    await inject("turn/completed", {
      threadId,
      turn: {
        id: "fallback-turn",
        status: "failed",
        items: [],
        error: { ...error, codexErrorInfo: null },
      },
    });
    await until(() => detail()?.state === "error");
    expect(detail()?.execution).toEqual({ kind: "capacity", retrying: false });
    expect(detail()?.workingSince).toBeUndefined();
  } finally {
    client?.close();
    service.dispose();
    server.stop(true);
    app.dispose();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
