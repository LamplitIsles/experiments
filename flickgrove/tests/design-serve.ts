// Isolated synthetic preview: production components and real Hub/HTTP/Workspace,
// with only test-owned state and FakeRuntime. No installed project/provider access.
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket, type SocketData } from "../server/chord-socket";
import { DeliveryRejected } from "../server/runtime";
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
let quotaFailure = false;
let modelFailure = false;
let quotaResets: number | undefined = 1791252000;
let quotaReads = 0;
let stopMode = "pending";
let sendMode = "accepted";
let sendGate = Promise.withResolvers<void>();
let peerDrop = false;
let freshNoWorkers = false;
let longConversations = false;
const browserSockets = new Set<ServerWebSocket<SocketData>>();
let units: ReturnType<typeof unit>[] = [];
let current: ReturnType<typeof unit>;
let peer: ReturnType<typeof unit>;
let empty: ReturnType<typeof unit>;
let emptyOrigin = "";
let peerOrigin = "";
const peerOriginForFixture = () => peerOrigin;
function unit(
  name: string,
  hub: boolean,
  agents: Detail[],
  origin: () => string,
  restoredDirectory?: string,
) {
  const stateDirectory =
    restoredDirectory ?? join(directory, crypto.randomUUID());
  if (!restoredDirectory) {
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
  }
  const runtime = new FakeRuntime();
  for (const a of agents)
    runtime.names.set(a.threadId ?? `thread-${a.id}`, a.title);
  runtime.models = async () => {
    if (modelFailure) throw new Error("Synthetic model outage");
    return [
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
  };
  runtime.skills = async () => [
    { name: "to-orc-impl", description: "Implement one spec with one Worker" },
    {
      name: "review-code-and-tests",
      description: "Review code and verify tests",
      shortDescription: "Review changes",
    },
    { name: "grill-with-docs", description: "Interview a design" },
  ];
  runtime.weekly = async (): Promise<WeeklyUsage> => {
    quotaReads++;
    if (quotaFailure) throw new Error("Synthetic quota outage");
    return {
      remaining: usage,
      fetchedAt: Date.now(),
      accountId: name === "NUC" ? "fixture-nuc-account" : "fixture-mac-account",
      ...(usage === null || quotaResets === undefined
        ? {}
        : { resetsAt: quotaResets }),
    };
  };
  runtime.sendOverride = async (_id, _text, turnId) => {
    if (sendMode === "held") await sendGate.promise;
    if (sendMode === "rejected")
      throw new DeliveryRejected("Synthetic rejection");
    if (sendMode === "uncertain")
      throw new Error("Synthetic native outcome unknown");
    return turnId ?? crypto.randomUUID();
  };
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
    name,
    origin,
    // Browser startup can contend with compilation on the host; keep synthetic
    // peer admission within the browser test budget without treating it as an outage.
  });
  const handler = createHandler(app, {
    service,
    origin,
    assets: resolve("../.scratch/flickgrove-browser/assets"),
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
    messages: longConversations
      ? [
          {
            id: "long",
            role: "assistant",
            text: Array.from(
              { length: 70 },
              (_, i) =>
                `Paragraph ${i + 1}. Long conversation fixture for reading and following new messages.`,
            ).join("\n\n"),
            at: Date.now(),
          },
        ]
      : freshNoWorkers
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
  for (const socket of browserSockets)
    socket.close(1001, "Synthetic fixture reset");
  browserSockets.clear();
  for (const unit of units) {
    unit.service.dispose();
    unit.server?.stop(true);
    unit.app.dispose();
  }
  units = [];
  freshNoWorkers = mode === "no-workers";
  longConversations = mode === "long";
  peerDrop = false;
  quotaFailure = false;
  modelFailure = false;
  quotaResets = 1791252000;
  quotaReads = 0;
  usage = 72;
  stopMode = "pending";
  sendMode = "accepted";
  sendGate.resolve();
  sendGate = Promise.withResolvers<void>();
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
  peerOrigin = "";
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
    websocket: groveWebsocket,
    fetch: (req, server) => {
      if (peerDrop)
        return new Response("Synthetic host outage", { status: 503 });
      const result = createUpgrade(peer.app, {
        service: peer.service,
        origin: () => peerOrigin,
      })(req, server);
      return result === true ? undefined : (result ?? peer.handler(req));
    },
  });
  peerOrigin = `http://127.0.0.1:${peer.server.port}`;
  empty = unit("Workstation", false, [], () => emptyOrigin);
  units.push(empty);
  empty.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const result = createUpgrade(empty.app, {
        service: empty.service,
        origin: () => emptyOrigin,
      })(req, server);
      return result === true ? undefined : (result ?? empty.handler(req));
    },
  });
  emptyOrigin = `http://127.0.0.1:${empty.server.port}`;
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
}
await reset();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14319,
  idleTimeout: 0,
  websocket: {
    ...groveWebsocket,
    open(socket) {
      browserSockets.add(socket);
      groveWebsocket.open(socket);
    },
    close(socket) {
      browserSockets.delete(socket);
      groveWebsocket.close(socket);
    },
  },
  fetch: async (request, server) => {
    const upgraded = createUpgrade(current.app, {
      service: current.service,
      origin: () => "http://127.0.0.1:14319",
    })(request, server);
    if (upgraded) return upgraded === true ? undefined : upgraded;
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reset" && request.method === "POST") {
      const body = (await request.json()) as { mode?: string };
      await reset(body.mode);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/snapshot")
      return Response.json({
        ...current.service.snapshot(),
        agents: [
          ...current.service.snapshot().agents,
          ...peer.service.snapshot().agents,
        ],
      });
    if (url.pathname.startsWith("/fixture/agents/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/fixture/agents/".length),
      );
      const service = id.startsWith(peer.service.identity.id + ":")
        ? peer.service
        : current.service;
      return Response.json(await service.detail(id));
    }
    if (url.pathname === "/fixture/info")
      return Response.json({
        hub: current.service.identity.id,
        peerUrl: peerOrigin,
        peerToken: peer.service.credential,
        peerInputs: peer.runtime.inputs,
        quotaReads,
        localAgents: current.app.snapshot().agents,
        peerAgents: peer.app.snapshot().agents,
        peer: peer.service.identity.id,
        emptyUrl: emptyOrigin,
        emptyToken: empty.service.credential,
        inputs: current.runtime.inputs,
      });
    if (url.pathname === "/fixture/change" && request.method === "POST") {
      const body = (await request.json()) as {
        quotaFailure?: boolean;
        modelFailure?: boolean;
        quotaResets?: number | null;
        outage?: boolean;
        usage?: number | null;
        stopMode?: string;
        sendMode?: string;
        complete?: string;
        question?: boolean;
        questionId?: string;
        questionAgent?: string;
        questionCount?: number;
        questionOptions?: boolean;
        questionLong?: boolean;
        restartHub?: boolean;
        append?: { agentId: string; text: string };
      };
      if (body.restartHub) {
        const prior = current;
        const inputs = [...prior.runtime.inputs];
        for (const socket of browserSockets)
          socket.close(1001, "Synthetic Hub restart");
        prior.service.dispose();
        prior.app.dispose();
        current = unit(
          "NUC",
          true,
          [],
          () => "http://127.0.0.1:14319",
          prior.stateDirectory,
        );
        current.runtime.inputs.push(...inputs);
        units = units.filter((u) => u !== prior);
        units.push(current);
      }
      if (body.append) {
        const id = body.append.agentId;
        const turnId = current.app.detail(id).turnId ?? crypto.randomUUID();
        current.runtime.emit(id, {
          type: "item",
          turnId,
          item: {
            id: crypto.randomUUID(),
            type: "agentMessage",
            phase: "final_answer",
            text: body.append.text,
          },
        });
        current.runtime.emit(id, {
          type: "completed",
          turnId,
          status: "completed",
        });
      }
      if (body.outage !== undefined) {
        peerDrop = body.outage;
        if (peerDrop) peer.server?.stop(true);
        else {
          peer.server = Bun.serve({
            hostname: "127.0.0.1",
            port: Number(new URL(peerOriginForFixture()).port),
            websocket: groveWebsocket,
            fetch: (req, server) => {
              const result = createUpgrade(peer.app, {
                service: peer.service,
                origin: () => peerOriginForFixture(),
              })(req, server);
              return result === true
                ? undefined
                : (result ?? peer.handler(req));
            },
          });
        }
      }
      if (body.modelFailure !== undefined) modelFailure = body.modelFailure;
      if (body.quotaFailure !== undefined) quotaFailure = body.quotaFailure;
      if (body.quotaResets !== undefined)
        quotaResets = body.quotaResets ?? undefined;
      if (body.usage !== undefined) usage = body.usage;
      if (body.stopMode) stopMode = body.stopMode;
      if (body.sendMode) {
        sendMode = body.sendMode;
        if (sendMode !== "held") sendGate.resolve();
        else sendGate = Promise.withResolvers<void>();
      }
      if (body.complete) {
        const turnId = current.app.detail("orc").turnId!;
        current.runtime.emit("orc", {
          type: "completed",
          turnId,
          status: body.complete,
        });
      }
      if (body.question) {
        const questionAgent = body.questionAgent ?? "orc";
        const target = questionAgent === "peer" ? peer : current;
        const id = questionAgent === "peer" ? "orc" : questionAgent;
        const turnId = target.app.detail(id).turnId!;
        target.runtime.emit(id, {
          type: "item",
          turnId,
          item: {
            id: body.questionId ?? "fixture-q",
            type: "agentMessage",
            delivery: "async",
            questions: Array.from(
              { length: body.questionCount ?? 1 },
              (_, i) => ({
                question: body.questionLong
                  ? `A long screenshot review question: ${"Preserve clear small text, original dimensions and the complete answer while navigating. ".repeat(8)}`
                  : body.questionId
                    ? `${body.questionId} question ${i + 1}`
                    : "Which design?",
                options:
                  body.questionOptions === false
                    ? []
                    : [
                        { label: "Recommended choice" },
                        {
                          label: "Alternative",
                          ...(body.questionLong
                            ? {
                                description:
                                  "A detailed explanation with enough context to make an informed choice. ".repeat(
                                    4,
                                  ),
                              }
                            : {}),
                        },
                      ],
              }),
            ),
          },
        });
      }

      return Response.json({ ok: true });
    }
    if (url.pathname === "/" && request.method === "GET") {
      const file = await Bun.file(
        resolve("../.scratch/flickgrove-browser/assets/index.html"),
      ).text();
      const configs = [
        {
          id: peer.service.identity.id,
          name: peer.service.identity.name,
          url: peerOrigin,
          credential: peer.service.credential,
        },
      ];
      const script = `<script>if(!localStorage.getItem('flickgrove/'+location.origin+'/peers'))localStorage.setItem('flickgrove/'+location.origin+'/peers',${JSON.stringify(JSON.stringify(configs))});if(!localStorage.getItem('flickgrove/'+location.origin+'/preferences'))localStorage.setItem('flickgrove/'+location.origin+'/preferences',${JSON.stringify(JSON.stringify(defaults))});</script>`;
      return new Response(file.replace("<head>", "<head>" + script), {
        headers: { "Content-Type": "text/html" },
      });
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
