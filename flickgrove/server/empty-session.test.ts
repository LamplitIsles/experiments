import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent } from "./runtime";
async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "grove-spec3758-empty-runtime-"),
  );
  const controls = join(directory, ".fake-app-server-control.json");
  await writeFile(controls, JSON.stringify({ emptyItemsUnsupported: true }));
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://127.0.0.1:1",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      PATH: process.env.PATH,
      HOME: join(directory, "home"),
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
    },
  });
  const agent: RuntimeAgent = {
    id: "fixture",
    token: "fixture-token",
    role: "orc",
    project: { alias: "fixture", name: "Fixture", path: directory },
    title: "Fixture",
    model: "fixture-model",
    effort: "medium",
    serviceTier: "default",
    state: "idle",
    closed: false,
    messages: [],
    deliveries: [],
    questions: [],
  };
  return {
    runtime,
    agent,
    controls,
    async requests() {
      return (
        await readFile(
          join(directory, ".fake-app-server-requests.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("known-empty native reading ends with first send; existing unsupported errors are not empty success", async () => {
  const f = await fixture();
  try {
    const handle = await f.runtime.open(f.agent, () => {});
    expect(await f.runtime.historyMessages(handle.threadId)).toEqual({
      messages: [],
      nextCursor: null,
    });
    expect(
      (await f.requests()).filter((r) => r.method === "thread/items/list"),
    ).toHaveLength(0);
    await handle.send("First native input", undefined, [], "first-input");
    expect(
      (await f.runtime.historyMessages(handle.threadId)).messages.some(
        (m) => m.text === "First native input" && m.clientId === "first-input",
      ),
    ).toBe(true);
    await writeFile(f.controls, JSON.stringify({ itemsUnsupported: true }));
    await expect(f.runtime.historyMessages(handle.threadId)).rejects.toThrow(
      "JSON-RPC error -32601: thread/items/list is not supported yet",
    );
  } finally {
    await f.close();
  }
});
test("known-empty ownership is released on handle close and runtime replacement; restored history is read", async () => {
  const f = await fixture();
  try {
    const handle = await f.runtime.open(f.agent, () => {});
    expect((await f.runtime.historyMessages(handle.threadId)).messages).toEqual(
      [],
    );
    await handle.close();
    await expect(f.runtime.historyMessages(handle.threadId)).rejects.toThrow(
      "-32601",
    );
    const second = await f.runtime.open({ ...f.agent, id: "second" }, () => {});
    expect((await f.runtime.historyMessages(second.threadId)).messages).toEqual(
      [],
    );
    await f.runtime.close();
    await expect(f.runtime.historyMessages(second.threadId)).rejects.toThrow(
      "-32601",
    );
    await writeFile(
      f.controls,
      JSON.stringify({
        historyItems: [
          {
            turnId: "saved-turn",
            item: {
              type: "userMessage",
              id: "saved-input",
              clientId: "saved-operation",
              content: [
                {
                  type: "text",
                  text: "Saved native history",
                  text_elements: [],
                },
              ],
            },
          },
        ],
      }),
    );
    const restored = await f.runtime.open(
      { ...f.agent, threadId: handle.threadId },
      () => {},
    );
    expect(
      (await f.runtime.historyMessages(restored.threadId)).messages,
    ).toMatchObject([
      {
        id: "saved-input",
        text: "Saved native history",
        clientId: "saved-operation",
      },
    ]);
    await writeFile(f.controls, JSON.stringify({ itemsUnsupported: true }));
    await expect(f.runtime.historyMessages(restored.threadId)).rejects.toThrow(
      "-32601",
    );
  } finally {
    await f.close();
  }
});

test("pending first admission invalidates empty reading without replaying the original input", async () => {
  const f = await fixture();
  let sending: Promise<string> | undefined;
  try {
    const handle = await f.runtime.open(f.agent, () => {});
    await writeFile(
      f.controls,
      JSON.stringify({ emptyItemsUnsupported: true, holdTurnAdmission: true }),
    );
    sending = handle.send(
      "Pending native input",
      undefined,
      [],
      "pending-operation",
    );
    for (let i = 0; i < 200; i++) {
      if ((await f.requests()).some((r) => r.method === "turn/start")) break;
      await Bun.sleep(5);
    }
    expect(
      (await f.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
    await expect(f.runtime.historyMessages(handle.threadId)).rejects.toThrow(
      "-32601",
    );
    await writeFile(
      f.controls,
      JSON.stringify({ emptyItemsUnsupported: true }),
    );
    await sending;
    expect(
      (await f.runtime.historyMessages(handle.threadId)).messages.some(
        (m) => m.clientId === "pending-operation",
      ),
    ).toBe(true);
    expect(
      (await f.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await f.runtime.close();
    await sending?.catch(() => {});
    await f.close();
  }
});

test("native input notification invalidates known emptiness without a Grove send", async () => {
  const f = await fixture();
  try {
    let arrived = false;
    const handle = await f.runtime.open(f.agent, (event) => {
      if (event.type === "item") arrived = true;
    });
    const item = {
      type: "userMessage",
      id: "native-external",
      clientId: "external-input",
      content: [
        { type: "text", text: "Native first input", text_elements: [] },
      ],
    };
    await writeFile(
      f.controls,
      JSON.stringify({
        emptyItemsUnsupported: true,
        historyItems: [{ turnId: "external-turn", item }],
        notificationsOnRename: [
          {
            method: "item/completed",
            params: {
              threadId: handle.threadId,
              turnId: "external-turn",
              completedAtMs: 1000,
              item,
            },
          },
        ],
      }),
    );
    // Deliver a native notification through the real SDK while doing metadata work.
    await handle.rename("Fixture renamed");
    for (let i = 0; i < 200 && !arrived; i++) await Bun.sleep(5);
    expect(arrived).toBe(true);
    expect(
      (await f.runtime.historyMessages(handle.threadId)).messages,
    ).toMatchObject([{ id: "native-external", text: "Native first input" }]);
    expect(
      (await f.requests()).filter((r) => r.method === "turn/start"),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
