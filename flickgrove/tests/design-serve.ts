let disconnected = false;
let detailDelay = 0;
let detailFailure = false;
let settingsDelay = 0;
let settingsFailure = false;
let settingsLong = false;
// Isolated synthetic preview: production components and real Hub/HTTP/Workspace,
// with only test-owned state and FakeRuntime. No installed project/provider access.
import { temporaryGit, fixtureGit } from "../server/branch-testing";
import { readDirectoryBranch } from "../server/directory-branches";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace } from "../server/workspace";
import { WorkspaceStore } from "../server/workspace-store";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket, type SocketData } from "../server/chord-socket";
import { type RuntimeEvent, DeliveryRejected } from "../server/runtime";
import { voiceHttp } from "../server/voice-http";
import { fakeVoiceProvider } from "./voice-fixture";
import { FakeRuntime } from "../server/testing";
import { projectCatalogue } from "../server/projects";
import type { Detail, WeeklyUsage } from "../src/contracts";
const directory = mkdtempSync(join(tmpdir(), "grove-design-preview-"));
const voiceProvider = fakeVoiceProvider();
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
const orgProjects = [
  ...projects,
  { alias: "forge", name: "Forge", path: join(directory, "forge") },
  { alias: "personal", name: "Personal", path: join(directory, "personal") },
  { alias: "local", name: "Local", path: join(directory, "local") },
];
let orgFixture = false;
let activityFixture = false;
let projectsDelay = 0;
let projectsFailure = false;
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
let freshNoWorkers = false;
let longConversations = false;
let rowConversations = false;
const browserSockets = new Set<ServerWebSocket<SocketData>>();
let branchFixture = false;
let branchFailure = false;
let branchPaths = new Map<string, string[]>();
let units: ReturnType<typeof unit>[] = [];
let current: ReturnType<typeof unit>;
function unit(
  name: string,
  hub: boolean,
  agents: Detail[],
  origin: () => string,
  restoredDirectory?: string,
) {
  const unitProjects = branchFixture
    ? projects.map((project, index) => ({
        ...project,
        path: branchPaths.get(name)![index],
      }))
    : orgFixture
      ? projectCatalogue(
          orgProjects.map((p, i) => ({
            ...p,
            remote: [
              "https://github.com/GuionAI/one",
              "ssh://git@forge.example/lamplitisles/two",
              "git@forge.example:guionai/three",
              "https://github.com/Personal/four",
              "",
            ][i],
          })),
        )
      : projects;
  if (branchFixture)
    agents = agents.map((a) => ({
      ...a,
      project: unitProjects.find((p) => p.alias === a.project.alias)!,
    }));
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
    if (activityFixture) {
      const store = new WorkspaceStore(
        join(stateDirectory, "workspace.sqlite"),
      );
      const update = store.sqlite.query(
        "UPDATE sessions SET last_activity_at = ? WHERE id = ?",
      );
      for (const [id, hours] of [
        ["orc", 0.5],
        ["reader-orc", 3],
        ["extra-day", 12],
        ["extra-week", 72],
        ["extra-old", 216],
      ] as const)
        update.run(Date.now() - hours * 3_600_000, id);
      store.close();
    }
  }
  const runtime = new FakeRuntime();
  for (const a of agents) {
    const threadId = a.threadId ?? `thread-${a.id}`;
    runtime.names.set(threadId, a.title);
    runtime.historyItems.set(
      threadId,
      a.messages.map((m) => ({
        ...m,
        clientId: a.deliveries.find((d) => d.id === m.id)?.id,
      })),
    );
    runtime.historySessions.set(threadId, {
      threadId,
      title: a.title,
      preview: "Fixture",
      cwd: a.project.path,
      role: a.role,
      archived: false,
      source: "appServer",
      updatedAt: Date.now(),
    });
  }
  runtime.models = async () => {
    if (modelFailure) throw new Error("Synthetic model outage");
    return [
      ...(settingsLong
        ? [
            {
              id: "fixture-model-with-an-extremely-long-name-for-mobile-overflow-verification",
              name: "Fixture model with an extremely long name for mobile overflow verification",
              efforts: ["medium"],
              defaultEffort: "medium",
              isDefault: false,
              fastTier: null,
            },
          ]
        : []),
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
        fastTier: null,
      },
    ];
  };
  runtime.settingsOverride = async () => {
    if (settingsDelay) await Bun.sleep(settingsDelay);
    if (settingsFailure)
      throw new Error("Synthetic settings outcome unknown; reopen to check.");
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
      ...(quotaResets === undefined ? {} : { resetsAt: quotaResets }),
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
    projects: async () => {
      if (projectsDelay) await Bun.sleep(projectsDelay);
      if (projectsFailure) throw new Error("Synthetic catalogue failure");
      return unitProjects;
    },
    researcherSnapshot: async () => ({
      model: "gpt-6.1-sol",
      effort: "high",
      prompt: "Synthetic evidence investigation",
    }),
    reviewerSnapshot: async () => ({
      model: "gpt-6.1-sol",
      effort: "high",
      prompt: "Synthetic read-only review",
    }),
    ...(branchFixture
      ? {
          branches: {
            intervalMs: 50,
            read: async (path: string, signal: AbortSignal) => {
              if (name === "NUC" && branchFailure)
                throw new Error("Synthetic Git timeout/permission failure");
              return readDirectoryBranch(path, signal);
            },
          },
        }
      : {}),
  });
  const service = new HostService(app, {
    directory: stateDirectory,
    name,
    origin,
    // Browser startup can contend with compilation on the host; keep synthetic
    // peer admission within the browser test budget without treating it as an outage.
  });
  const originalDetail = service.detail.bind(service);
  service.detail = async (id) => {
    if (id.endsWith(":reader-orc") || id.endsWith(":reader")) {
      if (detailDelay) await Bun.sleep(detailDelay);
      if (detailFailure) throw new Error("Synthetic detail unavailable");
    }
    return originalDetail(id);
  };
  const configPath = join(stateDirectory, "config.toml");
  writeFileSync(configPath, "");
  writeFileSync(join(stateDirectory, "voice-key"), "synthetic-browser-key", {
    mode: 0o600,
  });
  const voice = { configPath, connect: voiceProvider.connect };
  const handler = createHandler(app, {
    voice,
    service,
    origin,
    assets: resolve(
      process.env.GROVE_TEST_ASSETS ?? "../.scratch/flickgrove-browser/assets",
    ),
  });
  return {
    app,
    runtime,
    service,
    handler,
    stateDirectory,
    voice,
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
    ...(activityFixture ? { threadId: `thread-${id}` } : {}),
    project: {
      ...(orgFixture ? orgProjects : projects)[project],
      ...(orgFixture && project === 2 ? { alias: "historic-forge-alias" } : {}),
    },
    ownerId,
    model: "gpt-6.1-sol",
    effort: "low",
    serviceTier: "priority",
    state: "idle",
    closed: false,
    questions: [],
    deliveries: [],
    messages: rowConversations
      ? Array.from({ length: 40 }, (_, index) => ({
          id: `row-${index}`,
          role: "assistant" as const,
          text:
            `${title}: Row ${index}.\n\n` +
            "Anonymous reading paragraph.\n\n".repeat(8),
          at: Date.now(),
        }))
      : longConversations
        ? [
            {
              id: "long",
              role: "assistant",
              text: Array.from(
                { length: 70 },
                (_, i) =>
                  `${title}: Paragraph ${i + 1}. Long conversation fixture for reading and following new messages.`,
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
function fixtureQuestion(state: "unanswered" | "delegated") {
  return {
    id: "seed:0",
    itemId: "seed",
    index: 0,
    title: "Question",
    text: "Seeded Worker question",
    options: [],
    state,
    at: 1,
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
  orgFixture = ["org-groups", "org-groups-idle"].includes(mode);
  activityFixture = mode === "activity";
  projectsDelay = 0;
  projectsFailure = false;
  branchFixture = mode === "branches";
  branchFailure = false;
  branchPaths = new Map();
  if (branchFixture)
    for (const name of ["NUC"]) {
      branchPaths.set(
        name,
        [0, 1].map((i) =>
          temporaryGit(
            join(directory, crypto.randomUUID(), name, String(i)),
            "feat/a-very-long-checkout-branch-for-directory-identification",
          ),
        ),
      );
    }
  disconnected = false;
  detailDelay = 0;
  detailFailure = false;
  settingsDelay = 0;
  settingsFailure = false;
  settingsLong = false;
  freshNoWorkers = mode === "no-workers";
  longConversations = mode === "long";
  rowConversations = ["virtual-images", "host-selection"].includes(mode);
  quotaFailure = false;
  modelFailure = false;
  quotaResets = 1791252000;
  quotaReads = 0;
  usage = 72;
  stopMode = "pending";
  sendMode = "accepted";
  sendGate.resolve();
  sendGate = Promise.withResolvers<void>();
  const workers = ![
    "no-workers",
    "idle",
    "org-groups-idle",
    "host-selection",
    "activity",
  ].includes(mode);
  current = unit(
    "NUC",
    true,
    mode === "empty"
      ? []
      : [
          agent("orc", "orc", "Streaming voice input", 0),
          agent("reader-orc", "orc", "Reader performance", 1),
          ...(activityFixture
            ? [
                agent("extra-day", "orc", "Earlier today", 0),
                agent("extra-week", "orc", "Earlier this week", 0),
                agent("extra-old", "orc", "Old session", 0),
              ]
            : []),
          ...(workers
            ? [
                agent(
                  "reader",
                  "worker",
                  "Reader implementation",
                  1,
                  "reader-orc",
                ),
              ]
            : []),
          ...(["host-selection", "device-questions"].includes(mode)
            ? [agent("second", "orc", "NUC second session", 0)]
            : []),
          ...(orgFixture
            ? [
                agent(
                  "forge-orc",
                  "orc",
                  "Forge repository in the same organization",
                  2,
                ),
                agent("personal-orc", "orc", "Personal repository", 3),
                agent("local-orc", "orc", "Local repository without remote", 4),
                {
                  ...agent(
                    "missing-orc",
                    "orc",
                    "Project removed from catalogue",
                    4,
                  ),
                  project: {
                    alias: "missing",
                    name: "Missing",
                    path: join(directory, "missing"),
                  },
                },
              ]
            : []),
          ...(mode === "dense"
            ? Array.from({ length: 18 }, (_, i) =>
                agent(`extra-${i}`, "orc", `Additional task ${i + 1}`, 0),
              )
            : []),
          ...(workers
            ? [
                {
                  ...agent("voice", "worker", "Voice input", 0, "orc"),
                  ...(mode === "device-worker"
                    ? { questions: [fixtureQuestion("unanswered")] }
                    : {}),
                },
                agent(
                  "docs",
                  "worker",
                  ["dense", "branches", "org-groups"].includes(mode)
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
  if (
    ![
      "empty",
      "idle",
      "org-groups-idle",
      "no-workers",
      "host-selection",
      "activity",
    ].includes(mode)
  ) {
    await current.app.send(
      "orc",
      "Add streaming voice input and coordinate both projects.",
      "user",
    );
    await current.app.send(
      "reader-orc",
      "Add streaming voice input and coordinate both projects.",
      "user",
    );
    await current.app.tool("fixture-orc", "worker_send", {
      workerId: "voice",
      message: "Implement voice input",
    });
    await current.app.tool("fixture-reader-orc", "worker_send", {
      workerId: "reader",
      message: "Implement reader",
    });
  }
  if (mode === "researchers") {
    const r = (await current.app.tool("fixture-orc", "researcher_start", {
      project: "experiments",
      title:
        "Native collaboration evidence with a long bounded research question",
      question: "Which supported override disables model-aware collaboration?",
      message: "Collect primary evidence",
    })) as Detail;
    for (const a of [current.app.detail("orc"), r])
      current.runtime.historySessions.set(a.threadId!, {
        threadId: a.threadId!,
        title: a.title,
        cwd: a.project.path,
        source: "vscode",
        role: "session",
        updatedAt: Date.now(),
        archived: false,
        preview: "Synthetic managed history",
      });
    const token = current.runtime.agents.get(r.id)!.token;
    await current.app.tool(token, "researcher_report", {
      question: r.researchQuestion,
      message:
        "Verified config gate [primary source](https://example.org). Interpretation is separate; remaining unknown is paid-turn inventory.",
    });
    current.runtime.emit(r.id, {
      type: "item",
      turnId: r.turnId!,
      item: {
        id: "researcher-question",
        type: "agentMessage",
        delivery: "async",
        text: "Need framing",
        questions: [
          { question: "Which installed version should evidence cover?" },
        ],
      },
    });
  }
  if (mode === "reviewers") {
    const r = (await current.app.tool("fixture-orc", "reviewer_start", {
      project: "experiments",
      profile: "standards",
      title: "Standards review with a long assignment title for mobile",
      spec: "#3573",
      fixedPoint: "0fb4294",
      reviewedHead: "fixture-head",
      message: "Read the branch",
    })) as Detail;
    for (const a of [current.app.detail("orc"), r])
      current.runtime.historySessions.set(a.threadId!, {
        threadId: a.threadId!,
        title: a.title,
        cwd: a.project.path,
        source: "vscode",
        role: "session",
        updatedAt: Date.now(),
        archived: false,
        preview: "Synthetic managed history",
      });
    const token = current.runtime.agents.get(r.id)!.token;
    await current.app.tool(token, "reviewer_report", {
      message:
        "Review evidence received. Read-only findings are bound to fixture-head.",
      reviewedHead: "fixture-head",
      spec: "#3573",
      fixedPoint: "0fb4294",
    });
    current.runtime.emit(r.id, {
      type: "item",
      turnId: r.turnId!,
      item: {
        id: "reviewer-question",
        type: "agentMessage",
        delivery: "async",
        text: "Missing verification",
        questions: [
          {
            question: "Please delegate missing screenshot evidence to Worker.",
          },
        ],
      },
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
    if (disconnected && new URL(request.url).pathname.startsWith("/api/"))
      return new Response("Synthetic instance outage", { status: 503 });
    const upgraded = createUpgrade(current.app, {
      service: current.service,
      origin: () => "http://127.0.0.1:14319",
    })(request, server);
    if (upgraded) return upgraded === true ? undefined : upgraded;
    const v = await voiceHttp(
      request,
      current.service,
      ["http://127.0.0.1:14319"],
      current.voice,
      server,
    );
    if (v) return v === true ? undefined : v;
    const url = new URL(request.url);
    if (url.pathname === "/fixture/voice") {
      if (request.method === "POST") {
        const body = await request.json();
        voiceProvider.mode(body.mode ?? "success");
        if (body.release) voiceProvider.release();
        if (body.ready) voiceProvider.ready();
        for (const u of units)
          writeFileSync(
            u.voice.configPath,
            body.disabled ? "" : '[voice]\napi_key_file="voice-key"\n',
          );
      }
      return Response.json({
        ...voiceProvider.stats,
        active: voiceProvider.active,
      });
    }
    if (url.pathname === "/fixture/reset" && request.method === "POST") {
      const body = (await request.json()) as { mode?: string };
      await reset(body.mode);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/snapshot")
      return Response.json({
        ...current.service.snapshot(),
        agents: current.service.snapshot().agents,
      });
    if (url.pathname.startsWith("/fixture/agents/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/fixture/agents/".length),
      );
      const service = current.service;
      return Response.json(await service.detail(id));
    }
    if (url.pathname === "/fixture/info")
      return Response.json({
        hub: current.service.identity.id,
        quotaReads,
        localAgents: current.app.snapshot().agents,
        inputs: current.runtime.inputs,
        imageUploads: JSON.parse(
          readFileSync(
            join(current.app.images.directory, "index.json"),
            "utf8",
          ),
        ),
      });
    if (url.pathname === "/fixture/change" && request.method === "POST") {
      const body = (await request.json()) as {
        projectsDelay?: number;
        projectsFailure?: boolean;
        detailDelay?: number;
        detailFailure?: boolean;
        settingsLong?: boolean;
        settingsDelay?: number;
        settingsFailure?: boolean;
        execution?: {
          agentId?: string;
          threadId?: string;
          turnId?: string;
          event: Exclude<RuntimeEvent, { type: "disconnected" }>;
        };
        branch?: string;
        branchPeer?: boolean;
        branchFailure?: boolean;
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
        questionRecommended?: boolean;
        laterSubmissions?: number;
        questionLong?: boolean;
        externalQuestionHistory?: boolean;
        restartHub?: boolean;
        closedAgent?: string;
        append?: { agentId: string; text: string };
      };
      if (body.projectsDelay !== undefined) projectsDelay = body.projectsDelay;
      if (body.externalQuestionHistory) {
        const threadId = "external-question-history";
        current.runtime.historySessions.set(threadId, {
          threadId,
          title: "External question history",
          preview: "Fixture",
          cwd: current.app.detail("orc").project.path,
          role: "session",
          archived: false,
          source: "cli",
          updatedAt: Date.now(),
        });
        current.runtime.historyItems.set(threadId, [
          {
            id: "external-question",
            questionItemId: "external-question",
            role: "assistant",
            text: "External question",
            at: Date.now(),
          },
        ]);
      }
      if (body.projectsFailure !== undefined)
        projectsFailure = body.projectsFailure;
      if (body.detailDelay !== undefined) detailDelay = body.detailDelay;
      if (body.detailFailure !== undefined) detailFailure = body.detailFailure;
      if (body.settingsLong !== undefined) settingsLong = body.settingsLong;
      if (body.settingsDelay !== undefined) settingsDelay = body.settingsDelay;
      if (body.settingsFailure !== undefined)
        settingsFailure = body.settingsFailure;
      if (body.branchFailure !== undefined) branchFailure = body.branchFailure;
      if (body.branch && branchFixture)
        fixtureGit(
          branchPaths.get("NUC")![body.branchPeer ? 1 : 0],
          "branch",
          "-m",
          body.branch,
        );
      if (body.restartHub) {
        const prior = current;
        const inputs = [...prior.runtime.inputs];
        for (const socket of browserSockets)
          socket.close(1001, "Synthetic Hub restart");
        prior.service.dispose();
        prior.app.dispose();
        if (body.closedAgent) {
          // Simulate an externally authoritative closure in test-owned persisted state.
          const db = new Database(
            join(prior.stateDirectory, "workspace.sqlite"),
          );
          const row = db
            .query("SELECT value FROM workspace WHERE id=1")
            .get() as { value: string };
          const state = JSON.parse(row.value);
          state.agents.find((a: Detail) => a.id === body.closedAgent).closed =
            true;
          db.query("UPDATE workspace SET value=? WHERE id=1").run(
            JSON.stringify(state),
          );
          db.close();
        }
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
        disconnected = body.outage;
        if (disconnected)
          for (const socket of browserSockets)
            socket.close(1001, "Synthetic outage");
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
      if (body.execution) {
        const id = body.execution.agentId ?? "orc";
        const detail = current.app.detail(id);
        current.runtime.emit(id, {
          ...body.execution.event,
          threadId: body.execution.threadId ?? detail.threadId,
          turnId: body.execution.turnId ?? detail.turnId!,
        });
      }
      if (body.complete) {
        const turnId = current.app.detail("orc").turnId!;
        current.runtime.emit("orc", {
          type: "completed",
          turnId,
          status: body.complete,
        });
      }
      if (body.laterSubmissions)
        for (
          let index = 0;
          index < Math.min(body.laterSubmissions, 110);
          index++
        )
          await current.app.send(
            "orc",
            `Owned later input ${index}`,
            `window-extra-${index}`,
          );
      if (body.question) {
        const questionAgent = body.questionAgent ?? "orc";
        const target = current;
        const id = questionAgent;
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
                        {
                          label: body.questionRecommended
                            ? "Recommended choice (Recommended)"
                            : "Recommended choice",
                        },
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
        resolve(
          process.env.GROVE_TEST_ASSETS
            ? `${process.env.GROVE_TEST_ASSETS}/index.html`
            : "../.scratch/flickgrove-browser/assets/index.html",
        ),
      ).text();
      const script = `<script>try{if(!localStorage.getItem('flickgrove/'+location.origin+'/preferences'))localStorage.setItem('flickgrove/'+location.origin+'/preferences',${JSON.stringify(JSON.stringify(defaults))});}catch{ /* Optional fixture preferences may be unavailable. */ }</script>`;
      return new Response(file.replace("<head>", "<head>" + script), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return current.handler(request);
  },
});
function cleanup() {
  voiceProvider.stop();
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
