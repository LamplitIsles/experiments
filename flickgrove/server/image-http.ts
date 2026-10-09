import type { HostService } from "./hosts";
import { IMAGE_UPLOAD_BYTES } from "./images";
export async function imageHttp(
  request: Request,
  service: HostService,
  origins: string[],
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/images")) return;
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
      !["GET", "POST"].includes(
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
    headers.set("Access-Control-Allow-Methods", "GET, POST");
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
  try {
    const agent = url.searchParams.get("agent") ?? "";
    if (url.pathname === "/api/images" && request.method === "POST") {
      if (Number(request.headers.get("content-length")) > IMAGE_UPLOAD_BYTES)
        return respond({ error: "Image upload exceeds 20 MiB" }, 413);
      if (
        !request.headers.get("content-type")?.startsWith("multipart/form-data;")
      )
        return respond({ error: "Use image files" }, 415);
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing images");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > IMAGE_UPLOAD_BYTES) {
            await reader.cancel();
            return respond({ error: "Image upload exceeds 20 MiB" }, 413);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const form = await new Response(new Blob(chunks), {
        headers: { "Content-Type": request.headers.get("content-type")! },
      }).formData();
      const files = form.getAll("images");
      if (files.some((f) => !(f instanceof File)))
        throw new Error("Choose image files");
      const operation = url.searchParams.get("operation") ?? "";
      const encodedText = form.get("text");
      if (typeof encodedText !== "string")
        throw new Error("Missing message text");
      let text: unknown;
      try {
        text = JSON.parse(encodedText);
      } catch {
        throw new Error("Invalid message text");
      }
      if (typeof text !== "string") throw new Error("Invalid message text");
      const images = await service.uploadImages(
        agent,
        operation,
        text,
        files as File[],
      );
      return respond({ agent, operation, images });
    }
    const match = /^\/api\/images\/([a-f0-9]{64})\/(preview|original)$/.exec(
      url.pathname,
    );
    if (match && request.method === "GET") {
      const image = service.media(agent, match[1], match[2] === "preview");
      if (!image) return respond({ error: "Image missing or unreadable" }, 404);
      headers.set("Content-Type", image.mediaType);
      return new Response(image.bytes, { headers });
    }
    return respond({ error: "Image action not found" }, 404);
  } catch (error) {
    return respond(
      {
        error:
          error instanceof Error ? error.message : "Could not prepare image",
      },
      400,
    );
  }
}
