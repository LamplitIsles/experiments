import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { servePeer, createHandler } from "./http";
import { FakeRuntime } from "./testing";
import { fakeVoiceProvider } from "../tests/voice-fixture";
import { socketWithHeaders } from "./socket-testing";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "grove-voice-test-"));
  const configPath = join(directory, "config.toml"),
    keyPath = join(directory, "key");
  await writeFile(configPath, '[voice]\napi_key_file="key"\n');
  await writeFile(keyPath, "synthetic-key\n", { mode: 0o600 });
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime: new FakeRuntime(),
    projects: async () => [],
    branches: { read: async () => null },
  });
  let origin = "";
  const service = new HostService(app, {
    directory: join(directory, "state"),
    origin: () => origin,
  });
  const provider = fakeVoiceProvider();
  const voice = {
    configPath,
    connect: provider.connect,
    timeouts: { startup: 150, finish: 150, lifetime: 500 },
  };
  const server = servePeer(app, {
    hostname: "127.0.0.1",
    port: 0,
    origin: () => origin,
    service,
    voice,
  });
  origin = server.url.origin;
  cleanup = async () => {
    server.stop(true);
    provider.stop();
    service.dispose();
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  };
  function capability(headers: Record<string, string> = {}, method = "GET") {
    return fetch(origin + "/api/voice/capability", {
      method,
      headers: {
        Origin: origin,
        "X-Grove-Peer": service.identity.id,
        ...headers,
      },
    });
  }
  function stream(headers: Record<string, string> = {}) {
    const ws = socketWithHeaders(
      origin.replace(/^http/, "ws") + "/api/voice/stream",
      {
        Origin: origin,
        "Sec-WebSocket-Protocol": `grove-voice.v1, grove-peer.${service.identity.id}`,
        ...headers,
      },
    );
    const frames: any[] = [];
    let close = false;
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    ws.onclose = () => {
      close = true;
    };
    ws.onerror = () => {};
    return {
      ws,
      frames,
      get closed() {
        return close;
      },
    };
  }
  return {
    directory,
    configPath,
    keyPath,
    app,
    service,
    provider,
    voice,
    server,
    origin,
    capability,
    stream,
  };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
};

test("voice configuration reads relative private files per request and fails closed without affecting text", async () => {
  const f = await fixture();
  expect(await (await f.capability()).json()).toEqual({ available: true });
  await writeFile(f.configPath, "");
  expect(await (await f.capability()).json()).toEqual({
    available: false,
    reason: "voice_disabled",
  });
  for (const content of [
    "[voice]\napi_key_file=5",
    '[voice]\napi_key_file="missing"',
    '[voice]\napi_key_file=""',
  ]) {
    await writeFile(f.configPath, content);
    expect(await (await f.capability()).json()).toEqual({
      available: false,
      reason: "config_unavailable",
    });
  }
  await writeFile(
    f.configPath,
    `[voice]\napi_key_file=${JSON.stringify(f.keyPath)}`,
  );
  await chmod(f.keyPath, 0o644);
  expect((await (await f.capability()).json()).available).toBe(false);
  await chmod(f.keyPath, 0o600);
  for (const key of ["", "two\nkeys", "x".repeat(1025)]) {
    await writeFile(f.keyPath, key);
    expect((await (await f.capability()).json()).available).toBe(false);
  }
  await writeFile(f.keyPath, new Uint8Array([255, 254]));
  expect((await (await f.capability()).json()).available).toBe(false);
  expect((await fetch(f.origin + "/api/identity")).status).toBe(200);
  await writeFile(f.keyPath, "rotated-synthetic-key");
  const s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  expect(f.provider.stats.authorization.at(-1)).toBe(
    "Bearer rotated-synthetic-key",
  );
  s.ws.send('{"type":"cancel"}');
  await until(() => s.closed && f.provider.active === 0);
});

test("capability and stream enforce target, same-origin, credential, CORS and Peer identity", async () => {
  const f = await fixture(),
    foreign = "https://other-peer.example";
  expect((await f.capability({ Origin: foreign })).status).toBe(401);
  expect(
    (await f.capability({ Authorization: "Bearer agent-mcp-token" })).status,
  ).toBe(401);
  expect((await f.capability({ "X-Grove-Peer": "wrong" })).status).toBe(403);
  const response = await f.capability({
    Origin: foreign,
    Authorization: `Bearer ${f.service.credential}`,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(foreign);
  expect(response.headers.get("x-grove-peer")).toBe(f.service.identity.id);
  expect(JSON.stringify(await response.json())).not.toContain("synthetic-key");
  const preflight = await f.capability(
    {
      Origin: foreign,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-grove-peer",
    },
    "OPTIONS",
  );
  expect(preflight.status).toBe(204);
  expect((await f.capability({ Origin: "null" })).status).toBe(403);
  expect(
    (
      await f.capability(
        {
          Origin: foreign,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-secret",
        },
        "OPTIONS",
      )
    ).status,
  ).toBe(403);
  const handler = createHandler(f.app, {
    origin: () => f.origin,
    service: f.service,
    voice: f.voice,
  });
  expect(
    (
      await handler(
        new Request("http://wrong.example/api/voice/capability", {
          headers: { Origin: f.origin, "X-Grove-Peer": f.service.identity.id },
        }),
      )
    ).status,
  ).toBe(403);
  for (const protocols of [
    `grove-voice.v1, grove-peer.wrong`,
    `grove-voice.v1, grove-peer.${f.service.identity.id}, grove-auth.wrong`,
  ]) {
    const s = f.stream({
      Origin: foreign,
      "Sec-WebSocket-Protocol": protocols,
    });
    await until(() => s.closed);
    expect(s.frames).toEqual([]);
  }
  expect(f.provider.stats.runs).toEqual([]);
  const s = f.stream({
    Origin: foreign,
    "Sec-WebSocket-Protocol": `grove-voice.v1, grove-peer.${f.service.identity.id}, grove-auth.${f.service.credential}`,
  });
  await until(() => s.frames[0]?.type === "ready");
  expect(s.ws.protocol).toBe("grove-voice.v1");
  s.ws.close();
  await until(() => f.provider.active === 0);
});

test("real listener gates PCM, fixes provider task, returns sorted deduplicated final text and releases", async () => {
  const f = await fixture(),
    s = f.stream();
  await until(() => s.frames.length === 1);
  expect(s.frames).toEqual([{ type: "ready", peerId: f.service.identity.id }]);
  const run = f.provider.stats.runs[0];
  expect(run.payload).toEqual({
    task_group: "audio",
    task: "asr",
    function: "recognition",
    model: "qwen-audio-3.1-asr-flash-streaming",
    parameters: {
      format: "pcm",
      sample_rate: 16000,
      semantic_punctuation_enabled: false,
      max_sentence_silence: 400,
    },
    input: {},
  });
  await writeFile(f.keyPath, "new-key");
  s.ws.send(new Uint8Array(3200));
  s.ws.send('{"type":"finish"}');
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.at(-1)).toEqual({ type: "result", text: "你好世界" });
  expect(f.provider.stats.authorization).toEqual(["Bearer synthetic-key"]);
  expect(f.provider.stats.bytes).toBe(3200);
  expect(f.provider.stats.finishes).toBe(1);
});

test("cancel, disconnect, provider failure, malformed results and all timeout phases release upstream", async () => {
  for (const mode of [
    "failure",
    "empty",
    "unfinished",
    "wrong-task",
    "oversized",
    "large-text",
    "hold-start",
    "hold-finish",
  ]) {
    const f = await fixture();
    f.provider.mode(mode);
    const s = f.stream();
    if (!["wrong-task", "oversized", "hold-start"].includes(mode)) {
      await until(() => s.frames[0]?.type === "ready");
      s.ws.send(new Uint8Array(3200));
      s.ws.send('{"type":"finish"}');
    }
    await until(() => s.closed && f.provider.active === 0);
    expect(s.frames.at(-1)?.type).toBe("error");
    expect(JSON.stringify(s.frames)).not.toContain("MUST NOT leak");
    await cleanup?.();
    cleanup = undefined;
  }
  const f = await fixture();
  let s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  s.ws.send('{"type":"cancel"}');
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.length).toBe(1);
  s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  s.ws.close();
  await until(() => f.provider.active === 0);
  s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.at(-1)).toEqual({ type: "error", code: "timeout" });
});

test("representative PCM/control limits and startup gate reject and close", async () => {
  const f = await fixture();
  for (const frame of [
    new Uint8Array(0),
    new Uint8Array(3),
    new Uint8Array(16 * 1024 + 2),
    '{"type":"finish"}',
    '{"type":"finish","extra":true}',
    "x".repeat(129),
  ]) {
    const s = f.stream();
    await until(() => s.frames[0]?.type === "ready");
    s.ws.send(frame);
    await until(() => s.closed && f.provider.active === 0);
    expect(s.frames.at(-1)).toEqual({ type: "error", code: "invalid_audio" });
  }
  f.provider.mode("hold-start");
  const s = f.stream();
  await until(() => s.ws.readyState === WebSocket.OPEN);
  s.ws.send(new Uint8Array(3200));
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.at(-1)?.code).toBe("invalid_audio");
});

test("PCM total budget and upstream queue limit close the real relay without forwarding excess", async () => {
  const f = await fixture();
  f.voice.timeouts.lifetime = 5000;
  let s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  const frame = new Uint8Array(16000);
  for (let sent = 0; sent < 600;) {
    const end = Math.min(sent + 16, 600);
    for (; sent < end; sent++) s.ws.send(frame);
    await until(() => f.provider.stats.bytes === sent * frame.byteLength);
  }
  s.ws.send(new Uint8Array(2));
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.at(-1)).toEqual({ type: "error", code: "invalid_audio" });
  expect(f.provider.stats.bytes).toBe(9_600_000);
  let full = false;
  f.voice.connect = (key) => {
    const upstream = f.provider.connect(key);
    Object.defineProperty(upstream, "bufferedAmount", {
      get: () => (full ? 256 * 1024 : 0),
    });
    return upstream;
  };
  s = f.stream();
  await until(() => s.frames[0]?.type === "ready");
  full = true;
  s.ws.send(new Uint8Array(3200));
  await until(() => s.closed && f.provider.active === 0);
  expect(s.frames.at(-1)).toEqual({ type: "error", code: "invalid_audio" });
  expect(f.provider.stats.bytes).toBe(9_600_000);
});
