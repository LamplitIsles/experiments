import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { invoke } from "./chord-methods";

// Highest seam: installed strict generated client -> real Workspace/Peer ->
// test-owned JSON-RPC native process. No provider or live Codex directories.
test("native confirmed per-session settings serialize with start/steer, persist and reconcile; rejection/unknown never publish or replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-settings-"));
  const requestsPath = join(directory, ".fake-app-server-requests.jsonl");
  const control = (value: object) =>
    writeFile(
      join(directory, ".fake-app-server-control.json"),
      JSON.stringify(value),
    );
  const requests = async () =>
    (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://fixture.invalid",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
      FAKE_SERVER_PROCESS_LOG: join(directory, "processes"),
    },
  });
  const options = {
    directory: join(directory, "workspace"),
    runtime,
    projects: async () => [
      { alias: "fixture", name: "Fixture", path: directory },
    ],
    branches: { read: async () => null },
  };
  let app = new Workspace(options);
  let host = new HostService(app, {
    directory: join(directory, "peer"),
    origin: () => "http://fixture.invalid",
  });
  try {
    await control({ hold: true });
    const a = await app.createOrc("fixture");
    const b = await app.createOrc("fixture");
    const db = new Database(join(options.directory, "workspace.sqlite"));
    const state = JSON.parse(
      (
        db.query("SELECT value FROM workspace WHERE id=1").get() as {
          value: string;
        }
      ).value,
    );
    db.close();
    const token = state.agents.find((v: any) => v.id === a.id).token;
    const worker = (await app.tool(token, "worker_start", {
      project: "fixture",
      title: "Native Worker",
      spec: "fixture",
      message: "Work",
    })) as import("../src/contracts").Detail;
    const original = a.threadId!;
    await app.send(a.id, "first", "first");
    const turn = app.detail(a.id).turnId!;
    const target = `${host.identity.id}:${a.id}`;
    await expect(
      invoke(host, "updateSettings", { id: target, fast: true }),
    ).rejects.toThrow();
    await control({ hold: true, settingsDelay: 100 });
    const update = invoke(host, "updateTreeFast", { id: target, fast: true });
    await expect(app.send(a.id, "blocked", "blocked")).rejects.toThrow(
      "Tree settings",
    );
    expect(app.detail(a.id).serviceTier).toBe("default");
    expect(((await update) as import("../src/contracts").Detail).treeFast).toBe(
      true,
    );
    expect(
      (await requests()).find((r) => r.method === "thread/settings/update")
        .params,
    ).toEqual({ threadId: original, serviceTier: "priority" });
    await app.send(a.id, "steer", "steer");
    expect(app.detail(a.id).serviceTier).toBe("priority");
    expect(app.detail(worker.id).serviceTier).toBe("priority");
    const unchangedCount = (await requests()).filter(
      (r) => r.method === "thread/settings/update",
    ).length;
    await app.updateSettings(a.id, {
      model: "fixture-model",
      effort: "medium",
    });
    expect(
      (await requests()).filter((r) => r.method === "thread/settings/update"),
    ).toHaveLength(unchangedCount);
    expect(app.detail(a.id).turnId).toBe(turn);
    expect(app.detail(b.id).serviceTier).toBe("default");
    expect(app.detail(a.id).threadId).toBe(original);
    const nativeSteer = (await requests()).find(
      (r) => r.method === "turn/steer",
    );
    expect(nativeSteer.params).toEqual({
      threadId: original,
      expectedTurnId: turn,
      input: [{ type: "text", text: "steer", text_elements: [] }],
    });
    await expect(
      invoke(host, "updateSettings", {
        id: "other:" + a.id,
        model: "fixture-model",
        effort: "medium",
      }),
    ).rejects.toThrow("another Peer");
    await expect(
      app.updateSettings(a.id, {
        model: "no-model",
        effort: "medium",
      }),
    ).rejects.toThrow("supported");
    await expect(
      app.updateSettings(a.id, {
        model: "fixture-model",
        effort: "low",
      }),
    ).rejects.toThrow("supported");
    await control({ hold: true, failSettings: true });
    const rejected = await app.updateTreeFast(a.id, false);
    expect(rejected.treeFastError).toContain("fixture settings rejected");
    expect(app.detail(a.id).serviceTier).toBe("priority");
    await control({ hold: true, dropSettingsNotification: true });
    const unknown = await app.updateTreeFast(a.id, false, true);
    expect(unknown.treeFastError).toContain("outcome unknown");
    expect(app.detail(a.id).serviceTier).toBe("priority");
    const count = (await requests()).filter(
      (r) => r.method === "thread/settings/update",
    ).length;
    await app.updateTreeFast(a.id, false, true);
    expect(app.detail(a.id).serviceTier).toBe("default");
    expect(
      (await requests()).filter((r) => r.method === "thread/settings/update"),
    ).toHaveLength(count);
    await control({});
    await app.stop(a.id, turn);
    await Bun.sleep(50);
    await app.updateTreeFast(a.id, true);
    await app.send(a.id, "next", "next");
    const starts = (await requests()).filter(
      (r) => r.method === "turn/start" && r.params.threadId === original,
    );
    expect(starts).toHaveLength(2);
    expect(starts[1].params.model).toBeUndefined(); // native thread config is authoritative
    app.dispose();
    await runtime.close();
    app = new Workspace(options);
    host = new HostService(app, {
      directory: join(directory, "peer"),
      origin: () => "http://fixture.invalid",
    });
    // Existing runtime handles were released, matching a backend restart.
    await app.reconcileSettings(a.id);
    expect(app.detail(a.id).serviceTier).toBe("priority");
    expect(app.detail(a.id).threadId).toBe(original);
    const resumes = (await requests()).filter(
      (r) => r.method === "thread/resume",
    );
    for (const r of resumes) {
      expect(r.params.model).toBeUndefined();
      expect(r.params.serviceTier).toBeUndefined();
      expect(r.params.config?.model_reasoning_effort).toBeUndefined();
    }
    expect(
      (await requests()).filter(
        (r) => r.method === "thread/start" && !r.params.ephemeral,
      ),
    ).toHaveLength(3);
    expect(
      app.detail(a.id).messages.filter((m) => m.role === "user"),
    ).toHaveLength(3);
  } finally {
    app.dispose();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

import { FakeRuntime, fixtureProjects } from "./testing";
test("Worker and Orc settings leave captured Worker defaults and other sessions intact; queued close and late disposal refuse cache writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-settings-owner-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const orc = await app.createOrc("alpha");
    const other = await app.createOrc("beta");
    const token = runtime.agents.get(orc.id)!.token;
    await app.updateSettings(orc.id, {
      model: "luna",
      effort: "low",
    });
    await app.tool(token, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "fixture",
      message: "Work",
    });
    const worker = app.snapshot().agents.find((a) => a.ownerId === orc.id)!;
    expect(worker.model).toBe("sol");
    expect(worker.effort).toBe("medium");
    await app.updateSettings(worker.id, {
      model: "sol",
      effort: "high",
    });
    expect(app.detail(orc.id).model).toBe("luna");
    expect(app.detail(other.id)).toMatchObject({
      ...other,
      messages: [],
      deliveries: [],
    });
    await app.updateTreeFast(worker.id, true);
    await app.updateSettings(worker.id, { model: "luna", effort: "low" });
    expect(app.detail(worker.id).serviceTier).toBe("default");
    expect(app.detail(orc.id).treeFast).toBe(true);
    await app.tool(token, "worker_close", { workerId: worker.id });
    await expect(
      app.updateSettings(worker.id, {
        model: "sol",
        effort: "medium",
      }),
    ).rejects.toThrow();
    const gate = Promise.withResolvers<void>();
    runtime.settingsOverride = async () => gate.promise;
    const saving = app.updateSettings(orc.id, {
      model: "sol",
      effort: "high",
    });
    await Bun.sleep(10);
    app.dispose();
    gate.resolve();
    await expect(saving).rejects.toThrow("Session changed");
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tree Fast from Worker preserves models/efforts, isolates roots, covers future Workers and confirms partial retry without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-tree-fast-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const orc = await app.createOrc("alpha");
    const other = await app.createOrc("beta");
    const token = runtime.agents.get(orc.id)!.token;
    const start = () =>
      app.tool(token, "worker_start", {
        project: "alpha",
        title: "Worker",
        spec: "fixture",
        message: "Work",
      }) as Promise<import("../src/contracts").Detail>;
    const w = await start();
    const unsupported = await start();
    await app.updateSettings(unsupported.id, { model: "luna", effort: "low" });
    const calls: string[] = [];
    let unknown = true;
    runtime.settingsOverride = async (id, value) => {
      calls.push(id);
      if (id === w.id && unknown) {
        runtime.settings.set(w.threadId!, value); // Native applied but confirmation was lost.
        throw new Error("outcome unknown");
      }
    };
    const result = await app.updateTreeFast(w.id, true);
    expect(result.treeFastError).toContain("outcome unknown");
    expect(app.detail(orc.id).serviceTier).toBe("priority");
    expect(app.detail(w.id).serviceTier).toBe("default");
    expect(app.detail(unsupported.id)).toMatchObject({
      model: "luna",
      effort: "low",
      serviceTier: "default",
      treeFast: true,
    });
    expect(app.detail(other.id)).toMatchObject({
      serviceTier: "default",
      treeFast: false,
    });
    await expect(app.updateTreeFast(w.id, false)).rejects.toThrow("Retry");
    unknown = false;
    const before = calls.length;
    await app.updateTreeFast(w.id, true, true);
    expect(calls).toHaveLength(before); // Readback discovers native confirmation; no blind replay.
    expect(app.detail(w.id).serviceTier).toBe("priority");
    expect(app.detail(orc.id).treeFastError).toBeUndefined();
    const future = await start();
    expect(future).toMatchObject({
      model: "sol",
      effort: "medium",
      serviceTier: "priority",
    });
    const closing = await start();
    await app.tool(token, "worker_close", { workerId: closing.id });
    const readsBefore = runtime.settingsReads.length;
    const gate = Promise.withResolvers<void>();
    runtime.settingsOverride = async () => gate.promise;
    const pending = app.updateTreeFast(future.id, false);
    await Bun.sleep(10);
    await expect(app.updateTreeFast(orc.id, false)).rejects.toThrow(
      "being saved",
    );
    await expect(
      app.updateSettings(w.id, { model: "sol", effort: "high" }),
    ).rejects.toThrow("being saved");
    await expect(app.send(orc.id, "blocked", "blocked")).rejects.toThrow(
      "being saved",
    );
    await expect(app.closeTree(orc.id)).rejects.toThrow("being saved");
    await expect(start()).rejects.toThrow("being saved");
    await expect(
      app.tool(token, "worker_close", { workerId: w.id }),
    ).rejects.toThrow("being saved");
    gate.resolve();
    await pending;
    expect(
      app
        .snapshot()
        .agents.filter(
          (a) => (a.id === orc.id || a.ownerId === orc.id) && !a.closeRequest,
        )
        .every((a) => a.serviceTier === "default"),
    ).toBe(true);
    expect(app.detail(other.id).treeFast).toBe(false);
    expect(runtime.settingsReads.slice(readsBefore)).not.toContain(closing.id);
    expect(app.detail(closing.id)).toMatchObject({
      serviceTier: "priority",
      closeRequest: expect.anything(),
    });
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("changing the initial Fast owner's model to unsupported retains tree policy and future Worker Fast", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-initial-tree-policy-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  try {
    const orc = await app.createOrc("alpha", {
      fast: true,
      orc: { model: "sol", effort: "medium" },
      worker: { model: "sol", effort: "high" },
    });
    const token = runtime.agents.get(orc.id)!.token;
    await app.updateSettings(orc.id, { model: "luna", effort: "low" });
    expect(app.detail(orc.id)).toMatchObject({
      model: "luna",
      effort: "low",
      serviceTier: "default",
      treeFast: true,
    });
    const future = (await app.tool(token, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "fixture",
      message: "Work",
    })) as import("../src/contracts").Detail;
    expect(future).toMatchObject({
      model: "sol",
      effort: "high",
      serviceTier: "priority",
      treeFast: true,
    });
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
