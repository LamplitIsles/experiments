import type { HostService } from "./hosts";
export function authorizeRead(
  request: Request,
  service: HostService,
  origins: string[],
  methods = ["GET"],
) {
  const url = new URL(request.url);
  const origin =
    request.headers.get("origin") ??
    (request.headers.get("sec-fetch-site") === "same-origin"
      ? url.origin
      : null);
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
  // Remote pages must hold the Peer credential. CORS echoes an explicit HTTP(S)
  // origin and never enables cookies/credentials; bearer is checked on every read.
  let validOrigin = false;
  try {
    validOrigin =
      !!origin &&
      /^https?:\/\//.test(origin) &&
      new URL(origin).origin === origin;
  } catch {
    /* Malformed browser origins are denied. */
  }
  if (!validOrigin || !origin)
    return respond({ error: "Browser origin required" }, 403);
  headers.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    if (
      !methods.includes(
        request.headers.get("access-control-request-method") ?? "",
      )
    )
      return respond({ error: "Method denied" }, 405);
    const requested = (
      request.headers.get("access-control-request-headers") ?? ""
    )
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      requested.some(
        (h) => !["authorization", "content-type", "x-grove-peer"].includes(h),
      )
    )
      return respond({ error: "Header denied" }, 403);
    headers.set("Access-Control-Allow-Methods", methods.join(", "));
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Grove-Peer",
    );
    headers.set("Access-Control-Expose-Headers", "X-Grove-Peer");
    return new Response(null, { status: 204, headers });
  }
  headers.set("Access-Control-Expose-Headers", "X-Grove-Peer");
  const token = /^Bearer (.+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (
    (token && token !== service.credential) ||
    (!origins.includes(origin) && token !== service.credential)
  )
    return respond({ error: "Peer authorization required" }, 401);
  if (request.headers.get("x-grove-peer") !== service.identity.id)
    return respond({ error: "Peer identity changed" }, 403);
  return { headers, respond };
}
