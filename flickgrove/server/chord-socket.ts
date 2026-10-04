// Provider framing adapted from LamplitIsles/lamplit-app contracts/server.ts (Apache-2.0).
// See licenses/lamplit-app-Apache-2.0.txt. Socket disposal never cancels execution.
import {
  RemoteServiceProvider,
  replicatedState,
  createServiceStateEncoder,
  decodeServiceControlCall,
  parseServiceCall,
  type ServiceSubscription,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServerWebSocket } from "bun";
import {
  Grove,
  inputs,
  jsonValue,
  type Method,
  type View,
  type GroveContract,
} from "../src/chord-contract";
import { decodeFrame, MAX_FRAME } from "../src/chord-client";
import { invoke } from "./chord-methods";
import type { HostService } from "./hosts";

type Channel = ReturnType<typeof connect>;
export type SocketData = {
  app: HostService;
  service: HostService;
  channel?: Channel;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  ping?: string;
};
function connect(socket: ServerWebSocket<SocketData>) {
  const { app, service } = socket.data;
  const view = replicatedState(
    jsonValue<View>({ snapshot: app.snapshot(), details: {} }),
  );
  const provider = new RemoteServiceProvider([Grove]);
  let disposed = false,
    selection: string[] = [],
    generation = 0,
    dirty = false;
  let refreshTask: Promise<void> | undefined,
    unobserve = () => {};
  const refresh = () => {
    dirty = true;
    return (refreshTask ??= (async () => {
      while (dirty && !disposed) {
        dirty = false;
        const gen = generation;
        const ids = [...selection];
        const details = Object.fromEntries(
          (
            await Promise.all(
              ids.map(async (id) => {
                try {
                  return [id, await app.detail(id)] as const;
                } catch {
                  return null;
                }
              }),
            )
          ).filter((x) => x !== null),
        );
        if (disposed) return;
        if (gen !== generation) {
          dirty = true;
          continue;
        }
        const next = jsonValue<View>({ snapshot: app.snapshot(), details });
        if (JSON.stringify(view.value) !== JSON.stringify(next))
          view.replace(BACKGROUND_CONTEXT, next);
      }
    })().finally(() => {
      refreshTask = undefined;
      if (dirty && !disposed)
        void refresh().catch(() => socket.close(1011, "State unavailable"));
    }));
  };
  const methods = Object.fromEntries(
    Object.keys(inputs).map((member) => [
      member,
      async (input: unknown) => {
        if (member === "select") {
          const p = inputs.select.parse(input);
          if (p.ids.length > 1)
            throw new Error("Select one visible conversation");
          // Validate identities before changing subscriptions; caches cannot grant writes.
          const gen = ++generation;
          for (const id of p.ids) await app.detail(id);
          if (gen !== generation || disposed) return null;
          selection = p.ids;
          unobserve();
          unobserve = () => {};
          await refresh();
          return null;
        }
        if (member === "identity") {
          inputs.identity.parse(input);
          return service.identity;
        }
        return jsonValue(await invoke(app, member as Method, input));
      },
    ]),
  );
  provider.provide(Grove, { ...methods, view } as unknown as GroveContract);
  const off = app.subscribe(() => {
    void refresh().catch(() => socket.close(1011, "State unavailable"));
  });
  const subscriptions = new Map<string, ServiceSubscription>();
  const active = new Set<string>();
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    off();
    unobserve();
    for (const sub of subscriptions.values()) sub.close();
    subscriptions.clear();
    provider.dispose();
  }
  function deliver(frame: unknown) {
    if (disposed) return;
    const raw = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (
      bytes > MAX_FRAME ||
      socket.getBufferedAmount() + bytes > 2 * MAX_FRAME
    ) {
      socket.close(1013, "Reconnect to synchronize");
      dispose();
      return;
    }
    // Bun sends in order, including encoder snapshot/reset/delta frames. Never discard encoded deltas.
    if (socket.send(raw) === 0) {
      socket.close(1013, "Reconnect to synchronize");
      dispose();
    }
  }
  async function receive(raw: string) {
    if (disposed) return;
    let id: string | undefined;
    let admitted = false;
    try {
      const frame = decodeFrame(raw);
      if (
        frame.type !== "call" ||
        frame.version !== 1 ||
        typeof frame.id !== "string" ||
        !frame.id ||
        frame.id.length > 100
      )
        throw new Error("Invalid frame");
      id = frame.id;
      if (active.has(id)) {
        socket.close(1002, "Duplicate request ID");
        dispose();
        return;
      }
      if (active.size >= 256) throw new Error("Too many requests");
      active.add(id);
      admitted = true;
      const call = parseServiceCall(frame.call);
      const control = decodeServiceControlCall(call);
      if (control?.type === "subscribe") {
        if (subscriptions.size >= 1) throw new Error("Already subscribed");
        const encoder = createServiceStateEncoder();
        const sub = provider.subscribe(
          control.serviceId,
          control.mode,
          (update) =>
            deliver({
              type: "update",
              subscriptionId: control.subscriptionId,
              update: encoder.encodeUpdate(update),
            }),
        );
        subscriptions.set(control.subscriptionId, sub);
        deliver({
          type: "result",
          id,
          result: encoder.encodeSnapshot(sub.snapshot),
        });
        sub.activate();
        return;
      }
      let result: unknown;
      if (control?.type === "unsubscribe") {
        subscriptions.get(control.subscriptionId)?.close();
        subscriptions.delete(control.subscriptionId);
        result = null;
      } else if (control?.type === "catalogue") result = provider.catalogue;
      else {
        if (
          call.serviceId !== Grove.id ||
          call.instance ||
          !Object.hasOwn(inputs, call.member) ||
          call.args.length !== 1
        )
          throw new Error("Invalid method");
        result = await provider.invoke(call, BACKGROUND_CONTEXT);
      }
      deliver({ type: "result", id, result: result ?? null });
    } catch (error) {
      if (!id) {
        socket.close(1002, "Invalid frame");
        dispose();
      } else
        deliver({
          type: "error",
          id,
          error: error instanceof Error ? error.message : "Request rejected",
        });
    } finally {
      if (id && admitted) active.delete(id);
    }
  }
  return { receive, dispose };
}
export const groveWebsocket = {
  maxPayloadLength: MAX_FRAME,
  idleTimeout: 0,
  sendPings: false,
  open(socket: ServerWebSocket<SocketData>) {
    socket.data.channel = connect(socket);
    socket.data.heartbeat = setInterval(() => {
      if (socket.data.ping) return;
      socket.data.ping = crypto.randomUUID();
      socket.ping(socket.data.ping);
      socket.data.deadline = setTimeout(() => {
        console.warn("[grove] browser pong timed out", {
          peerId: socket.data.service.identity.id,
        });
        socket.terminate();
      }, 10_000);
    }, 15_000);
  },
  message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
    if (typeof message !== "string") {
      socket.close(1002, "Text frames required");
      return;
    }
    void socket.data.channel?.receive(message);
  },
  pong(socket: ServerWebSocket<SocketData>, payload: Buffer) {
    if (payload.toString() !== socket.data.ping) return;
    clearTimeout(socket.data.deadline);
    socket.data.ping = undefined;
  },
  close(socket: ServerWebSocket<SocketData>) {
    clearInterval(socket.data.heartbeat);
    clearTimeout(socket.data.deadline);
    socket.data.channel?.dispose();
  },
};
