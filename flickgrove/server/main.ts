import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { registeredProjects } from "./projects";
import { HostService } from "./hosts";
import { createHandler } from "./http";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    hub: { type: "boolean", default: false },
    listen: { type: "string", default: "127.0.0.1" },
    origin: { type: "string" },
    name: { type: "string" },
    port: { type: "string", default: "4318" },
    state: { type: "string" },
    codex: { type: "string", default: "codex" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Use a port between 1 and 65535");
const localOrigin = `http://127.0.0.1:${port}`;
const origin = values.origin ?? localOrigin;
if (
  !["http:", "https:"].includes(new URL(origin).protocol) ||
  new URL(origin).origin !== origin
)
  throw new Error("Use an HTTP(S) origin without a path");
const directory =
  values.state ?? join(homedir(), ".local", "share", "flickgrove");
const runtime = new CodexRuntime({
  cwd: process.cwd(),
  origin: () => localOrigin,
  codexPath: values.codex,
});
const app = new Workspace({
  directory,
  runtime,
  projects: registeredProjects,
});
const service = new HostService(app, {
  directory,
  hub: values.hub,
  name: values.name,
  origin: () => origin,
});
const server = Bun.serve({
  hostname: values.listen,
  port,
  idleTimeout: 0,
  maxRequestBodySize: 1024 * 1024,
  fetch: createHandler(app, {
    origin: () => origin,
    localOrigin: () => localOrigin,
    service,
    assets: fileURLToPath(new URL("../dist", import.meta.url)),
  }),
});
console.log(
  values.hub
    ? `FlickGrove Hub is available at ${origin}`
    : `FlickGrove execution service listens at ${origin}; private access credential: ${join(directory, "hosts.json")}`,
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await runtime.close();
  service.dispose();
  app.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
