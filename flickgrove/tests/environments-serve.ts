import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "grove-environment-browser-"));
for (const key of Object.keys(process.env))
  if (key !== "PATH") delete process.env[key];
process.env.HOME = root;
process.env.CODEX_HOME = join(root, "codex");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
const [
  { Workspace },
  { FakeRuntime },
  { HostService },
  { createHandler, createUpgrade },
  { groveWebsocket },
  { ProjectEnvironments },
] = await Promise.all([
  import("../server/workspace"),
  import("../server/testing"),
  import("../server/hosts"),
  import("../server/http"),
  import("../server/chord-socket"),
  import("../server/project-environments"),
]);
const cwd = join(root, "checkout");
await mkdir(cwd);
const local = { id: "local", name: "This machine", target: "local" };
const mac = {
  id: "mac",
  name: "Mac studio · a long device name for layout verification",
  target: "owned-mac",
};
let faulted = false;
const savedDevices = ["lost", "removed", "moved"].map((id) => ({
  id,
  name: `Saved ${id} Mac`,
  target: `original-${id}`,
}));
class Environments extends ProjectEnvironments {
  async list() {
    return [
      local,
      mac,
      ...savedDevices
        .filter((e) => !faulted || e.id !== "removed")
        .map((e) =>
          faulted && e.id === "moved"
            ? { ...e, target: "replacement-moved" }
            : e,
        ),
      { id: "offline", name: "Offline Mac", target: "offline" },
      { id: "empty", name: "Empty Mac", target: "empty" },
    ];
  }
  async binding(id = "local") {
    const selected = (await this.list()).find((e) => e.id === id);
    if (!selected)
      throw new Error("Project execution environment is no longer configured");
    return selected;
  }
  async assert(binding: any) {
    if (faulted && binding?.id === "lost")
      throw new Error("Saved device is unavailable");
    const current = await this.binding(binding?.id);
    if (binding && current.target !== binding.target)
      throw new Error("Execution target changed");
    return current;
  }
  async branch() {
    return "remote-feature";
  }
}
const environments = new Environments(join(root, "unused"));
const runtime = new FakeRuntime();
const models = runtime.models.bind(runtime);
runtime.models = async () => [
  ...(await models()).map((m) => ({ ...m, backend: "codex" as const })),
  {
    id: "owned-pi",
    name: "Owned Pi",
    backend: "pi" as const,
    provider: "fixture",
    efforts: ["medium"],
    defaultEffort: "medium",
    isDefault: false,
    fastTier: null,
  },
];
for (const [threadId, environmentId, title] of [
  ["local-history", "local", "Local previous task"],
  ["remote-history", "mac", "Remote previous task"],
]) {
  runtime.historySessions.set(threadId, {
    threadId,
    environmentId,
    environmentTarget: environmentId === "mac" ? mac.target : local.target,
    title,
    preview: "Environment-owned history",
    cwd,
    role: "orc",
    archived: false,
    source: "cli",
    updatedAt: 1000,
    model: "sol",
    effort: "medium",
  });
  runtime.historyItems.set(threadId, [
    { id: threadId + "-body", role: "assistant", text: title, at: 1000 },
  ]);
}
const workspaceOptions = {
  directory: join(root, "state"),
  runtime,
  environments,
  projects: async (id = "local") => {
    if (faulted && id === "lost")
      throw new Error("Saved device is unavailable");
    if (id === "mac") await Bun.sleep(650);
    if (id === "offline")
      throw new Error(
        "Project device is unavailable. Check the Mac connection, then retry.",
      );
    if (id === "empty") return [];
    return [
      {
        alias: "same",
        name: "Same project",
        path: cwd,
        owner: "owned",
        environment: await environments.binding(id),
      },
    ];
  },
  branches: { read: async () => "local-main" },
};
let app = new Workspace(workspaceOptions);
const settings = {
  fast: false,
  orc: { backend: "codex" as const, model: "sol", effort: "medium" },
  worker: { backend: "codex" as const, model: "sol", effort: "medium" },
};
for (const device of savedDevices) {
  const agent = await app.createOrc(`${device.id}:same`, settings);
  const thread = runtime.historySessions.get(agent.threadId!)!;
  thread.title = `Saved ${device.id} task`;
  runtime.historyItems.set(agent.threadId!, [
    {
      id: `body-${device.id}`,
      role: "assistant",
      at: 1000,
      text: `Original ${device.id} native transcript` + " ".repeat(1100000),
    },
  ]);
  await app.closeTree(agent.id);
}
app.dispose();
faulted = true;
app = new Workspace(workspaceOptions);
const origin = "http://127.0.0.1:14325";
const service = new HostService(app, {
  directory: join(root, "peer"),
  origin: () => origin,
});
const options = {
  service,
  origin: () => origin,
  assets: join(
    import.meta.dir,
    "../../.scratch/codex-project-environments/assets",
  ),
};
const handler = createHandler(app, options),
  upgrade = createUpgrade(app, options);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14325,
  fetch(request, server) {
    const result = upgrade(request, server);
    if (result === true) return;
    return result ?? handler(request);
  },
  websocket: groveWebsocket,
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  service.dispose();
  app.dispose();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
