// Real CodexRuntime wire adapter backed only by a test-owned JSON-RPC fake.
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexRuntime } from "../server/codex";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket } from "../server/chord-socket";
const directory = await mkdtemp(
  join(tmpdir(), "grove-spec3758-empty-browser-"),
);
const controlPath = join(directory, ".fake-app-server-control.json");
await writeFile(controlPath, JSON.stringify({ emptyItemsUnsupported: true }));
let origin = "";
const runtime = new CodexRuntime({
  cwd: directory,
  origin: () => origin,
  codexPath: resolve("tests/fake-codex.mjs"),
  env: {
    PATH: process.env.PATH,
    HOME: join(directory, "home"),
    CODEX_HOME: join(directory, "codex-home"),
    FAKE_SERVER_ROOT: directory,
  },
});
const app = new Workspace({
  directory: join(directory, "state"),
  runtime,
  projects: async () => [
    { alias: "fixture", name: "Fixture", path: directory },
  ],
  branches: { read: async () => null },
});
const service = new HostService(app, {
  directory: join(directory, "state"),
  name: "Empty fixture",
  origin: () => origin,
});
const options = {
  service,
  origin: () => origin,
  assets: resolve("../.scratch/flickgrove-browser/assets"),
};
const handler = createHandler(app, options),
  upgrade = createUpgrade(app, options);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: groveWebsocket,
  async fetch(request, server) {
    const up = upgrade(request, server);
    if (up) return up === true ? undefined : up;
    const url = new URL(request.url);
    if (url.pathname === "/fixture/control" && request.method === "POST") {
      await writeFile(controlPath, JSON.stringify(await request.json()));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/requests") {
      const text = await readFile(
        join(directory, ".fake-app-server-requests.jsonl"),
        "utf8",
      ).catch(() => "");
      return Response.json(
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const request = JSON.parse(line);
            return {
              method: request.method,
              threadId: request.params?.threadId,
            };
          }),
      );
    }
    return handler(request);
  },
});
origin = `http://127.0.0.1:${server.port}`;
console.log(origin);
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  server.stop(true);
  service.dispose();
  app.dispose();
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
  process.exit();
}
process.on("SIGTERM", () => void cleanup());
process.on("SIGINT", () => void cleanup());
