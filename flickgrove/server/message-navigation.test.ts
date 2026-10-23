import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspace-store";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { readingHttp } from "./reading-http";
import { FakeRuntime, fixtureProjects } from "./testing";
import type { RuntimeAgent } from "./runtime";
import { encodedBytes, PAGE_BYTES } from "./conversation-reading";
const a = (id: string): RuntimeAgent => ({
  id,
  threadId: `thread-${id}`,
  token: `private-${id}`,
  role: "orc",
  title: id,
  project: fixtureProjects[0],
  model: "sol",
  effort: "high",
  serviceTier: "default",
  state: "idle",
  closed: false,
  messages: [],
  deliveries: [],
  questions: [],
});
test("ledger outline is complete, source-specific, bounded and cold-persistent, without native discovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-outline-"));
  let store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const agent = a("one"),
      other = a("two");
    agent.deliveries = Array.from({ length: 155 }, (_, i) => ({
      id: `op-${i}`,
      source: "user",
      status: i === 1 ? "failed" : "sent",
      text: i === 2 ? "" : "same ".repeat(500),
      images:
        i === 2
          ? [
              {
                id: "owned",
                name: "image",
                width: 1,
                height: 1,
                bytes: 1,
                mediaType: "image/png",
              },
            ]
          : undefined,
      questionIds: [],
      at: i,
    }));
    for (const source of [
      "worker",
      "reviewer",
      "researcher",
      "question",
    ] as const)
      agent.deliveries.push({
        id: source,
        source,
        status: "sent",
        text: "same",
        questionIds: [],
        at: 999,
      });
    other.deliveries = [
      {
        id: "foreign",
        source: "user",
        status: "sent",
        text: "not in this Orc",
        questionIds: [],
        at: 1,
      },
    ];
    store.track(agent, true);
    store.track(other, true);
    store.flush();
    const outline = store.userMessageOutline(agent.id);
    expect(outline).toHaveLength(155);
    expect(outline[0].summary).toHaveLength(240);
    expect(outline[2].images).toBe(1);
    expect(outline[0].operation).not.toBe(outline[1].operation);
    expect(outline[1].status).toBe("failed");
    store.close();
    store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    expect(store.userMessageOutline(agent.id)).toEqual(outline);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("authorized passive target windows bind identity/direction, preserve metadata and reject foreign operations without sends", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-window-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  const origin = "http://127.0.0.1:15551";
  const service = new HostService(app, { directory, origin: () => origin });
  const read = async (path: string, peer = service.identity.id) =>
    (await readingHttp(
      new Request(origin + "/api/read" + path, {
        headers: { Origin: origin, "X-Grove-Peer": peer },
      }),
      service,
      [origin],
    ))!;
  try {
    const one = await app.createOrc("alpha"),
      two = await app.createOrc("alpha");
    await app.send(one.id, "Original", "owned");
    for (let i = 0; i < 120; i++)
      runtime.emit(one.id, {
        type: "item",
        turnId: `t-${i}`,
        item: {
          id: `assistant-${i}`,
          type: "agentMessage",
          text: "x".repeat(12000),
        },
      });
    const inputs = runtime.inputs.length,
      opens = runtime.agents.size;
    const qualified = service.identity.id + ":" + one.id;
    const path = `?agent=${qualified}`;
    expect((await read("/outline" + path, "foreign")).status).toBe(403);
    expect((await read(`/outline?agent=foreign:${one.id}`)).status).toBe(400);
    expect(await (await read("/outline" + path)).json()).toMatchObject([
      { operation: "owned" },
    ]);
    runtime.historyMessages = async () => {
      throw new Error("Forbidden full-history fallback");
    };
    const page = await (
      await read("/window" + path + "&operation=owned")
    ).json();
    expect(page.target).toBe("native-owned");
    expect(page.messages[0].delivery.source).toBe("user");
    expect(encodedBytes(page)).toBeLessThan(PAGE_BYTES);
    expect(
      (
        await read(
          `/window?agent=${service.identity.id}:${two.id}&operation=owned`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await read(
          "/window" +
            path +
            "&cursor=" +
            encodeURIComponent(page.newerCursor) +
            "&direction=older",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await read(
          `/window?agent=${service.identity.id}:${two.id}&cursor=${encodeURIComponent(page.newerCursor)}&direction=newer`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await read(
          "/window" +
            path +
            "&cursor=" +
            encodeURIComponent(page.newerCursor) +
            "x&direction=newer",
        )
      ).status,
    ).toBe(400);
    const newer = await (
      await read(
        "/window" +
          path +
          "&cursor=" +
          encodeURIComponent(page.newerCursor) +
          "&direction=newer",
      )
    ).json();
    expect(newer.messages).toHaveLength(30);
    expect(newer.messages[0].bodyRef).toBeTruthy();
    // The immutable captured target participates in the cursor scope.
    const native = runtime.agents.get(one.id)!;
    // Runtime's copy is deliberately not workspace authority: it cannot redirect reads.
    native.project = { ...native.project, path: "/foreign" };
    expect(
      (
        await read(
          "/window" +
            path +
            "&cursor=" +
            encodeURIComponent(page.newerCursor) +
            "&direction=newer",
        )
      ).status,
    ).toBe(200);
    expect(runtime.inputs.length).toBe(inputs);
    expect(runtime.agents.size).toBe(opens);
  } finally {
    service.dispose();
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("continuations reject changed native/project/environment identities and survive a cold reader with the original authority", async () => {
  const { MessageNavigation } = await import("./message-navigation");
  const navigation = new MessageNavigation(),
    runtime = new FakeRuntime(),
    original = a("bound");
  original.project = {
    ...original.project,
    environment: { id: "remote", name: "Owned", target: "original-target" },
  };
  original.deliveries = [
    {
      id: "operation",
      source: "user",
      text: "Original",
      status: "uncertain",
      at: 1,
      questionIds: [],
    },
  ];
  runtime.historyItems.set(
    original.threadId!,
    Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      clientId: i === 30 ? "operation" : undefined,
      role: i === 30 ? "user" : "assistant",
      text: "Original",
      at: i,
    })),
  );
  const page = await navigation.read(runtime, original, {
    operation: "operation",
  });
  let reads = 0;
  const read = runtime.messageWindow.bind(runtime);
  runtime.messageWindow = async (...args) => {
    reads++;
    return read(...args);
  };
  for (const changed of [
    { ...original, id: "other" },
    { ...original, threadId: "other" },
    { ...original, backend: "pi" as const },
    { ...original, project: { ...original.project, path: "/other" } },
    {
      ...original,
      project: {
        ...original.project,
        environment: { ...original.project.environment!, id: "other" },
      },
    },
    {
      ...original,
      project: {
        ...original.project,
        environment: {
          ...original.project.environment!,
          target: "replacement",
        },
      },
    },
  ])
    await expect(
      navigation.read(runtime, changed, {
        cursor: page.newerCursor!,
        direction: "newer",
      }),
    ).rejects.toThrow("scope mismatch");
  expect(reads).toBe(0);
  const cold = new MessageNavigation();
  expect(
    (
      await cold.read(runtime, original, {
        cursor: page.newerCursor!,
        direction: "newer",
      })
    ).messages,
  ).toHaveLength(30);
  expect(original.deliveries[0].status).toBe("uncertain");
});
