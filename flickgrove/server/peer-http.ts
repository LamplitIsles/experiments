import { browserOrigin } from "./browser-origin";
import type { HostService } from "./hosts";
export function authorizeRead(
  request: Request,
  service: HostService,
  origins: string[],
  methods = ["GET"],
) {
  const url = new URL(request.url);
  const origin = browserOrigin(request, origins);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
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
  if (!methods.includes(request.method))
    return respond({ error: "Method denied" }, 405);
  if (request.headers.get("x-grove-peer") !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  return { headers, respond };
}
