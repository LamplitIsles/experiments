import { afterEach, expect, test } from "bun:test";
import { monitorHost } from "./host-liveness";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("native Bun Ping/Pong remains alive during idle application traffic", async () => {
  let pings = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message() {},
      ping() {
        pings++;
      },
    },
  });
  cleanup.push(() => server.stop(true));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  cleanup.push(() => socket.close());
  await new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve(), { once: true }),
  );
  let failures = 0;
  cleanup.push(monitorHost(socket, () => failures++, 20, 60));
  await wait(140);
  expect(pings).toBeGreaterThanOrEqual(3);
  expect(failures).toBe(0);
  expect(socket.readyState).toBe(1);
});

test("unmatched Pong and application messages cannot satisfy a probe; other peers remain healthy", async () => {
  class Socket extends EventTarget {
    readyState = 1;
    terminated = false;
    constructor(readonly healthy: boolean) {
      super();
    }
    ping(data: string) {
      this.dispatchEvent(
        new MessageEvent("message", { data: "business response" }),
      );
      this.dispatchEvent(
        new MessageEvent("pong", {
          data: new TextEncoder().encode(this.healthy ? data : "wrong"),
        }),
      );
    }
    terminate() {
      this.terminated = true;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  const a = new Socket(false),
    b = new Socket(true);
  let failuresA = 0,
    failuresB = 0;
  cleanup.push(
    monitorHost(a as unknown as WebSocket, () => failuresA++, 10, 30),
  );
  cleanup.push(
    monitorHost(b as unknown as WebSocket, () => failuresB++, 10, 30),
  );
  await wait(100);
  expect(failuresA).toBe(1);
  expect(a.terminated).toBe(true);
  expect(failuresB).toBe(0);
  expect(b.terminated).toBe(false);
});
