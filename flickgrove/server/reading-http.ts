import type { HostService } from "./hosts";
import { authorizeRead } from "./peer-http";
export async function readingHttp(
  request: Request,
  service: HostService,
  origins: string[],
) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/read/")) return;
  const auth = authorizeRead(request, service, origins);
  if (auth instanceof Response) return auth;
  const { respond } = auth;
  if (request.method !== "GET") return respond({ error: "Method denied" }, 405);
  const p = url.searchParams;
  try {
    if (request.signal.aborted)
      return respond({ error: "Read cancelled" }, 408);
    const agent = p.get("agent") ?? "";
    const thread = p.get("thread") ?? "";
    const project = p.get("project") ?? "";
    const cursor = p.get("cursor") ?? undefined;
    switch (url.pathname) {
      case "/api/read/outline":
        return respond(service.userMessageOutline(agent));
      case "/api/read/window":
        return respond(
          await service.agentMessageWindow(agent, {
            operation: p.get("operation") ?? undefined,
            cursor,
            direction: p.get("direction") ?? undefined,
          }),
        );
      case "/api/read/messages":
        return respond(
          agent
            ? await service.agentHistory(agent, cursor)
            : await service.historyMessages(project, thread, cursor),
        );
      case "/api/read/body":
        return respond({
          text: agent
            ? await service.messageBody(agent, p.get("item") ?? "")
            : await service.historyBody(project, thread, p.get("item") ?? ""),
        });
      case "/api/read/deliveries":
        return respond(service.recoveryPage(agent, cursor));
      case "/api/read/recovery":
        return respond(service.recovery(agent, p.get("operation") ?? ""));
      case "/api/read/questions":
        return respond(
          agent
            ? service.questionHistory(agent, {
                item: p.get("item") ?? undefined,
                operation: p.get("operation") ?? undefined,
                pending: p.get("pending") === "true",
              })
            : await service.historyQuestions(project, thread, {
                item: p.get("item") ?? undefined,
                operation: p.get("operation") ?? undefined,
              }),
        );
      default:
        return respond({ error: "Reading action not found" }, 404);
    }
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Reading failed" },
      400,
    );
  }
}
