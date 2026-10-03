// Isolated synthetic preview: production components and real Hub/HTTP/Workspace,
// with only test-owned state and FakeRuntime. No installed project/provider access.
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler } from "../server/http";
import { FakeRuntime } from "../server/testing";
import type { Detail, WeeklyUsage } from "../src/contracts";
const directory = mkdtempSync(join(tmpdir(), "grove-design-preview-"));
const projects = [
  {
    alias: "codex-for-love",
    name: "Codex for Love",
    path: join(directory, "codex-for-love"),
  },
  {
    alias: "experiments",
    name: "Experiments",
    path: join(directory, "experiments"),
  },
];
const defaults = {
  fast: true,
  orc: { model: "gpt-6.1-sol", effort: "low" },
  worker: { model: "gpt-6.1-sol", effort: "low" },
};
let usage: number | null = 72;
let stopMode = "pending";
let peerDrop = false;
let freshNoWorkers = false;
let units: ReturnType<typeof unit>[] = [];
let current: ReturnType<typeof unit>;
let peer: ReturnType<typeof unit>;
let empty: ReturnType<typeof unit>;
let emptyOrigin = "";
function unit(
  name: string,
  hub: boolean,
  agents: Detail[],
  origin: () => string,
) {
  const stateDirectory = join(directory, crypto.randomUUID());
  mkdirSync(stateDirectory, { mode: 0o700 });
  const db = new Database(join(stateDirectory, "workspace.sqlite"));
  db.exec(
    "CREATE TABLE workspace (id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
  );
  db.query("INSERT INTO workspace VALUES(1,?)").run(
    JSON.stringify({
      agents: agents.map((a) => ({ ...a, token: `fixture-${a.id}` })),
      settings: defaults,
      revision: 0,
    }),
  );
  db.close();
  const runtime = new FakeRuntime();
  for (const a of agents)
    runtime.names.set(a.threadId ?? `thread-${a.id}`, a.title);
  runtime.models = async () => [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      efforts: ["low", "medium", "high"],
      defaultEffort: "low",
      isDefault: true,
      fastTier: "priority",
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6-Luna",
      efforts: ["low", "medium"],
      defaultEffort: "low",
      isDefault: false,
      fastTier: "priority",
    },
  ];
  runtime.weekly = async (): Promise<WeeklyUsage> => ({
    remaining: usage,
    fetchedAt: Date.now(),
    accountId: name === "NUC" ? "fixture-nuc-account" : "fixture-mac-account",
    ...(usage === null ? {} : { resetsAt: 1791252000 }),
  });
  runtime.interruptOverride = async () => {
    if (stopMode === "unknown") throw new Error("fixture uncertain acceptance");
  };
  const app = new Workspace({
    directory: stateDirectory,
    runtime,
    projects: async () => projects,
  });
  const service = new HostService(app, {
    directory: stateDirectory,
    hub,
    name,
    origin,
    pollMs: 150,
    timeoutMs: 250,
  });
  const handler = createHandler(app, {
    service,
    origin,
    ...(hub ? { assets: resolve("dist") } : {}),
  });
  return {
    app,
    runtime,
    service,
    handler,
    stateDirectory,
    server: undefined as ReturnType<typeof Bun.serve> | undefined,
  };
}
function agent(
  id: string,
  role: "orc" | "worker",
  title: string,
  project: number,
  ownerId?: string,
): Detail {
  return {
    id,
    role,
    title,
    project: projects[project],
    ownerId,
    model: "gpt-6.1-sol",
    effort: "low",
    serviceTier: "priority",
    state: "idle",
    closed: false,
    questions: [],
    deliveries: [],
    messages: freshNoWorkers
      ? [
          {
            id: "user",
            role: "user",
            text: "Review the voice input requirements.",
            at: Date.now(),
          },
        ]
      : role === "orc"
        ? [
            {
              id: "user",
              role: "user",
              text: "Add streaming voice input and coordinate both projects.",
              at: Date.now(),
            },
            {
              id: "assistant",
              role: "assistant",
              text: "I’ve started two Workers.\n\nVoice input is implementing the change.  \nDocumentation is updating the guide.\n\nI’ll review both results before asking you to merge.",
              at: Date.now(),
            },
          ]
        : [],
  };
}
async function reset(mode = "working") {
  for (const unit of units) {
    unit.service.dispose();
    unit.server?.stop(true);
    unit.app.dispose();
  }
  units = [];
  freshNoWorkers = mode === "no-workers";
  peerDrop = false;
  usage = 72;
  stopMode = "pending";
  const workers = !["no-workers", "idle"].includes(mode);
  current = unit(
    "NUC",
    true,
    [
      agent("orc", "orc", "Streaming voice input", 0),
      ...(mode === "dense"
        ? Array.from({ length: 18 }, (_, i) =>
            agent(`extra-${i}`, "orc", `Additional task ${i + 1}`, 0),
          )
        : []),
      ...(workers
        ? [
            agent("voice", "worker", "Voice input", 0, "orc"),
            agent(
              "docs",
              "worker",
              mode === "dense"
                ? "Documentation for a very long Worker assignment covering mobile navigation and persistent conversation drafts across hosts"
                : "Documentation",
              1,
              "orc",
            ),
          ]
        : []),
    ],
    () => "http://127.0.0.1:14319",
  );
  units.push(current);
  let peerOrigin = "";
  peer = unit(
    "Neil’s Mac",
    false,
    [
      agent("orc", "orc", "Reader performance", 1),
      ...(workers
        ? [agent("reader", "worker", "Reader implementation", 1, "orc")]
        : []),
    ],
    () => peerOrigin,
  );
  units.push(peer);
  peer.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      peerDrop
        ? new Response("Synthetic host outage", { status: 503 })
        : peer.handler(req),
  });
  peerOrigin = `http://127.0.0.1:${peer.server.port}`;
  empty = unit("Workstation", false, [], () => emptyOrigin);
  units.push(empty);
  empty.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => empty.handler(req),
  });
  emptyOrigin = `http://127.0.0.1:${empty.server.port}`;
  await current.service.register({
    name: "Neil’s Mac",
    url: peerOrigin,
    credential: peer.service.credential,
  });
  if (mode !== "idle" && mode !== "no-workers") {
    await current.app.send(
      "orc",
      "Add streaming voice input and coordinate both projects.",
      "user",
    );
    await peer.app.send(
      "orc",
      "Add streaming voice input and coordinate both projects.",
      "user",
    );
    await current.app.tool("fixture-orc", "worker_send", {
      workerId: "voice",
      message: "Implement voice input",
    });
    await peer.app.tool("fixture-orc", "worker_send", {
      workerId: "reader",
      message: "Implement reader",
    });
  }
  await current.service.refresh();
}
await reset();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14319,
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reset" && request.method === "POST") {
      const body = (await request.json()) as { mode?: string };
      await reset(body.mode);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/info")
      return Response.json({
        hub: current.service.identity.id,
        peer: peer.service.identity.id,
        emptyUrl: emptyOrigin,
        emptyToken: empty.service.credential,
      });
    if (url.pathname === "/fixture/change" && request.method === "POST") {
      const body = (await request.json()) as {
        outage?: boolean;
        usage?: number | null;
        stopMode?: string;
        complete?: string;
        question?: boolean;
        restartHub?: boolean;
      };
      if (body.outage !== undefined) peerDrop = body.outage;
      if (body.usage !== undefined) usage = body.usage;
      if (body.stopMode) stopMode = body.stopMode;
      if (body.complete) {
        const turnId = current.app.detail("orc").turnId!;
        current.runtime.emit("orc", {
          type: "completed",
          turnId,
          status: body.complete,
        });
      }
      if (body.question) {
        const turnId = current.app.detail("orc").turnId!;
        current.runtime.emit("orc", {
          type: "item",
          turnId,
          item: {
            id: "fixture-q",
            type: "agentMessage",
            delivery: "async",
            questions: [
              {
                question: "Which design?",
                options: [
                  { label: "Recommended choice" },
                  { label: "Alternative" },
                ],
              },
            ],
          },
        });
      }
      await current.service.refresh();
      return Response.json({ ok: true });
    }
    return current.handler(request);
  },
});
function cleanup() {
  server.stop(true);
  for (const unit of units) {
    unit.service.dispose();
    unit.server?.stop(true);
    unit.app.dispose();
  }
  rmSync(directory, { recursive: true, force: true });
  process.exit();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
