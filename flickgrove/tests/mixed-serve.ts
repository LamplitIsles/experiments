// Isolated browser fixture: real Pi SDK, local fake model, FakeRuntime Codex.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = await mkdtemp(join(tmpdir(), "grove-mixed-browser-"));
for (const key of Object.keys(process.env))
  if (!["PATH", "LD_LIBRARY_PATH"].includes(key)) delete process.env[key];
process.env.HOME = root;
process.env.CODEX_HOME = join(root, "codex");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const [
  { Workspace },
  { FakeRuntime },
  { PiRuntime },
  { MixedRuntime },
  { HostService },
  { createHandler, createUpgrade },
  { groveWebsocket },
] = await Promise.all([
  import("../server/workspace"),
  import("../server/testing"),
  import("../server/pi"),
  import("../server/mixed-runtime"),
  import("../server/hosts"),
  import("../server/http"),
  import("../server/chord-socket"),
]);
const cwd = join(root, "repo"),
  agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(cwd);
process.chdir(cwd);
await mkdir(agentDir);
let modelCalls = 0,
  holdModel = false;
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    await req.json();
    modelCalls++;
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (holdModel)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk({ role: "assistant", content: "" }, null),
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    return new Response(
      chunk({ role: "assistant", content: "Owned Pi fixture reply" }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const config = (authenticated = true) => ({
  providers: {
    fixture: {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${model.port}/v1`,
      ...(authenticated ? { apiKey: "owned-browser-key" } : {}),
      models: [
        {
          id: "fixture",
          name: "Pi fixture model",
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
});
await writeFile(join(agentDir, "auth.json"), "{}");
await writeFile(join(agentDir, "models.json"), JSON.stringify(config()));
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture",
    defaultThinkingLevel: "off",
  }),
);
let app: InstanceType<typeof Workspace>;
const codex = new FakeRuntime();
const runtime = new MixedRuntime(
  codex,
  new PiRuntime({
    agentDir,
    tool: (token, name, args) => app.tool(token, name, args),
  }),
);
let expandedChoices = false;
let registeredProjects = [
  { alias: "fixture", name: "Mixed fixture", path: cwd },
];
const workspaceOptions = {
  directory: join(root, "state"),
  runtime,
  projects: async () => registeredProjects,
  branches: { read: async () => null },
};
app = new Workspace(workspaceOptions);
let origin = "";
let service = new HostService(app, {
  directory: join(root, "state"),
  name: "Owned mixed fixture",
  origin: () => origin,
});
const httpOptions = () => ({
  origin: () => origin,
  assets: resolve(import.meta.dir, "../dist"),
  service,
});
let handler = createHandler(app, httpOptions()),
  upgrade = createUpgrade(app, httpOptions());
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: groveWebsocket,
  async fetch(req, server) {
    if (
      new URL(req.url).pathname === "/fixture/choices" &&
      req.method === "POST"
    ) {
      const { enabled } = (await req.json()) as { enabled: boolean };
      expandedChoices = enabled;
      const settings = config();
      if (enabled) {
        const base = settings.providers.fixture.models[0]!;
        settings.providers.fixture.models.push(
          ...Array.from({ length: 40 }, (_, index) => ({
            ...base,
            id: `long-model-${String(index).padStart(2, "0")}`,
            name: `Long model ${String(index).padStart(2, "0")} — a very detailed provider catalogue label for viewport and search verification`,
          })),
        );
        registeredProjects = [
          { alias: "fixture", name: "Mixed fixture", path: cwd },
          ...Array.from({ length: 35 }, (_, index) => ({
            alias: `project-${String(index).padStart(2, "0")}`,
            name: `Orbit project ${String(index).padStart(2, "0")} with a long descriptive name`,
            path: join(
              cwd,
              "nested-project-directory-with-a-long-path",
              `project-${index}`,
            ),
          })),
        ];
        await Promise.all(
          registeredProjects.map((project) =>
            mkdir(project.path, { recursive: true }),
          ),
        );
      } else
        registeredProjects = [
          { alias: "fixture", name: "Mixed fixture", path: cwd },
        ];
      await writeFile(join(agentDir, "models.json"), JSON.stringify(settings));
      return Response.json({ ok: true, expandedChoices });
    }
    if (
      new URL(req.url).pathname === "/fixture/hold" &&
      req.method === "POST"
    ) {
      holdModel = ((await req.json()) as { enabled: boolean }).enabled;
      return Response.json({ ok: true });
    }
    if (new URL(req.url).pathname === "/fixture/info")
      return Response.json({
        modelCalls,
        snapshot: service.snapshot(),
        detail: new URL(req.url).searchParams.has("id")
          ? await service.detail(new URL(req.url).searchParams.get("id")!)
          : undefined,
      });
    if (
      new URL(req.url).pathname === "/fixture/auth" &&
      req.method === "POST"
    ) {
      const { enabled } = (await req.json()) as { enabled: boolean };
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify(config(enabled)),
      );
      return Response.json({ ok: true });
    }
    if (
      new URL(req.url).pathname === "/fixture/restart" &&
      req.method === "POST"
    ) {
      service.dispose();
      app.dispose();
      await runtime.close();
      app = new Workspace(workspaceOptions);
      service = new HostService(app, {
        directory: join(root, "state"),
        name: "Owned mixed fixture",
        origin: () => origin,
      });
      handler = createHandler(app, httpOptions());
      upgrade = createUpgrade(app, httpOptions());
      return Response.json({ ok: true });
    }
    const up = upgrade(req, server);
    if (up) return up === true ? undefined : up;
    return handler(req);
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
  model.stop(true);
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void cleanup());
process.on("SIGINT", () => void cleanup());
