import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Server } from "bun";
import type { Workspace } from "./workspace";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
type Options = {
  origin: () => string;
  localOrigin?: () => string;
  assets?: string;
  service: HostService;
};
export function createUpgrade(workspace: Workspace, options: Options) {
  return (
    request: Request,
    server: Pick<Server<SocketData>, "upgrade">,
  ): Response | true | undefined => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/socket") return;
    const origin = options.origin();
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim());
    const token = protocols
      .find((p) => p.startsWith("grove-auth."))
      ?.slice("grove-auth.".length);
    const origins = [origin, options.localOrigin?.()].filter(
      (value): value is string => !!value,
    );
    const local = origins.includes(request.headers.get("origin") ?? "");
    const authorized = token === options.service.credential;
    if (
      request.method !== "GET" ||
      !origins.some((value) => url.host === new URL(value).host)
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    // Same-origin page access remains local. Cross-origin access requires possession
    // of this Peer's credential; it is carried by a subprotocol, never a URL.
    if (!local && !authorized)
      return json({ error: "Peer authorization required" }, 401);
    if (token && !authorized)
      return json({ error: "Peer authorization required" }, 401);
    if (
      server.upgrade(request, {
        ...(protocols.includes("grove.v1")
          ? { headers: { "Sec-WebSocket-Protocol": "grove.v1" } }
          : {}),
        data: {
          app: options.service,
          service: options.service,
        },
      })
    )
      return true;
    return json({ error: "WebSocket upgrade required" }, 400);
  };
}
export function createHandler(workspace: Workspace, options: Options) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const mcp = url.pathname.startsWith("/api/mcp/");
    const origin = mcp
      ? (options.localOrigin?.() ?? options.origin())
      : options.origin();
    const origins = mcp
      ? [origin]
      : [origin, options.localOrigin?.()].filter(
          (value): value is string => !!value,
        );
    if (
      !origins.some((value) => url.host === new URL(value).host) ||
      (request.headers.get("origin") &&
        !origins.includes(request.headers.get("origin")!))
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    try {
      if (mcp) {
        const token = /^Bearer (.+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (!token) return json({ error: "Agent authorization required" }, 401);
        if (request.method === "GET" && url.pathname === "/api/mcp/info")
          return json(workspace.identity(token));
        if (request.method === "POST" && url.pathname === "/api/mcp/call") {
          const body = z
            .object({ name: z.string().min(1), arguments: z.unknown() })
            .parse(await request.json());
          return json(await workspace.tool(token, body.name, body.arguments));
        }
        return json({ error: "Tool action not found" }, 404);
      }
      if (request.method === "GET" && url.pathname === "/api/identity")
        return json(options.service.identity);
      if (url.pathname.startsWith("/api/"))
        return json({ error: "Action not found" }, 404);
      if (request.method !== "GET" || !options.assets)
        return json({ error: "Build the FlickGrove web app first" }, 404);
      const root = resolve(options.assets);
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (path !== root && !path.startsWith(root + sep))
        return json({ error: "Not found" }, 404);
      let file = Bun.file(path);
      if (!(await file.exists()) || url.pathname === "/")
        file = Bun.file(resolve(root, "index.html"));
      if (!(await file.exists()))
        return json(
          { error: "Run bun run build before starting FlickGrove" },
          503,
        );
      return new Response(file, {
        headers: {
          "Cache-Control": url.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError
              ? "Check the values and try again"
              : error instanceof Error
                ? error.message
                : "Could not complete this action",
        },
        400,
      );
    }
  };
}
