import { openGrove } from "../src/chord-client";
import { routeCall } from "../src/chord-contract";
export function socketWithHeaders(
  url: string | URL,
  headers: Record<string, string>,
) {
  const Client = WebSocket as unknown as {
    new (
      url: string | URL,
      options: { headers: Record<string, string> },
    ): WebSocket;
  };
  return new Client(url, { headers });
}
export async function callRoute(origin: string, path: string, body: unknown) {
  const client = await openGrove(
    socketWithHeaders(origin.replace(/^http/, "ws") + "/api/socket", {
      Origin: origin,
    }),
    () => {},
    () => {},
  );
  try {
    const call = routeCall(path.replace(/^\/api/, ""), body);
    return Response.json(await client.call(call.member, call.input));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  } finally {
    client.close();
  }
}
