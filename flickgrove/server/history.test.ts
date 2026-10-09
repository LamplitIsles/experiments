import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import type { HistorySession } from "../src/contracts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-history-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, runtime, directory };
}
function session(
  runtime: FakeRuntime,
  overrides: Partial<HistorySession> = {},
) {
  const value: HistorySession = {
    threadId: "cli-history",
    title: "Fix the reader",
    preview: "Investigate slow scrolling",
    cwd: fixtureProjects[0].path,
    source: "cli",
    archived: false,
    role: "session",
    updatedAt: 1000,
    model: "luna",
    effort: "low",
    ...overrides,
  };
  runtime.historySessions.set(value.threadId, value);
  runtime.names.set(value.threadId, value.title);
  runtime.historyItems.set(value.threadId, [
    { id: "old-user", role: "user", text: value.preview, at: 1 },
    { id: "old-answer", role: "assistant", text: "Reader repaired.", at: 2 },
  ]);
  return value;
}
test("history searches title and first message within the selected project, including archived sessions", async () => {
  const { app, runtime } = fixture();
  session(runtime);
  session(runtime, { threadId: "archived", archived: true });
  session(runtime, { threadId: "other-project", cwd: fixtureProjects[1].path });
  expect(
    (await app.history("alpha", "scrolling")).sessions.map((s) => s.threadId),
  ).toEqual(["archived", "cli-history"]);
  expect((await app.history("alpha", "reader")).sessions).toHaveLength(2);
  expect((await app.history("alpha", "missing")).sessions).toHaveLength(0);
  await expect(app.historyMessages("beta", "cli-history")).rejects.toThrow(
    "does not belong",
  );
  expect(runtime.inputs).toHaveLength(0);
  expect(app.snapshot().agents).toHaveLength(0);
});
test("CLI resume is idempotent, retains the original thread and settings, and does not copy historical messages", async () => {
  const { app, runtime, directory } = fixture();
  session(runtime);
  const [a, b] = await Promise.all([
    app.resumeHistory("alpha", "cli-history", false),
    app.resumeHistory("alpha", "cli-history", false),
  ]);
  expect(a.id).toBe(b.id);
  expect(app.snapshot().agents).toHaveLength(1);
  expect(a).toMatchObject({
    role: "orc",
    threadId: "cli-history",
    model: "luna",
    effort: "low",
    serviceTier: "default",
    closed: false,
    title: "Fix the reader",
  });
  expect(app.detail(a.id).messages).toEqual([]);
  expect((await app.agentHistory(a.id)).messages.map((m) => m.id)).toEqual([
    "old-user",
    "old-answer",
  ]);
  expect(runtime.inputs).toHaveLength(0);
  const db = new Database(join(directory, "workspace.sqlite"), {
    readonly: true,
  });
  try {
    const value = (
      db.query("SELECT value FROM workspace").get() as { value: string }
    ).value;
    expect(value).not.toContain("Reader repaired.");
    expect(value).not.toContain("inheritSettings");
    expect(value).not.toContain("restoreArchived");
  } finally {
    db.close();
  }
});
test("a locked thread cannot appear resumed, and explicit retry acquires the same thread without duplicates", async () => {
  const { app, runtime } = fixture();
  session(runtime);
  runtime.lockedThreads.add("cli-history");
  await expect(
    app.resumeHistory("alpha", "cli-history", false),
  ).rejects.toThrow("another Codex instance");
  expect(app.snapshot().agents).toHaveLength(0);
  runtime.lockedThreads.delete("cli-history");
  const a = await app.resumeHistory("alpha", "cli-history", false);
  expect(a.threadId).toBe("cli-history");
  expect(app.snapshot().agents).toHaveLength(1);
  expect(runtime.inputs).toHaveLength(0);
});
test("closed Orc resumes its identity and leaves closed Workers closed; Worker and native subagent cannot become Orc", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "beta",
    title: "Review reader",
    spec: "Read-only",
    message: "Review",
  })) as { id: string };
  const w = app.detail(worker.id);
  runtime.emit(w.id, {
    type: "completed",
    turnId: w.turnId!,
    status: "completed",
  });
  await app.tool(token, "worker_close", { workerId: w.id });
  await app.closeTree(orc.id);
  const result = await app.resumeHistory("alpha", orc.threadId!, false);
  expect(result.id).toBe(orc.id);
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([orc.id]);
  const found = (await app.history("beta", "")).sessions.find(
    (s) => s.threadId === w.threadId,
  )!;
  expect(found).toMatchObject({
    role: "worker",
    closed: true,
    ownerThreadId: orc.threadId,
    ownerProject: "alpha",
  });
  await expect(app.resumeHistory("beta", w.threadId!, false)).rejects.toThrow(
    "original Orc",
  );
  session(runtime, {
    threadId: "native-worker",
    role: "worker",
    source: "subAgent",
    ownerThreadId: "native-parent",
  });
  await expect(
    app.resumeHistory("alpha", "native-worker", false),
  ).rejects.toThrow("original Orc");
});

test("restore waits for concurrent closure and acquires a fresh writer", async () => {
  const { app, runtime } = fixture();
  const open = runtime.open.bind(runtime);
  const closing = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let opens = 0;
  runtime.open = async (...args) => {
    opens++;
    const handle = await open(...args);
    return {
      ...handle,
      close: async () => {
        closing.resolve();
        await release.promise;
        await handle.close();
      },
    };
  };
  const orc = await app.createOrc("alpha");
  const close = app.closeTree(orc.id);
  await closing.promise;
  let restored = false;
  const resume = app
    .resumeHistory("alpha", orc.threadId!, false)
    .then((result) => {
      restored = true;
      return result;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restored).toBe(false);
    release.resolve();
    await close;
    expect((await resume).id).toBe(orc.id);
    expect(opens).toBe(2);
    expect(runtime.listeners.has(orc.id)).toBe(true);
    expect(app.snapshot().agents).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.allSettled([close, resume]);
  }
});

test("existing Orc history overlays captured turns across pages and retains external turns without copying", async () => {
  const { app, runtime, directory } = fixture();
  const orc = await app.createOrc("alpha");
  await app.send(orc.id, "Captured in Grove", "grove-request");
  const capturedTurn = app.detail(orc.id).turnId!;
  await app.send(orc.id, "Second input in the same turn", "grove-steer");
  expect(app.detail(orc.id).turnId).toBe(capturedTurn);
  runtime.emit(orc.id, {
    type: "item",
    turnId: capturedTurn,
    item: {
      id: "native-answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "Captured answer",
    },
  });
  runtime.emit(orc.id, {
    type: "completed",
    turnId: capturedTurn,
    status: "completed",
  });
  await app.closeTree(orc.id);
  runtime.historyItems.set(orc.threadId!, [
    {
      id: "native-user",
      turnId: capturedTurn,
      role: "user",
      text: "Captured in Grove",
      at: 1,
    },
    {
      id: "native-steer",
      turnId: capturedTurn,
      role: "user",
      text: "Second input in the same turn",
      at: 1,
    },
    {
      id: "native-answer",
      turnId: capturedTurn,
      role: "assistant",
      text: "Captured answer",
      at: 2,
    },
    ...Array.from({ length: 29 }, (_, i) => ({
      id: `external-${i}`,
      turnId: `external-turn-${i}`,
      role: "assistant" as const,
      text: `CLI continuation ${i}`,
      at: 3 + i,
    })),
  ]);
  const resumed = await app.resumeHistory("alpha", orc.threadId!, false);
  expect(resumed.historyCursor).toBe("32");
  expect(resumed.historyBoundaryId).toBe("native-answer");
  const latest = await app.agentHistory(orc.id);
  const earlier = await app.agentHistory(orc.id, latest.nextCursor!);
  // The captured turn spans both pages; every page substitutes the stable Grove IDs.
  expect(latest.messages[0].id).toBe("grove-request");
  expect(earlier.messages.map((m) => m.id)).toEqual([
    "grove-request",
    "grove-steer",
    "native-answer",
  ]);
  const merged = [
    ...new Map(
      [...earlier.messages, ...latest.messages].map((m) => [m.id, m]),
    ).values(),
  ];
  expect(merged.filter((m) => m.text === "Captured in Grove")).toHaveLength(1);
  expect(merged.filter((m) => m.id === "grove-steer")).toHaveLength(1);
  expect(merged.map((m) => m.text).slice(-1)).toEqual(["CLI continuation 28"]);
  expect(app.detail(orc.id).messages).toHaveLength(3);
  await app.send(orc.id, "New input after restoration", "after-restore");
  expect(app.detail(orc.id).historyBoundaryId).toBe("native-answer");
  expect(
    (await app.agentHistory(orc.id)).messages.some(
      (m) => m.id === "after-restore",
    ),
  ).toBe(false);
  const db = new Database(join(directory, "workspace.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      (db.query("SELECT value FROM workspace").get() as { value: string })
        .value,
    ).not.toContain("CLI continuation");
  } finally {
    db.close();
  }
});

test("a failed native release preserves the active writer until Close is retried", async () => {
  const { app, runtime } = fixture();
  const open = runtime.open.bind(runtime);
  let fail = true,
    opens = 0;
  runtime.open = async (...args) => {
    opens++;
    const handle = await open(...args);
    return {
      ...handle,
      close: async () => {
        if (fail) throw new Error("Writer shutdown unconfirmed");
        await handle.close();
      },
    };
  };
  const orc = await app.createOrc("alpha");
  await expect(app.closeTree(orc.id)).rejects.toThrow("shutdown unconfirmed");
  expect((await app.resumeHistory("alpha", orc.threadId!, false)).id).toBe(
    orc.id,
  );
  expect(opens).toBe(1);
  expect(app.snapshot().agents).toHaveLength(1);
  expect(runtime.listeners.has(orc.id)).toBe(true);
  fail = false;
  await app.closeTree(orc.id);
  expect(app.snapshot().agents).toHaveLength(0);
  expect((await app.resumeHistory("alpha", orc.threadId!, false)).id).toBe(
    orc.id,
  );
  expect(opens).toBe(2);
  expect(runtime.inputs).toHaveLength(0);
});

test("directory aliases can search, preview and resume, but a different directory is rejected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-directory-"));
  const projectPath = join(directory, "Project");
  const aliasPath = join(directory, "project-link");
  const otherPath = join(directory, "OtherProject");
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  symlinkSync(projectPath, aliasPath);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => [
      { alias: "alpha", name: "Alpha", path: projectPath },
    ],
  });
  cleanup.push(() => {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  session(runtime, { cwd: aliasPath });
  session(runtime, { threadId: "other", cwd: otherPath });
  runtime.history = async () => ({
    sessions: [...runtime.historySessions.values()],
    nextCursor: null,
  });
  expect(
    (await app.history("alpha", "")).sessions.map((s) => s.threadId),
  ).toEqual(["cli-history"]);
  expect(
    (await app.historyMessages("alpha", "cli-history")).messages,
  ).toHaveLength(2);
  const agent = await app.resumeHistory("alpha", "cli-history", false);
  expect(agent.threadId).toBe("cli-history");
  await expect(app.historyMessages("alpha", "other")).rejects.toThrow(
    "does not belong",
  );
  await expect(app.resumeHistory("alpha", "other", false)).rejects.toThrow(
    "does not belong",
  );
});
