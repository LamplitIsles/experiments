// Opt-in owned official 0.163 probe: no account, paid provider, or real HOME.
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResponseParser } from "@experiments/codex-tps";
const root = await mkdtemp(join(tmpdir(), "grove-tps-native-"));
console.log("OWNED_ROOT", root);
const bin = process.env.GROVE_CODEX_PATH;
if (!bin)
  throw new Error(
    "Supply the fixed official 0.163 executable through GROVE_CODEX_PATH",
  );
const env = {
  PATH: "/usr/bin:/bin",
  HOME: join(root, "home"),
  CODEX_HOME: join(root, "codex"),
  TMPDIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
};
for (const p of Object.values(env).slice(1))
  await mkdir(p, { recursive: true });
await mkdir(join(root, "checkout"), { recursive: true });
await writeFile(
  join(env.CODEX_HOME, "config.toml"),
  "[features]\nplugins=false\nremote_plugin=false\nplugin_sharing=false\napps=false\nshell_snapshot=false\n",
);
// The SDK merges process.env before these overrides. Explicit undefined values
// prevent inheriting credentials, external SQLite roots or runtime config.
const nativeEnv = {
  ...Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  ),
  ...env,
};
const trace: any[] = [];
let requests = 0;
let completed = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json();
    const n = ++requests;
    trace.push({
      at: Date.now(),
      type: "request",
      n,
      service_tier: body.service_tier,
      model: body.model,
    });
    const item =
      n % 2 === 1
        ? {
            type: "function_call",
            id: `fc${n}`,
            call_id: `call${n}`,
            name: "owned_wait",
            arguments: "{}",
          }
        : {
            type: "message",
            id: `msg${n}`,
            role: "assistant",
            content: [
              { type: "output_text", text: "Owned reply", annotations: [] },
            ],
            status: "completed",
            phase: "final_answer",
          };
    return new Response(
      new ReadableStream({
        async start(c) {
          const send = (e: any) => {
            trace.push({ at: Date.now(), type: e.type, n });
            c.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`),
            );
          };
          await Bun.sleep(350);
          send({ type: "response.created", response: { id: `resp${n}` } });
          await Bun.sleep(250);
          send({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress" },
          });
          if (n % 2 === 0) {
            send({
              type: "response.content_part.added",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
            send({
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "Owned reply",
            });
          }
          await Bun.sleep(200);
          send({ type: "response.output_item.done", output_index: 0, item });
          await Bun.sleep(150);
          send({
            type: "response.completed",
            response: {
              id: `resp${n}`,
              usage: {
                input_tokens: 100,
                output_tokens: 30 + n,
                total_tokens: 130 + n,
                output_tokens_details: { reasoning_tokens: 5 },
              },
            },
          });
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const client = new CodexAppServerClient({
  codexPath: bin,
  cwd: join(root, "checkout"),
  env: nativeEnv,
  capabilities: { experimentalApi: true },
  protocolValidation: "strict",
  clientInfo: {
    name: "owned-tps-probe",
    title: "Owned TPS probe",
    version: "1",
  },
  requestTimeoutMs: 15000,
});
client.onNotification((n) => {
  if (
    ["thread/tokenUsage/updated", "turn/completed", "item/completed"].includes(
      n.method,
    )
  )
    trace.push({ at: Date.now(), ...n });
  if (n.method === "turn/completed") completed++;
});
client.onServerRequest("item/tool/call", async (p) => {
  trace.push({ at: Date.now(), type: "tool-start", ...p });
  await Bun.sleep(2200);
  trace.push({ at: Date.now(), type: "tool-end" });
  return {
    contentItems: [{ type: "inputText", text: "owned wait done" }],
    success: true,
  };
});
try {
  const versionProcess = Bun.spawn([bin, "--version"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = await new Response(versionProcess.stdout).text();
  if ((await versionProcess.exited) !== 0)
    throw new Error("Native version check failed");
  if (!version.includes("0.163.0"))
    throw new Error("Expected fixed native 0.163.0");
  console.log(version.trim());
  await client.connect();
  for (const historyMode of ["paginated", "legacy"] as const) {
    const serviceTier = historyMode === "paginated" ? "priority" : "default";
    const t = await client.threadStart({
      cwd: join(root, "checkout"),
      model: "gpt-6-luna",
      serviceTier,
      historyMode,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      dynamicTools: [
        {
          type: "function",
          name: "owned_wait",
          description: "Owned wait",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      config: {
        model_provider: "owned",
        service_tier: serviceTier,
        "model_providers.owned": {
          name: "owned",
          base_url: `http://127.0.0.1:${provider.port}/v1`,
          wire_api: "responses",
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
        },
        "features.fast_mode": true,
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      },
    });
    trace.push({
      type: "thread",
      response: t,
      historyMode,
      id: t.thread.id,
      at: Date.now(),
    });
    await client.turnStart({
      threadId: t.thread.id,
      serviceTier,
      serviceTierForTurn: serviceTier,
      input: [
        { type: "text", text: "Owned synthetic probe", text_elements: [] },
      ],
    });
    const target = completed + 1;
    for (let i = 0; i < 500 && completed < target; i++) await Bun.sleep(25);
    if (completed < target) throw new Error("turn timeout");
  }
} finally {
  await client.close();
  provider.stop(true);
  await writeFile(join(root, "trace.json"), JSON.stringify(trace, null, 2));
}
async function files(p: string): Promise<string[]> {
  const a = [];
  for (const e of await readdir(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    if (e.isDirectory()) a.push(...(await files(f)));
    else if (e.name.endsWith(".jsonl")) a.push(f);
  }
  return a;
}
for (const f of await files(join(env.CODEX_HOME, "sessions"))) {
  const parser = new ResponseParser();
  for (const l of (await readFile(f, "utf8")).trim().split("\n"))
    parser.push(JSON.parse(l));
  if (
    parser.samples.length !== 2 ||
    parser.samples.some((s) => s.seconds < 0.7 || s.seconds > 1.5)
  )
    throw new Error("Missing or incorrect response timing/tier");
  console.log("NATIVE_SAMPLES", JSON.stringify(parser.samples));
}
console.log("REQUESTS", requests, "COMPLETED", completed);
