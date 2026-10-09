import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  initializeReviewerConfig,
  reviewerSnapshot,
  orcPrompt,
} from "./reviewer-config";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { registeredProjects } from "./projects";
import { HostService } from "./hosts";
import { servePeer } from "./http";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    listen: { type: "string", default: "127.0.0.1" },
    origin: { type: "string" },
    name: { type: "string" },
    port: { type: "string", default: "4318" },
    config: { type: "string" },
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
const configPath =
  values.config ?? join(homedir(), ".config", "flickgrove", "config.toml");
await initializeReviewerConfig(configPath);
const runtime = new CodexRuntime({
  cwd: process.cwd(),
  origin: () => localOrigin,
  codexPath: values.codex,
});
const app = new Workspace({
  directory,
  runtime,
  projects: registeredProjects,
  orcPrompt: () => orcPrompt(configPath),
  reviewerSnapshot: (profile) => reviewerSnapshot(configPath, profile),
});
const service = new HostService(app, {
  directory,
  name: values.name,
  origin: () => origin,
});
const httpOptions = {
  origin: () => origin,
  localOrigin: () => localOrigin,
  service,
  assets: fileURLToPath(new URL("../dist", import.meta.url)),
};
const server = servePeer(app, {
  ...httpOptions,
  hostname: values.listen!,
  port,
});
console.log(
  `FlickGrove Peer is available at ${origin}; private access credential: ${join(directory, "hosts.json")}`,
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
