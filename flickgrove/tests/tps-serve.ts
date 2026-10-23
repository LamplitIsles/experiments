import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { FakeRuntime } from "../server/testing";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket, type SocketData } from "../server/chord-socket";

const root = await mkdtemp(join(tmpdir(), "grove-tps-browser-"));
const logs = join(root, "codex");
process.env.HOME = join(root, "home");
process.env.CODEX_HOME = logs;
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
for (const path of [
  process.env.HOME,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_CACHE_HOME,
])
  await mkdir(path, { recursive: true });
await mkdir(join(logs, "sessions"), { recursive: true });
const fixture = (
  await Bun.file(
    new URL(
      "../../codex-tps/fixtures/native-priority-paginated.jsonl",
      import.meta.url,
    ),
  ).text()
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
for (const speed of ["priority", "default"]) {
  const rows = structuredClone(fixture),
    shift = Date.now() - Date.parse(rows.at(-1).timestamp) - 1000;
  for (const r of rows) {
    r.timestamp = new Date(Date.parse(r.timestamp) + shift).toISOString();
    const p = r.payload;
    if (r.type === "turn_context") p.model = "sol";
    if (p.type === "thread_settings_applied") {
      p.thread_settings.model = "sol";
      p.thread_settings.service_tier = speed;
    }
    if (speed === "default") {
      for (const field of ["thread_id", "session_id", "id"])
        if (typeof p[field] === "string") p[field] += "-standard";
      if (r.type === "token_usage_record") {
        p.response_id += "-standard";
        p.usage.output_tokens *= 2;
        p.thread_token_usage.output_tokens *= 2;
      }
      if (p.type === "token_count") {
        p.info.total_token_usage.output_tokens *= 2;
        p.info.last_token_usage.output_tokens *= 2;
      }
    }
  }
  await writeFile(
    join(logs, "sessions", `${speed}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}
const runtime = new FakeRuntime();
let heldReads = 0;
let quotaFailure = false,
  remaining = 72,
  delay = 0,
  logFailure = false;
runtime.weekly = async () => {
  if (quotaFailure) throw new Error("Owned quota failure");
  return { remaining, fetchedAt: Date.now() };
};
const app = new Workspace({
  directory: join(root, "state"),
  runtime,
  projects: async () => [{ alias: "alpha", name: "Owned", path: root }],
  branches: { read: async () => null },
});
const origin = "http://127.0.0.1:14328";
const service = new HostService(app, {
  directory: join(root, "state"),
  origin: () => origin,
  outputSpeed: { root: logs, timeoutMs: 2000 },
});
const original = service.tps.bind(service);
service.tps = ((id: string, refresh?: boolean) => {
  const result = original(id, refresh);
  if (delay) heldReads++;
  return delay
    ? new Promise((resolve) => setTimeout(() => resolve(result), delay))
    : result;
}) as typeof service.tps;
const agents: string[] = [];
for (const [title, model, fast] of [
  ["Fast fixture", "sol", true],
  ["Standard fixture", "sol", false],
  ["Empty fixture", "luna", false],
] as const) {
  const a = await app.createOrc("alpha", {
    fast,
    orc: { model, effort: model === "luna" ? "low" : "medium" },
    worker: { model: "sol", effort: "medium" },
  });
  await app.rename(a.id, title);
  agents.push(a.id);
}
const options = {
  service,
  origin: () => origin,
  assets: resolve("../.scratch/codex-tps-workspace/assets"),
};
const handler = createHandler(app, options),
  upgrade = createUpgrade(app, options);
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: 14328,
  websocket: groveWebsocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/fixture/info")
      return Response.json({
        agents,
        heldReads,
        inputs: runtime.inputs,
        interruptions: runtime.interruptions,
        diagnostics: service.outputSpeed.diagnostics,
      });
    if (url.pathname === "/fixture/control" && req.method === "POST") {
      const p = await req.json();
      if ("quotaFailure" in p) quotaFailure = p.quotaFailure;
      if ("remaining" in p) remaining = p.remaining;
      if ("delay" in p) delay = p.delay;
      if ("logFailure" in p && logFailure !== p.logFailure) {
        await rename(
          logFailure ? logs + "-missing" : logs,
          logFailure ? logs : logs + "-missing",
        );
        logFailure = p.logFailure;
      }
      if (p.block) {
        original(`${service.identity.id}:${agents[0]}`, true);
        const pid = service.outputSpeed.diagnostics.pid;
        if (pid) process.kill(pid, "SIGSTOP");
      }
      return Response.json({ ok: true });
    }
    const result = upgrade(req, server);
    return result === true ? undefined : (result ?? handler(req));
  },
});
console.log(origin);
async function close() {
  service.dispose();
  await server.stop(true);
  app.dispose();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
