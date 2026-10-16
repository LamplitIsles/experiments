import type { Server } from "bun";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";
import type { VoiceOptions } from "./voice";
import { readVoiceKey } from "./voice-config";

export async function voiceHttp(
  request: Request,
  service: HostService,
  origins: string[],
  options: VoiceOptions = {},
  server?: Pick<Server<SocketData>, "upgrade">,
): Promise<Response | true | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/voice/")) return;
  const stream = url.pathname === "/api/voice/stream";
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim());
  const origin =
    request.headers.get("origin") ??
    (request.headers.get("sec-fetch-site") === "same-origin" ? url.origin : "");
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Grove-Peer": service.identity.id,
    Vary: "Origin",
  });
  const respond = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  if (!origins.some((o) => new URL(o).host === url.host))
    return respond({ error: "Wrong Peer address" }, 403);
  if (!origin || !origins.includes(origin))
    return respond(
      { error: "Open FlickGrove from its configured address" },
      403,
    );
  const peerId = stream
    ? protocols.find((p) => p.startsWith("grove-peer."))?.slice(11)
    : request.headers.get("x-grove-peer");
  if (peerId !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  if (request.method !== "GET") return respond({ error: "Method denied" }, 405);
  if (url.pathname !== "/api/voice/capability" && !stream)
    return respond({ error: "Voice action not found" }, 404);
  const value = await readVoiceKey(options.configPath);
  if (!stream)
    return respond(
      value.key
        ? { available: true }
        : { available: false, reason: value.reason },
    );
  if (!value.key) return respond({ error: "Voice unavailable" }, 503);
  if (!protocols.includes("grove-voice.v1") || !server)
    return respond({ error: "Voice WebSocket required" }, 400);
  if (
    server.upgrade(request, {
      headers: { "Sec-WebSocket-Protocol": "grove-voice.v1" },
      data: {
        app: service,
        service,
        voice: { key: value.key, peerId: service.identity.id, options },
      },
    })
  )
    return true;
  return respond({ error: "WebSocket upgrade required" }, 400);
}
