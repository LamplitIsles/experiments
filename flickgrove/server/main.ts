import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { registeredProjects } from "./projects";
import { createHandler } from "./http";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "4318" },
    state: { type: "string" },
    codex: { type: "string", default: "codex" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Use a port between 1 and 65535");
const origin = `http://127.0.0.1:${port}`;
const runtime = new CodexRuntime({
  cwd: process.cwd(),
  origin: () => origin,
  codexPath: values.codex,
});
const app = new Workspace({
  directory: values.state ?? join(homedir(), ".local", "share", "flickgrove"),
  runtime,
  projects: registeredProjects,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  maxRequestBodySize: 1024 * 1024,
  fetch: createHandler(app, {
    origin: () => origin,
    assets: fileURLToPath(new URL("../dist", import.meta.url)),
  }),
});
console.log(`FlickGrove is available at ${origin}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await runtime.close();
  app.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
