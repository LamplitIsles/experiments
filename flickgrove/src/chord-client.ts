// Adapted from LamplitIsles/lamplit-app packages/contracts/src/client.ts (Apache-2.0).
// See licenses/lamplit-app-Apache-2.0.txt. Grove owns this transport and domain service.
import {
  createRemoteServiceBinding,
  createServiceCatalogueCall,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  createServiceStateDecoder,
  parseWireServiceSubscriptionSnapshot,
  parseWireServiceProviderUpdate,
  isJsonValue,
  type JsonValue,
  type RemoteServiceTransport,
  type ServiceSubscription,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Grove,
  inputs,
  jsonValue,
  viewSchema,
  type Method,
  type View,
} from "./chord-contract";
export const MAX_FRAME = 2 * 1024 * 1024;
export function decodeFrame(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > MAX_FRAME)
    throw new Error("Frame too large");
  const frame: unknown = JSON.parse(raw);
  if (
    !isJsonValue(frame) ||
    !frame ||
    typeof frame !== "object" ||
    Array.isArray(frame)
  )
    throw new Error("Invalid frame");
  return frame;
}
export class RequestRejected extends Error {}
export async function openGrove(
  socket: WebSocket,
  changed: (view: View) => void,
  offline: () => void,
  timeoutMs = 30_000,
) {
  if (socket.readyState !== 1)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Connection timed out"));
      }, 10_000);
      const done = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("close", failed);
        socket.removeEventListener("error", failed);
      };
      const opened = () => {
        done();
        resolve();
      };
      const failed = () => {
        done();
        reject(new Error("Connection failed"));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("close", failed, { once: true });
      socket.addEventListener("error", failed, { once: true });
    });
  let closed = false,
    sequence = 0;
  const pending = new Map<
    string,
    {
      resolve: (v: JsonValue) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Map<string, (v: unknown) => void>();
  const invoke: RemoteServiceTransport["invoke"] = (call, _context) =>
    new Promise<JsonValue>((resolve, reject) => {
      if (closed || socket.readyState !== 1)
        return reject(new Error("Connection offline. Outcome unknown."));
      if (pending.size >= 256)
        return reject(new Error("Too many pending requests"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Response timed out. Outcome unknown."));
        socket.close();
        finish();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        const raw = JSON.stringify({ type: "call", version: 1, id, call });
        if (
          new TextEncoder().encode(raw).byteLength > MAX_FRAME ||
          socket.bufferedAmount > 2 * MAX_FRAME
        )
          throw new Error("Connection overloaded");
        socket.send(raw);
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  const transport: RemoteServiceTransport = {
    invoke,
    async subscribe(
      serviceId,
      mode,
      listener,
      context,
    ): Promise<ServiceSubscription> {
      const subscriptionId = `view-${++sequence}`;
      const decoder = createServiceStateDecoder();
      let hydrated = false,
        active = false,
        disposed = false;
      const queue: unknown[] = [];
      const accept = (raw: unknown) => {
        if (disposed) return;
        if (!hydrated || !active) {
          if (queue.length >= 100) throw new Error("Subscription overflow");
          queue.push(raw);
          return;
        }
        // The public decoder handles explicit reset and clears its path dictionaries.
        listener(
          decoder.decodeUpdate(parseWireServiceProviderUpdate(raw)),
          BACKGROUND_CONTEXT,
        );
      };
      listeners.set(subscriptionId, accept);
      try {
        const raw = await invoke(
          createServiceSubscribeCall(subscriptionId, serviceId, mode),
          context,
        );
        const snapshot = decoder.decodeSnapshot(
          parseWireServiceSubscriptionSnapshot(raw),
        );
        hydrated = true;
        return {
          snapshot,
          activate() {
            active = true;
            for (const raw of queue.splice(0)) accept(raw);
          },
          close() {
            disposed = true;
            queue.length = 0;
            listeners.delete(subscriptionId);
            if (!closed)
              void invoke(
                createServiceUnsubscribeCall(subscriptionId),
                BACKGROUND_CONTEXT,
              ).catch(() => {});
          },
        };
      } catch (e) {
        listeners.delete(subscriptionId);
        throw e;
      }
    },
  };
  const binding = createRemoteServiceBinding({
    services: [Grove],
    transport,
    onError: () => {
      socket.close(1002, "Invalid state");
      finish();
    },
  });
  const service = binding.use(Grove);
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    listeners.clear();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection offline. Outcome unknown."));
    }
    pending.clear();
    void binding.dispose(BACKGROUND_CONTEXT).catch(() => {});
    offline();
  }
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string") throw new Error("Invalid frame");
      const frame = decodeFrame(event.data);
      if (frame.type === "update" && typeof frame.subscriptionId === "string") {
        const accept = listeners.get(frame.subscriptionId);
        if (!accept) throw new Error("Unknown subscription");
        accept(frame.update);
      } else if (
        (frame.type === "result" || frame.type === "error") &&
        typeof frame.id === "string"
      ) {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.type === "error")
          p.reject(
            new RequestRejected(
              typeof frame.error === "string"
                ? frame.error
                : "Request rejected",
            ),
          );
        else p.resolve(frame.result as JsonValue);
      } else throw new Error("Invalid frame");
    } catch {
      socket.close(1002, "Invalid protocol");
      finish();
    }
  });
  socket.addEventListener("close", finish, { once: true });
  socket.addEventListener(
    "error",
    () => {
      socket.close();
      finish();
    },
    { once: true },
  );
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    unsubscribe = service.view.subscribe((value) => {
      try {
        changed(viewSchema.parse(value));
      } catch {
        socket.close(1002, "Invalid view");
        finish();
      }
    });
    heartbeat = setInterval(() => {
      void invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT).catch(
        () => {
          socket.close();
          finish();
        },
      );
    }, 15_000);
    return {
      async call<T>(member: Method, input: unknown): Promise<T> {
        return (await service[member](
          jsonValue(inputs[member].parse(input)) as JsonValue,
          BACKGROUND_CONTEXT,
        )) as T;
      },
      close() {
        socket.close();
        finish();
      },
    };
  } catch (e) {
    socket.close();
    finish();
    throw e;
  }
}
export type GroveClient = Awaited<ReturnType<typeof openGrove>>;
