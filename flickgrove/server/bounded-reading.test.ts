import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import sharp from "sharp";
import { DeliveryRejected } from "./runtime";
import { HostService, qualify } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { servePeer } from "./http";
import { openGrove, MAX_FRAME } from "../src/chord-client";
import { socketWithHeaders } from "./socket-testing";
import { encodedBytes, LIVE_BYTES, PAGE_BYTES } from "./conversation-reading";
import type { Message, Detail } from "../src/contracts";
import type { View } from "../src/chord-contract";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-bounded-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const server = servePeer(app, {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => {
    server.stop(true);
    service.dispose();
    app.dispose();
    rmSync(directory, { force: true, recursive: true });
  });
  const request = (path: string, headers: Record<string, string> = {}) =>
    fetch(origin + "/api/read" + path, {
      headers: {
        Origin: "http://other-peer.example",
        Authorization: `Bearer ${service.credential}`,
        "X-Grove-Peer": service.identity.id,
        ...headers,
      },
    });
  return { directory, runtime, app, service, origin, request };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition timed out");
}
test("native client identity associates equal reports in one turn across arrival/admission order, legacy and restart", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  const text = "same body";
  await f.app.send(a.id, text, "first");
  await f.app.send(a.id, text, "second");
  expect(f.runtime.inputs.map((i) => i.clientId)).toEqual(["first", "second"]);
  // Receiving a native item before a lost RPC response is accepted evidence.
  f.runtime.sendOverride = async (id, input, turnId) => {
    f.runtime.emit(id, {
      type: "item",
      turnId: turnId!,
      item: {
        id: "native-before-result",
        type: "userMessage",
        clientId: "race",
        text: input,
      },
    });
    throw new Error("lost response");
  };
  await f.app.send(a.id, text, "race");
  expect(f.app.lookup(a.id, "race")?.state).toBe("accepted");
  expect(
    f.app.detail(a.id).messages.filter((m) => m.clientId === "race"),
  ).toHaveLength(1);
  f.runtime.sendOverride = undefined;
  const worker = (await f.app.tool(
    f.runtime.agents.get(a.id)!.token,
    "worker_start",
    { project: "alpha", title: "Evidence", spec: "fixture", message: "task" },
  )) as Detail;
  const token = f.runtime.agents.get(worker.id)!.token;
  await f.app.tool(token, "worker_report", { message: text });
  await f.app.tool(token, "worker_report", { message: text });
  const reports = (await f.app.agentHistory(a.id)).messages.filter(
    (m) => m.delivery?.source === "worker",
  );
  expect(reports).toHaveLength(2);
  expect(reports[0].text).toBe(reports[1].text);
  expect(reports[0].clientId).not.toBe(reports[1].clientId);
  expect(reports[0].turnId).toBe(reports[1].turnId);
  expect(
    reports.every((m) => m.delivery?.reportingWorkerId === worker.id),
  ).toBe(true);
  const items = f.runtime.historyItems.get(a.threadId!)!;
  items.unshift({
    id: "legacy",
    role: "user",
    text: reports[0].text,
    turnId: reports[0].turnId,
    at: 1,
  });
  expect(
    (await f.app.agentHistory(a.id)).messages.find((m) => m.id === "legacy")
      ?.delivery,
  ).toBeUndefined();
  f.runtime.emit(worker.id, {
    type: "completed",
    turnId: f.app.detail(worker.id).turnId!,
    status: "completed",
  });
  await f.app.tool(f.runtime.agents.get(a.id)!.token, "worker_close", {
    workerId: worker.id,
  });
  f.app.dispose();
  const restoredRuntime = new FakeRuntime();
  for (const [thread, items] of f.runtime.historyItems)
    restoredRuntime.historyItems.set(thread, structuredClone(items));
  const restored = new Workspace({
    directory: f.directory,
    runtime: restoredRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  const restoredReports = (await restored.agentHistory(a.id)).messages.filter(
    (m) => m.delivery?.source === "worker",
  );
  expect(
    restoredReports.map((m) => [
      m.id,
      m.clientId,
      m.delivery?.reportingWorkerId,
    ]),
  ).toEqual(reports.map((m) => [m.id, m.clientId, worker.id]));
  expect(restoredRuntime.inputs).toHaveLength(0);
});
test("actual owning-Peer HTTP rejects unauthorized/mismatched reads, admits preflight and pages every budget boundary", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  const id = qualify(f.service.identity.id, a.id);
  const messages: Message[] = Array.from({ length: 121 }, (_, i) => ({
    id: `item-${i}`,
    turnId: "one-giant-turn",
    role: i % 2 ? "assistant" : "user",
    text: `item ${i}: ` + '中文\\"'.repeat(i === 55 ? 500000 : 10000),
    at: i + 1,
  }));
  f.runtime.historyItems.set(a.threadId!, messages);
  const path = `/messages?agent=${encodeURIComponent(id)}`;
  expect((await f.request(path, { Authorization: "" })).status).toBe(401);
  expect((await f.request(path, { "X-Grove-Peer": "wrong" })).status).toBe(403);
  expect((await f.request(`/messages?agent=other:${a.id}`)).status).toBe(400);
  const preflight = await fetch(f.origin + "/api/read" + path, {
    method: "OPTIONS",
    headers: {
      Origin: "http://other-peer.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-grove-peer",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://other-peer.example",
  );
  expect((await f.request(path, { Origin: "null" })).status).toBe(403);
  let cursor: string | null = null;
  let combined: Message[] = [],
    pages = 0;
  do {
    const response = await f.request(
      path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
    expect(response.ok).toBe(true);
    const raw = await response.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    const page = JSON.parse(raw);
    expect(page.messages.length).toBeLessThanOrEqual(100);
    combined = [...page.messages, ...combined];
    cursor = page.nextCursor;
    pages++;
    if (pages === 1)
      messages.push({
        id: "new-during-read",
        role: "assistant",
        text: "new",
        at: 999,
      });
  } while (cursor);
  expect(pages).toBeGreaterThan(3);
  expect(combined.map((m) => m.id)).toEqual(
    messages.slice(0, -1).map((m) => m.id),
  );
  const huge = combined.find((m) => m.id === "item-55")!;
  expect(huge.text).toBe("");
  expect(huge.bodyRef).toBe("item-55");
  const body = await f.request(
    `/body?agent=${encodeURIComponent(id)}&item=${huge.id}`,
  );
  expect((await body.json()).text).toBe(messages[55].text);
  const preview = await f.request(
    `/messages?project=alpha&thread=${a.threadId}`,
  );
  expect(preview.ok).toBe(true);
  expect(
    (await f.request(`/body?project=beta&thread=${a.threadId}&item=item-55`))
      .ok,
  ).toBe(false);
});
test("full real Chord frames stay bounded on select, continuous growth, reselection and reconnect with large recovery journal", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  const id = qualify(f.service.identity.id, a.id);
  const thread = a.threadId!;
  f.runtime.historyItems.set(
    thread,
    Array.from({ length: 160 }, (_, i) => ({
      id: `old-${i}`,
      role: "assistant",
      text: "x".repeat(40000),
      at: i + 1,
    })),
  );
  let view: View | undefined,
    disconnected = 0;
  const sizes: number[] = [];
  async function connect() {
    const socket = socketWithHeaders(
      f.origin.replace(/^http/, "ws") + "/api/socket",
      { Origin: f.origin },
    );
    socket.addEventListener("message", (e) =>
      sizes.push(new TextEncoder().encode(String(e.data)).length),
    );
    const client = await openGrove(
      socket,
      (v) => {
        view = v;
      },
      () => disconnected++,
    );
    cleanups.push(() => client.close());
    await client.call("select", { ids: [id] });
    return client;
  }
  const client = await connect();
  await until(() => !!view?.details[id]);
  expect(encodedBytes(view!.details[id].messages)).toBeLessThanOrEqual(
    LIVE_BYTES,
  );
  expect(view!.details[id].messages.at(-1)?.id).toBe("old-159");
  for (let i = 0; i < 130; i++) {
    const message: Message = {
      id: `live-${i}`,
      role: "assistant",
      text: "y".repeat(i === 129 ? 3000000 : 40000),
      at: 200 + i,
    };
    f.runtime.historyItems.get(thread)!.push(message);
    const turnId = `live-turn-${i}`;
    f.runtime.emit(a.id, { type: "working", turnId });
    f.runtime.emit(a.id, {
      type: "item",
      turnId,
      item: {
        type: "agentMessage",
        phase: "final_answer",
        id: message.id,
        text: message.text,
      },
    });
    f.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
    if (i % 10 === 0) await Bun.sleep(5);
  }
  await until(() => view?.details[id]?.messages.at(-1)?.id === "live-129");
  expect(view!.details[id].messages.at(-1)?.bodyRef).toBe("live-129");
  f.runtime.sendOverride = async () => {
    throw new Error("unknown");
  };
  for (let i = 0; i < 105; i++) {
    await f.app.send(a.id, "recover me".repeat(3000), `unknown-${i}`);
    if (i % 5 === 0) await Bun.sleep(5);
  }
  f.runtime.emit(a.id, { type: "working", turnId: "question-turn" });
  f.runtime.emit(a.id, {
    type: "item",
    turnId: "question-turn",
    item: {
      id: "questions",
      type: "agentMessage",
      delivery: "async",
      questions: Array.from({ length: 120 }, () => ({
        question: "question".repeat(10000),
        options: [{ label: "A", description: "description".repeat(5000) }],
      })),
    },
  });
  await client.call("select", { ids: [] });
  await client.call("select", { ids: [id] });
  expect(disconnected).toBe(0);
  expect(f.app.lookup(a.id, "unknown-0")).toBeNull();
  expect(
    (
      await (
        await f.request(
          `/recovery?agent=${encodeURIComponent(id)}&operation=unknown-0`,
        )
      ).json()
    ).text,
  ).toBe("recover me".repeat(3000));
  expect(
    (
      await (
        await f.request(`/questions?agent=${encodeURIComponent(id)}`)
      ).json()
    ).length,
  ).toBe(120);
  client.close();
  const newer: Message = {
    id: "offline-arrival",
    role: "assistant",
    text: "arrived while disconnected",
    at: 999,
  };
  f.runtime.historyItems.get(thread)!.push(newer);
  await connect();
  await until(() => view?.details[id]?.messages.at(-1)?.id === newer.id);
  expect(Math.max(...sizes)).toBeLessThan(MAX_FRAME / 2);
  console.log(
    `bounded Chord: ${sizes.length} real frames, maximum ${Math.max(...sizes)} bytes; limit ${MAX_FRAME}`,
  );
}, 60000);
test("selection merges arrivals during native read; late native item replaces only its operation after admission", async () => {
  const f = fixture();
  const open = f.runtime.open.bind(f.runtime);
  f.runtime.open = async (a, notify) => {
    const handle = await open(a, notify);
    return { ...handle, send: async () => "race-turn" };
  };
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "repeat body", "after-admission");
  expect(f.app.detail(a.id).messages.map((m) => m.id)).toEqual([
    "after-admission",
  ]);
  f.runtime.emit(a.id, {
    type: "item",
    turnId: "race-turn",
    item: {
      id: "after-native",
      type: "userMessage",
      clientId: "after-admission",
      text: "repeat body",
    },
  });
  expect(f.app.detail(a.id).messages.map((m) => m.id)).toEqual([
    "after-native",
  ]);
  f.runtime.historyItems.set(a.threadId!, [
    { id: "older", role: "assistant", text: "older", at: 1 },
    {
      id: "after-native",
      clientId: "after-admission",
      turnId: "race-turn",
      role: "user",
      text: "repeat body",
      at: 2,
    },
  ]);
  const gate = Promise.withResolvers<void>();
  const read = f.runtime.historyMessages.bind(f.runtime);
  f.runtime.historyMessages = async (thread, cursor) => {
    const page = structuredClone(await read(thread, cursor));
    await gate.promise;
    return page;
  };
  const selecting = f.app.synchronizeDetail(a.id);
  await Bun.sleep(5);
  f.runtime.emit(a.id, {
    type: "item",
    turnId: "race-turn",
    item: {
      id: "during-read",
      type: "userMessage",
      clientId: "external",
      text: "new while native read in flight",
    },
  });
  gate.resolve();
  const detail = await selecting;
  expect(detail.messages.map((m) => m.id)).toEqual([
    "older",
    "after-native",
    "during-read",
  ]);
  expect(
    detail.messages.filter((m) => m.clientId === "after-admission"),
  ).toHaveLength(1);
});

test("native history confirms an unknown operation outside the realtime window without replay", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  f.runtime.sendOverride = async () => {
    throw new Error("response unknown");
  };
  await f.app.send(a.id, "older accepted body", "old-operation");
  expect(f.app.lookup(a.id, "old-operation")).toBeNull();
  f.runtime.historyItems.set(a.threadId!, [
    {
      id: "accepted-native",
      clientId: "old-operation",
      role: "user",
      text: "older accepted body",
      at: 1,
    },
    ...Array.from({ length: 120 }, (_, i) => ({
      id: `newer-${i}`,
      role: "assistant" as const,
      text: "newer",
      at: 2 + i,
    })),
  ]);
  await f.app.synchronizeDetail(a.id);
  expect(f.app.lookup(a.id, "old-operation")).toBeNull();
  let cursor: string | undefined;
  do {
    const page = await f.app.agentHistory(a.id, cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(f.app.lookup(a.id, "old-operation")?.state).toBe("accepted");
  expect(f.runtime.inputs).toHaveLength(1);
  await expect(
    f.app.deleteFailedSubmission(a.id, "old-operation"),
  ).rejects.toThrow("rejected");
});

test("native CLI images are restored before select/reconnect projection and remain owning-Peer readable", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "open", "open");
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  let restores = 0;
  Object.assign(f.runtime, {
    historyImage: async (thread: string, image: string) => {
      expect(thread).toBe(a.threadId!);
      expect(image).toBe("b".repeat(64));
      restores++;
      return restores === 1
        ? new File([bytes], "cli.png", { type: "image/png" })
        : null;
    },
  });
  f.runtime.historyItems.set(a.threadId!, [
    {
      id: "cli-image",
      role: "user",
      text: "CLI caption",
      at: 1,
      images: [
        {
          id: "b".repeat(64),
          name: "Native message image",
          width: 1,
          height: 1,
          bytes: 0,
          mediaType: "image/png",
          availability: "missing",
        },
      ],
    },
  ]);
  const id = qualify(f.service.identity.id, a.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    let view: View | undefined;
    const client = await openGrove(
      socketWithHeaders(f.origin.replace(/^http/, "ws") + "/api/socket", {
        Origin: f.origin,
      }),
      (v) => {
        view = v;
      },
      () => {},
    );
    cleanups.push(() => client.close());
    await client.call("select", { ids: [id] });
    await until(() => !!view?.details[id]);
    const message = view!.details[id].messages.find(
      (m) => m.id === "cli-image",
    )!;
    expect(message.images![0].availability).toBeUndefined();
    expect(message.images![0].width).toBe(8);
    expect(encodedBytes(view!.details[id].messages)).toBeLessThanOrEqual(
      LIVE_BYTES,
    );
    const media = await fetch(
      `${f.origin}/api/images/${message.images![0].id}/original?agent=${encodeURIComponent(id)}`,
      { headers: { Origin: f.origin, "X-Grove-Peer": f.service.identity.id } },
    );
    expect(media.ok).toBe(true);
    expect(
      await sharp(Buffer.from(await media.arrayBuffer()))
        .raw()
        .toBuffer(),
    ).toEqual(await sharp(bytes).raw().toBuffer());
    const http = await (
      await f.request(`/messages?agent=${encodeURIComponent(id)}`)
    ).json();
    expect(http.messages[0].images).toEqual(message.images);
    client.close();
  }
  expect(restores).toBe(1);
});

test("recovery cursor survives confirmation and deletion including its anchor without skipping ledger identities", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("fixture refusal");
  };
  for (let i = 0; i < 251; i++)
    await f.app.send(a.id, `complete recovery ${i}`, `recovery-${i}`);
  const id = qualify(f.service.identity.id, a.id),
    path = `/deliveries?agent=${encodeURIComponent(id)}`;
  const first = await (await f.request(path)).json();
  expect(first.deliveries).toHaveLength(100);
  for (const d of first.deliveries.slice(0, 10))
    f.runtime.emit(a.id, {
      type: "item",
      turnId: "accepted",
      item: {
        type: "userMessage",
        id: `native-${d.id}`,
        clientId: d.id,
        text: f.app.recovery(a.id, d.id).text,
      },
    });
  for (const d of [...first.deliveries.slice(10, 16), first.deliveries.at(-1)])
    await f.app.deleteFailedSubmission(a.id, d.id);
  const seen = [...first.deliveries];
  let cursor = first.nextCursor;
  do {
    const page = await (
      await f.request(path + `&cursor=${encodeURIComponent(cursor)}`)
    ).json();
    for (const d of page.deliveries) {
      const full = await (
        await f.request(
          `/recovery?agent=${encodeURIComponent(id)}&operation=${d.id}`,
        )
      ).json();
      expect(full.text).toBe(
        `complete recovery ${d.id.slice("recovery-".length)}`,
      );
    }
    seen.push(...page.deliveries);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toHaveLength(251);
  expect(new Set(seen.map((d) => d.id)).size).toBe(251);
  expect(new Set(seen.map((d) => d.id))).toEqual(
    new Set(Array.from({ length: 251 }, (_, i) => `recovery-${i}`)),
  );
  expect(
    (
      await f.request(
        path + "&cursor=" + Buffer.from("0").toString("base64url"),
      )
    ).status,
  ).toBe(400);
});

test("same-turn question answers follow their question, provisional replacements retain position and late events follow native order", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  const turn = f.app.detail(a.id).turnId!;
  f.runtime.emit(a.id, {
    type: "item",
    turnId: turn,
    item: {
      id: "question",
      type: "agentMessage",
      delivery: "async",
      text: "Choose a color",
      questions: [{ question: "Which color?" }],
    },
  });
  await f.app.answerBatch(
    a.id,
    [{ questionId: "question:0", answer: "Blue" }],
    "answer",
  );
  expect(f.app.detail(a.id).messages.map((m) => m.id)).toEqual([
    "native-start",
    "question",
    "native-answer",
  ]);
  expect(f.runtime.inputs.at(-1)?.turnId).toBe(turn);
  // New fixture isolates admission-before-notification.
  const late = fixture();
  const open = late.runtime.open.bind(late.runtime);
  late.runtime.open = async (a, notify) => ({
    ...(await open(a, notify)),
    send: async () => "late-turn",
  });
  const b = await late.app.createOrc("alpha");
  await late.app.send(b.id, "initial", "initial");
  late.runtime.emit(b.id, {
    type: "item",
    turnId: "late-turn",
    item: {
      id: "later-question",
      type: "agentMessage",
      delivery: "async",
      text: "Question",
      questions: [{ question: "Choose?" }],
    },
  });
  late.runtime.emit(b.id, {
    type: "item",
    turnId: "late-turn",
    item: {
      id: "initial-native",
      clientId: "initial",
      type: "userMessage",
      text: "initial",
    },
  });
  expect(late.app.detail(b.id).messages.map((m) => m.id)).toEqual([
    "initial-native",
    "later-question",
  ]);
  // No provisional match: delivery order may be late; consult native item order.
  late.runtime.historyItems.set(b.threadId!, [
    {
      id: "external-native",
      role: "user",
      text: "earlier external input",
      turnId: "late-turn",
      at: 1,
    },
    ...late.app.detail(b.id).messages,
  ]);
  late.runtime.emit(b.id, {
    type: "item",
    turnId: "late-turn",
    item: {
      id: "external-native",
      type: "userMessage",
      text: "earlier external input",
    },
  });
  await until(
    () => late.app.detail(b.id).messages[0]?.id === "external-native",
  );
  expect(late.app.detail(b.id).messages.map((m) => m.id)).toEqual([
    "external-native",
    "initial-native",
    "later-question",
  ]);
  expect(
    late.app.detail(b.id).messages.filter((m) => m.clientId === "initial"),
  ).toHaveLength(1);
});
