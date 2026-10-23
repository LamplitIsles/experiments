import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputSpeedService } from "./tps";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { servePeer } from "./http";
import { FakeRuntime } from "./testing";
import { socketWithHeaders } from "./socket-testing";
import { openGrove } from "../src/chord-client";
import type { OutputSpeed } from "../src/contracts";
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(10);
  }
}
const selection = { model: "sol", tier: "fast" as const };
async function logs(root: string) {
  await mkdir(join(root, "sessions"), { recursive: true });
  const raw = await Bun.file(
    new URL(
      "../../codex-tps/fixtures/native-priority-paginated.jsonl",
      import.meta.url,
    ),
  ).text();
  const rows = raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const delta = Date.now() - Date.parse(rows.at(-1).timestamp) - 1000;
  for (const r of rows) {
    r.timestamp = new Date(Date.parse(r.timestamp) + delta).toISOString();
    if (r.type === "turn_context") r.payload.model = "sol";
    if (r.payload.type === "thread_settings_applied")
      r.payload.thread_settings.model = "sol";
  }
  const bytes = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(root, "sessions", "native.jsonl"), bytes);
  return bytes;
}
test("real HTTP/HostService/Chord runs only lazy background analysis, shares TTL and keeps numeric projections read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-tps-api-"));
  const home = join(root, "codex");
  const bytes = await logs(home);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: join(root, "state"),
    runtime,
    projects: async () => [{ alias: "alpha", name: "Alpha", path: root }],
    branches: { read: async () => null },
  });
  let origin = "";
  const service = new HostService(app, {
    directory: join(root, "state"),
    origin: () => origin,
    outputSpeed: { root: home },
  });
  const server = servePeer(app, {
    service,
    hostname: "127.0.0.1",
    port: 0,
    origin: () => origin,
  });
  origin = `http://127.0.0.1:${server.port}`;
  const client = await openGrove(
    socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
      Origin: origin,
    }),
    () => {},
    () => {},
  );
  try {
    const agent = await app.createOrc("alpha", {
      fast: true,
      orc: { model: "sol", effort: "medium" },
      worker: { model: "sol", effort: "medium" },
    });
    const id = qualify(service.identity.id, agent.id);
    expect(service.outputSpeed.diagnostics.starts).toBe(0);
    await client.call("weekly", {});
    await client.call("send", {
      id,
      text: "ordinary message",
      operationId: "once",
    });
    expect(service.outputSpeed.diagnostics.starts).toBe(0);
    const url = origin + `/api/read/tps?agent=${encodeURIComponent(id)}`;
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    expect(
      (
        await fetch(url, {
          headers: { ...headers, Origin: "http://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url + "&path=/arbitrary", { headers })).status).toBe(
      400,
    );
    expect(
      (await fetch(url, { headers: { ...headers, "X-Grove-Peer": "foreign" } }))
        .status,
    ).toBe(403);
    await expect(client.call("tps", { id, root: root })).rejects.toThrow();
    const first = (await (await fetch(url, { headers })).json()) as OutputSpeed;
    expect(first.status).toBe("loading");
    expect(service.outputSpeed.diagnostics.pid).not.toBe(process.pid);
    await Promise.all(
      Array.from({ length: 20 }, () => client.call("tps", { id })),
    );
    expect(service.outputSpeed.diagnostics.tasks).toBe(1);
    await until(() => service.tps(id).status === "ready");
    const result = await client.call<OutputSpeed>("tps", { id });
    expect(result.summary?.hour.tps).toBeCloseTo(63 / 1.695, 6);
    expect(result.summary?.week.samples).toBe(2);
    expect(Object.keys(result).sort()).toEqual([
      "model",
      "status",
      "summary",
      "tier",
    ]);
    expect(JSON.stringify(result)).not.toContain("owned_wait");
    expect(JSON.stringify(service.snapshot())).not.toContain("token_usage");
    expect(await readFile(join(home, "sessions", "native.jsonl"), "utf8")).toBe(
      bytes,
    );
    expect(runtime.inputs).toHaveLength(1);
    const taskCount = service.outputSpeed.diagnostics.tasks;
    await client.call("tps", { id });
    expect(service.outputSpeed.diagnostics.tasks).toBe(taskCount);
    service.tps(id, true);
    await until(() => service.tps(id).status === "ready");
    expect(service.outputSpeed.diagnostics.lastMetrics?.bytes).toBe(0);
    expect(service.outputSpeed.diagnostics.starts).toBe(1);
    await app.updateSettings(agent.id, { model: "luna", effort: "low" });
    const changed = await client.call<OutputSpeed>("tps", { id });
    expect(changed.model).toBe("luna");
    expect(changed.tier).toBe("standard");
    expect(changed.summary).toBeNull();
    expect(runtime.inputs).toHaveLength(1);
  } finally {
    client.close();
    service.dispose();
    await server.stop(true);
    app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked owned child coalesces, times out without replay, preserves last success and is killed at shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-tps-timeout-"));
  const script = join(root, "child.ts"),
    control = join(root, "fail");
  await writeFile(
    script,
    `import {createInterface} from 'node:readline'; for await(const line of createInterface({input:process.stdin})){if(await Bun.file(${JSON.stringify(control)}).exists()){while(true){} } else console.log(JSON.stringify({summary:{hour:{tps:12,samples:1},fourHours:{tps:12,samples:1},week:{tps:12,samples:1}}}));}`,
  );
  const settings = {
    command: [process.execPath, script],
    timeoutMs: 5000,
  };
  const service = new OutputSpeedService(settings);
  try {
    service.read(selection);
    await until(() => service.read(selection).status === "ready");
    await writeFile(control, "block");
    settings.timeoutMs = 350;
    service.read(selection, true);
    const pid = service.diagnostics.pid;
    expect(service.read({ ...selection, model: "other" }).summary).toBeNull();
    for (let i = 0; i < 20; i++) service.read(selection, true);
    expect(service.diagnostics.tasks).toBe(2);
    let beats = 0;
    const clock = setInterval(() => beats++, 10);
    await until(() => service.read(selection).status === "unavailable");
    clearInterval(clock);
    expect(beats).toBeGreaterThan(5);
    expect(service.read(selection).summary?.hour.tps).toBe(12);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(service.diagnostics.starts).toBe(1);
    service.read(selection, true);
    const nextPid = service.diagnostics.pid;
    service.dispose();
    await until(() => {
      try {
        process.kill(nextPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("first scan failure stays unknown and short TTL expires without replacing the owned scanner", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-tps-ttl-"));
  const missing = new OutputSpeedService({ root: join(root, "missing") });
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin}))console.log(JSON.stringify({summary:{hour:{tps:null,samples:0},fourHours:{tps:null,samples:0},week:{tps:null,samples:0}}}));`,
  );
  const cached = new OutputSpeedService({
    command: [process.execPath, script],
    ttlMs: 200,
  });
  try {
    expect(missing.read(selection).summary).toBeNull();
    await until(() => missing.read(selection).status === "unavailable");
    expect(missing.read(selection).summary).toBeNull();
    cached.read(selection);
    await until(() => cached.read(selection).status === "ready");
    const tasks = cached.diagnostics.tasks;
    await Bun.sleep(250);
    const expired = cached.read(selection);
    expect(expired.status).toBe("loading");
    expect(expired.summary?.hour).toEqual({ tps: null, samples: 0 });
    expect(cached.diagnostics.tasks).toBe(tasks + 1);
    expect(cached.diagnostics.starts).toBe(1);
  } finally {
    missing.dispose();
    cached.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
