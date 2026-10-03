import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Server } from "bun";
import type { Workspace } from "./workspace";
import type { HostService } from "./hosts";
import type { SocketData } from "./chord-socket";
import { invoke } from "./chord-methods";
import { routeCall } from "../src/chord-contract";
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
    const peer = url.pathname === "/execution/socket";
    if (!peer && url.pathname !== "/api/socket") return;
    const origin = options.origin();
    if (
      request.method !== "GET" ||
      url.host !== new URL(origin).host ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== origin)
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    if (peer) {
      if (
        request.headers.get("authorization") !==
        `Bearer ${options.service.credential}`
      )
        return json({ error: "Service authorization required" }, 401);
      if (
        options.service.identity.role !== "execution" ||
        request.headers.get("grove-host") !== options.service.identity.id
      )
        return json({ error: "Wrong execution host identity" }, 403);
    } else {
      if (!options.service.options.hub)
        return json({ error: "Execution service has no browser entry" }, 404);
      if (request.headers.get("origin") !== origin)
        return json({ error: "This action requires the FlickGrove page" }, 403);
    }
    if (
      server.upgrade(request, {
        data: {
          app: peer ? workspace : options.service,
          service: options.service,
          peer,
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
    const execution = url.pathname.startsWith("/execution/");
    const mcp = url.pathname.startsWith("/api/mcp/");
    const origin = mcp
      ? (options.localOrigin?.() ?? options.origin())
      : options.origin();
    if (
      url.host !== new URL(origin).host ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== origin)
    )
      return json(
        { error: "Open FlickGrove from its configured address" },
        403,
      );
    if (execution) {
      if (
        request.headers.get("authorization") !==
        `Bearer ${options.service.credential}`
      )
        return json({ error: "Service authorization required" }, 401);
      if (url.pathname === "/execution/identity" && request.method === "GET")
        return json(options.service.identity);
      // Peer control/state have a single WebSocket transport. No HTTP fallback.
      return json({ error: "Execution action not found" }, 404);
    } else if (!mcp) {
      if (!options.service.options.hub)
        return json({ error: "Execution service has no browser entry" }, 404);
      if (request.method !== "GET" && request.headers.get("origin") !== origin)
        return json({ error: "This action requires the FlickGrove page" }, 403);
    }
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
      if (request.method === "GET" && url.pathname === "/api/snapshot")
        return json(options.service.snapshot());
      if (request.method === "GET" && url.pathname.startsWith("/api/")) {
        const call = routeCall(url.pathname.slice(4) + url.search);
        if (
          ![
            "projects",
            "models",
            "weekly",
            "history",
            "historySession",
            "historyMessages",
            "agentHistory",
            "detail",
            "skills",
          ].includes(call.member)
        )
          return json({ error: "Action not found" }, 404);
        return json(await invoke(options.service, call.member, call.input));
      }
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
