import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Workspace } from "./workspace";

const text = z.string().trim().min(1).max(100_000);
const defaults = z.object({
  fast: z.boolean(),
  model: z.string().min(1),
  effort: z.string().min(1),
});
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function createHandler(
  app: Workspace,
  options: { origin: () => string; assets?: string },
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = options.origin();
    if (
      url.host !== new URL(origin).host ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== origin)
    )
      return json({ error: "Open FlickGrove from its local address" }, 403);
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== origin &&
      !url.pathname.startsWith("/api/mcp")
    )
      return json({ error: "This action requires the FlickGrove page" }, 403);
    try {
      if (url.pathname.startsWith("/api/mcp/")) {
        const token = /^Bearer (.+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (!token) return json({ error: "Agent authorization required" }, 401);
        if (request.method === "GET" && url.pathname === "/api/mcp/info")
          return json(app.identity(token));
        if (request.method === "POST" && url.pathname === "/api/mcp/call") {
          const body = z
            .object({ name: z.string().min(1), arguments: z.unknown() })
            .parse(await request.json());
          return json(await app.tool(token, body.name, body.arguments));
        }
        return json({ error: "Tool action not found" }, 404);
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot")
        return json(app.snapshot());
      if (request.method === "GET" && url.pathname === "/api/projects")
        return json(await app.projects());
      if (request.method === "GET" && url.pathname === "/api/models")
        return json(await app.models());
      if (request.method === "GET" && url.pathname === "/api/events") {
        let stop = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const publish = () =>
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(app.snapshot())}\n\n`),
              );
            publish();
            const unsubscribe = app.subscribe(publish);
            const timer = setInterval(
              () => controller.enqueue(encoder.encode(": keepalive\n\n")),
              15_000,
            );
            stop = () => {
              clearInterval(timer);
              unsubscribe();
              request.signal.removeEventListener("abort", stop);
            };
            request.signal.addEventListener("abort", stop, { once: true });
          },
          cancel() {
            stop();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        await app.saveSettings(
          z
            .object({ orc: defaults, worker: defaults })
            .parse(await request.json()),
        );
        return json(app.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/api/agents")
        return json(
          await app.createOrc(
            z.object({ project: z.string().min(1) }).parse(await request.json())
              .project,
          ),
        );
      const agentPath =
        /^\/api\/agents\/([^/]+)(?:\/(messages|answer|skills|reconcile))?$/.exec(
          url.pathname,
        );
      if (agentPath) {
        const id = decodeURIComponent(agentPath[1]);
        const action = agentPath[2];
        if (request.method === "GET" && !action) return json(app.detail(id));
        if (request.method === "GET" && action === "skills")
          return json(await app.skills(id));
        if (request.method === "POST" && action === "messages") {
          const body = z
            .object({ text, requestId: z.string().min(1).max(120) })
            .parse(await request.json());
          return json(await app.send(id, body.text, body.requestId));
        }
        if (request.method === "POST" && action === "reconcile") {
          const body = z
            .object({
              deliveryId: z.string().min(1).max(500),
              accepted: z.boolean(),
            })
            .parse(await request.json());
          return json(await app.reconcile(id, body.deliveryId, body.accepted));
        }
        if (request.method === "POST" && action === "answer") {
          const body = z
            .object({ questionId: z.string().min(1).max(300), answer: text })
            .parse(await request.json());
          return json(await app.answer(id, body.questionId, body.answer));
        }
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
      const message =
        error instanceof z.ZodError
          ? "Check the values and try again"
          : error instanceof Error
            ? error.message
            : "Could not complete this action";
      return json({ error: message }, 400);
    }
  };
}
