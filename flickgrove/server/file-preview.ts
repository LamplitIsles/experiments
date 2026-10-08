import { previewMarkdown } from "./preview-markdown";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { localFile } from "../src/local-file";
import type { HostService } from "./hosts";

export const PREVIEW_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TTL = 15 * 60 * 1000;
const types: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const within = (root: string, path: string) =>
  path.startsWith(root.endsWith(sep) ? root : root + sep);
function clean(path: string) {
  if (/[\0\\]/.test(path) || path.split("/").includes(".."))
    throw new Error("File is outside the preview directory");
}
async function read(root: string, target: string) {
  if ((await realpath(root)) !== root)
    throw new Error("Preview directory changed");
  const canonical = await realpath(target);
  if (!within(root, canonical))
    throw new Error("File is outside the preview directory");
  const type = types[extname(canonical).toLowerCase()];
  if (!type) throw new Error("File type is not supported");
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be previewed");
    if (stat.size > PREVIEW_BYTES) throw new Error("File exceeds 20 MiB");
    // Read at most budget + 1 even if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, PREVIEW_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > PREVIEW_BYTES || size > stat.size)
      throw new Error("File changed while reading; retry");
    if (
      (await realpath(target)) !== canonical ||
      (await realpath(root)) !== root
    )
      throw new Error("Preview directory changed");
    return { bytes: bytes.subarray(0, size), type };
  } finally {
    await handle.close();
  }
}
export function filePreview(service: HostService, now = Date.now) {
  const grants = new Map<string, { root: string; expires: number }>();
  return async (
    request: Request,
    origins: string[],
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const resource = url.pathname.startsWith("/preview/");
    if (!resource && url.pathname !== "/api/file-preview") return;
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Grove-Peer": service.identity.id,
    });
    const fail = (error: string, status = 400) =>
      Response.json({ error }, { status, headers });
    if (!origins.some((o) => new URL(o).host === url.host))
      return fail("Wrong Peer address", 403);
    for (const [id, grant] of grants)
      if (grant.expires <= now()) grants.delete(id);
    try {
      if (resource) {
        const match = /^\/preview\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
        const grant = match && grants.get(match[1]);
        if (!grant)
          return fail(
            "Preview expired or unavailable. Retry from the conversation.",
            410,
          );
        if (request.method !== "GET" && request.method !== "HEAD")
          return fail("Read only", 405);
        const path = decodeURIComponent(match![2]);
        clean(path);
        if (path.startsWith("/"))
          return fail("File is outside the preview directory", 403);
        const file = await read(grant.root, resolve(grant.root, path));
        headers.set("Content-Type", file.type);
        headers.set("Access-Control-Allow-Origin", "*");
        const markdown = file.type.startsWith("text/markdown");
        const bytes = markdown
          ? previewMarkdown(
              file.bytes.toString("utf8"),
              grant.root,
              resolve(grant.root, path),
              `${url.origin}/preview/${match![1]}/`,
            )
          : file.bytes;
        if (markdown) headers.set("Content-Type", "text/html; charset=utf-8");
        if (markdown || file.type.startsWith("text/html"))
          headers.set("Content-Security-Policy", "sandbox allow-scripts");
        return new Response(request.method === "HEAD" ? null : bytes, {
          headers,
        });
      }
      const origin =
        request.headers.get("origin") ??
        (request.headers.get("sec-fetch-site") === "same-origin"
          ? url.origin
          : "");
      if (!/^https?:\/\//.test(origin) || new URL(origin).origin !== origin)
        return fail("Browser origin required", 403);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Expose-Headers", "X-Grove-Peer");
      if (request.method === "OPTIONS") {
        if (request.headers.get("access-control-request-method") !== "POST")
          return fail("Method denied", 405);
        if (
          (request.headers.get("access-control-request-headers") ?? "")
            .toLowerCase()
            .split(",")
            .some(
              (h) =>
                !["", "authorization", "content-type", "x-grove-peer"].includes(
                  h.trim(),
                ),
            )
        )
          return fail("Header denied", 403);
        headers.set("Access-Control-Allow-Methods", "POST");
        headers.set(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-Grove-Peer",
        );
        return new Response(null, { status: 204, headers });
      }
      const token = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (
        (token && token !== service.credential) ||
        (!origins.includes(origin) && token !== service.credential)
      )
        return fail("Peer authorization required", 401);
      if (request.headers.get("x-grove-peer") !== service.identity.id)
        return fail("Peer identity changed", 403);
      if (request.method !== "POST") return fail("Method denied", 405);
      if (Number(request.headers.get("content-length")) > 8192)
        return fail("Link too long", 413);
      const reader = request.body?.getReader();
      if (!reader) return fail("Choose a file link");
      let text = "";
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192) {
            headers.set("Connection", "close");
            await reader.cancel();
            return fail("Link too long", 413);
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(text);
      if (typeof body.agent !== "string" || typeof body.href !== "string")
        return fail("Choose a file link");
      const link = localFile(body.href);
      if (!link) return fail("File type is not supported");
      clean(link.path);
      const session = resolve(service.previewDirectory(body.agent));
      const requested = resolve(session, link.path);
      const target = await realpath(requested);
      // The catalogue belongs to this execution Peer. Failure cannot grant
      // cross-project access, but does not revoke the session's own directory.
      const projects = await service.projects().catch(() => []);
      let allowed = false;
      for (const path of [session, ...projects.map((p) => p.path)]) {
        const root = resolve(path);
        const canonical = await realpath(root).catch(() => undefined);
        if (canonical && within(canonical, target)) {
          allowed = true;
          break;
        }
      }
      if (!allowed)
        return fail(
          "File is outside the session and registered project directories",
          403,
        );
      if (!localFile(target)) return fail("File type is not supported");
      const root = dirname(target);
      await read(root, target);
      const id =
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "");
      if (grants.size >= 256) grants.delete(grants.keys().next().value!);
      grants.set(id, { root, expires: now() + PREVIEW_TTL });
      return Response.json(
        {
          url: `${url.origin}/preview/${id}/${encodeURIComponent(basename(target))}${link.fragment}`,
          kind: localFile(target)!.kind,
        },
        { headers },
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(
        code === "ENOENT"
          ? "File missing. Check the link and retry."
          : code === "EACCES"
            ? "File is not readable."
            : code
              ? "File is not readable. Check the link and retry."
              : error instanceof Error
                ? error.message
                : "Could not open file",
      );
    }
  };
}
