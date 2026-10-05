// Isolated full Peer/Chord browser fixture: only temporary files and FakeRuntime.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket } from "../server/chord-socket";
import { FakeRuntime } from "../server/testing";
const directory = await mkdtemp(join(tmpdir(), "grove-file-browser-"));
const assets = resolve(
  process.env.PREVIEW_ASSETS ?? "../.scratch/flickgrove-browser/assets",
);
const filename =
  "Hourly profiles 图表 with a very long descriptive filename and spaces (final report).png";
const cdn = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response("window.cdnLoaded=true", {
      headers: {
        "Content-Type": "text/javascript",
        "Access-Control-Allow-Origin": "*",
      },
    }),
});
const defaults = {
  fast: false,
  orc: { model: "sol", effort: "medium" },
  worker: { model: "sol", effort: "medium" },
};
async function unit(name: string, color: string, origin: () => string) {
  const cwd = join(directory, crypto.randomUUID(), name);
  const reports = join(cwd, "reports");
  const workerCwd = join(cwd, "worker");
  await mkdir(join(reports, "sub"), { recursive: true });
  await mkdir(workerCwd);
  const project = { alias: "fixture", name: "Fixture", path: cwd };
  const workerProject = {
    alias: "reporter",
    name: "Reporter",
    path: workerCwd,
  };
  const runtime = new FakeRuntime();
  const history = {
    delay: 0,
    fail: false,
    reads: [] as (string | undefined)[],
  };
  const readHistory = runtime.historyMessages.bind(runtime);
  runtime.historyMessages = async (threadId, cursor) => {
    history.reads.push(cursor);
    if (history.delay) await Bun.sleep(history.delay);
    if (history.fail) throw new Error("Fixture history unavailable");
    return readHistory(threadId, cursor);
  };
  const app = new Workspace({
    directory: join(cwd, "state"),
    runtime,
    projects: async () => [project, workerProject],
    branches: { read: async () => null },
  });
  const agent = await app.createOrc("fixture", defaults);
  const owner = runtime.agents.get(agent.id)!;
  owner.title = name + " reports";
  runtime.names.set(owner.threadId!, owner.title);
  await app.rename(agent.id, owner.title);
  const image = await sharp({
    create: { width: 900, height: 550, channels: 4, background: color },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="900" height="550"><text x="80" y="160" fill="white" font-size="60">${name} report</text><path d="M80 400 L200 290 L350 370 L500 180 L650 260 L800 100" stroke="white" fill="none" stroke-width="5"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  await writeFile(join(reports, filename), image);
  await writeFile(join(reports, "plot.png"), image);
  await writeFile(join(workerCwd, "plot.png"), image);
  await writeFile(
    join(reports, "sub", "data.json"),
    JSON.stringify({ host: name }),
  );
  await writeFile(
    join(reports, "sub", "module.js"),
    "export const label='Local module loaded';",
  );
  await writeFile(
    join(reports, "style.css"),
    "body{font:16px system-ui;background:#fafafa;color:#24314a;margin:0;padding:24px}button{padding:10px 20px}img{max-width:100%;height:220px;object-fit:contain}h1{margin-top:0}",
  );
  // Font is a test build artifact, not installed user data.
  const font = (
    await Array.fromAsync(
      new Bun.Glob("*.woff2").scan({ cwd: assets + "/assets", absolute: true }),
    )
  )[0];
  await writeFile(
    join(reports, "report.woff2"),
    new Uint8Array(await Bun.file(font).arrayBuffer()),
  );
  await writeFile(
    join(reports, "page.html"),
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><style>@font-face{font-family:Report;src:url('report.woff2')}h1{font-family:Report,system-ui}</style><h1>${name} interactive report</h1><button id="increment">Count 0</button><p id="module">Loading local data</p><img src="plot.png"><pre id="isolation"></pre><script src="${cdn.url.origin}/chart.js"></script><script type="module">
  import {label} from './sub/module.js'; let count=0;increment.onclick=()=>increment.textContent='Count '+(++count);
  const data=await fetch('./sub/data.json').then(r=>r.json()); document.querySelector('#module').textContent=label+' / '+data.host;
  const results={cdn:window.cdnLoaded, parent:false, storage:false, api:false, ws:false, font:false};
  try{void parent.document;results.parent=true}catch{}try{localStorage.setItem('escape','yes');results.storage=true}catch{}
  try{const r=await fetch('/api/identity');results.api=r.ok}catch{}
  await new Promise(resolve=>{const ws=new WebSocket('${origin().replace("http:", "ws:")}/api/socket');ws.onopen=()=>{results.ws=true;ws.close();resolve()};ws.onerror=()=>resolve();setTimeout(resolve,1000)});
  try{await document.fonts.load('16px Report');results.font=document.fonts.check('16px Report')}catch{}
  document.querySelector('#isolation').textContent=JSON.stringify(results); window.instance=crypto.randomUUID();
  </script>`,
  );
  await writeFile(
    join(reports, "notes.md"),
    `# ${name} analysis\n\nThis report keeps the conversation nearby while showing the complete file.\n\n![Local chart](plot.png)\n\n<script>window.markdownUnsafe=true</script>\n\n| Measure | ${"Very long column ".repeat(12)} |\n| --- | --- |\n| Result | ${"UnbrokenData".repeat(25)} |\n\n\`\`\`json\n${JSON.stringify({ note: "long code ".repeat(30) })}\n\`\`\`\n\n${"## Reading notes\n\nA readable paragraph with the original report content and local links.\n\n".repeat(15)}[Interactive](page.html)`,
  );
  const turn = await app.send(agent.id, "Prepare reports", "fixture-input");
  const emit = (id: string, text: string) =>
    runtime.emit(agent.id, {
      type: "item",
      turnId: app.detail(agent.id).turnId!,
      item: { id, type: "agentMessage", phase: "final_answer", text },
    });
  emit(
    "links",
    `[Chart](reports/${encodeURIComponent(filename)}) · [HTML](reports/page.html) · [Markdown](reports/notes.md) · [Missing](reports/missing.png) · [Other file](reports/plot.png) · [Web](https://example.com)\n\n[Absolute chart](${join(reports, "plot.png")}) · [File URL](file://${join(reports, "plot.png")})`,
  );
  runtime.emit(agent.id, {
    type: "completed",
    turnId: app.detail(agent.id).turnId!,
    status: "completed",
  });
  const worker = (await app.tool(owner.token, "worker_start", {
    project: "reporter",
    title: name + " reporter",
    spec: "Prepare plot",
    message: "Prepare plot",
  })) as { id: string };
  await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
    message: "Completed.\n\n[Worker chart](plot.png)",
  });
  runtime.emit(worker.id, {
    type: "completed",
    turnId: app.detail(worker.id).turnId!,
    status: "completed",
  });
  await app.tool(owner.token, "worker_close", { workerId: worker.id });
  const service = new HostService(app, {
    directory: join(cwd, "peer"),
    name,
    origin,
  });
  const handler = createHandler(app, { service, assets, origin });
  return { app, runtime, agent, worker, service, handler, emit, turn, history };
}
let peerOrigin = "http://127.0.0.1:14321";
let remote = await unit("Remote", "#367153", () => peerOrigin);
let peerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 14321,
  websocket: groveWebsocket,
  fetch(request, server) {
    const upgraded = createUpgrade(remote.app, {
      service: remote.service,
      origin: () => peerOrigin,
    })(request, server);
    return upgraded === true
      ? undefined
      : (upgraded ?? remote.handler(request));
  },
});
peerOrigin = peerServer.url.origin;
const origin = "http://127.0.0.1:14320";
let local = await unit("Local", "#355d98", () => origin);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14320,
  websocket: groveWebsocket,
  async fetch(request, server) {
    const upgraded = createUpgrade(local.app, {
      service: local.service,
      origin: () => origin,
    })(request, server);
    if (upgraded) return upgraded === true ? undefined : upgraded;
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reset" && request.method === "POST") {
      peerServer.stop(true);
      for (const unit of [local, remote]) {
        unit.service.dispose();
        unit.app.dispose();
      }
      remote = await unit("Remote", "#367153", () => peerOrigin);
      local = await unit("Local", "#355d98", () => origin);
      peerServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 14321,
        websocket: groveWebsocket,
        fetch(request, server) {
          const upgraded = createUpgrade(remote.app, {
            service: remote.service,
            origin: () => peerOrigin,
          })(request, server);
          return upgraded === true
            ? undefined
            : (upgraded ?? remote.handler(request));
        },
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/history" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const target = body.peer === "remote" ? remote : local;
      const title = body.title ?? "Historical reports";
      const project = target.app.detail(target.agent.id).project;
      const threadId = crypto.randomUUID();
      target.runtime.historySessions.set(threadId, {
        threadId,
        title,
        preview: "History chart",
        cwd: project.path,
        role: "session",
        archived: false,
        source: "cli",
        updatedAt: Date.now(),
      });
      target.runtime.names.set(threadId, title);
      target.runtime.historyItems.set(
        threadId,
        body.count
          ? Array.from({ length: body.count }, (_, index) => ({
              id: `history-${index}`,
              role: "assistant" as const,
              text: `${title} item ${index}`,
              at: Date.now(),
            }))
          : [
              {
                id: "historical-link",
                role: "assistant",
                text:
                  "[History chart](reports/plot.png)\n\n" +
                  "Historical paragraph\n\n".repeat(150),
                at: Date.now(),
              },
            ],
      );
      const restored = await target.app.resumeHistory(
        "fixture",
        threadId,
        false,
        defaults,
      );
      return Response.json({
        id: target.service.identity.id + ":" + restored.id,
      });
    }
    if (
      url.pathname === "/fixture/history-control" &&
      request.method === "POST"
    ) {
      const body = await request.json();
      const target = body.peer === "remote" ? remote : local;
      if (body.delay !== undefined) target.history.delay = body.delay;
      if (body.fail !== undefined) target.history.fail = body.fail;
      return Response.json(target.history);
    }
    if (url.pathname === "/fixture/history-live" && request.method === "POST") {
      const { id } = await request.json();
      const target = id.startsWith(remote.service.identity.id + ":")
        ? remote
        : local;
      const agentId = id.split(":")[1];
      await target.app.send(agentId, "Live input", crypto.randomUUID());
      target.runtime.emit(agentId, {
        type: "item",
        turnId: target.app.detail(agentId).turnId!,
        item: {
          id: "live-item",
          type: "agentMessage",
          phase: "final_answer",
          text: "Current live response",
        },
      });
      target.runtime.emit(agentId, {
        type: "completed",
        turnId: target.app.detail(agentId).turnId!,
        status: "completed",
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/offline" && request.method === "POST") {
      peerServer.stop(true);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/info")
      return Response.json({
        local: local.service.identity.id + ":" + local.agent.id,
        remote: remote.service.identity.id + ":" + remote.agent.id,
        remoteOrigin: peerOrigin,
      });
    if (url.pathname === "/fixture/change" && request.method === "POST") {
      const body = await request.json();
      if (body.question) {
        await local.app.send(local.agent.id, "Question", crypto.randomUUID());
        local.runtime.emit(local.agent.id, {
          type: "item",
          turnId: local.app.detail(local.agent.id).turnId!,
          item: {
            id: body.question,
            type: "agentMessage",
            delivery: "async",
            questions: [
              {
                question: body.question + " question",
                options: [{ label: "First" }, { label: "Second" }],
              },
            ],
          },
        });
      } else {
        await local.app.send(
          local.agent.id,
          "Publication",
          crypto.randomUUID(),
        );
        local.emit(crypto.randomUUID(), "Unrelated publication");
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/") {
      const config = [
        {
          id: remote.service.identity.id,
          name: "Remote",
          url: peerOrigin,
          credential: remote.service.credential,
        },
      ];
      const script = `<script>localStorage.setItem('flickgrove/'+location.origin+'/peers',${JSON.stringify(JSON.stringify(config))});</script>`;
      return new Response(
        (await Bun.file(join(assets, "index.html")).text()).replace(
          "<head>",
          "<head>" + script,
        ),
        { headers: { "Content-Type": "text/html" } },
      );
    }
    return local.handler(request);
  },
});
async function cleanup() {
  server.stop(true);
  peerServer.stop(true);
  cdn.stop(true);
  for (const unit of [local, remote]) {
    unit.service.dispose();
    unit.app.dispose();
  }
  await rm(directory, { recursive: true, force: true });
  process.exit();
}
process.on("SIGTERM", () => void cleanup());
process.on("SIGINT", () => void cleanup());
