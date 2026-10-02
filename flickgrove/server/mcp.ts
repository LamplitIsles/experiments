import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolDefinitions } from "./tools";

const origin = process.env.FLICKGROVE_ORIGIN;
const token = process.env.FLICKGROVE_AGENT_TOKEN;
if (!origin || !token || new URL(origin).hostname !== "127.0.0.1")
  throw new Error("FlickGrove agent connection is required");
async function bridge(path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "FlickGrove action failed",
    );
  return result;
}
const identity = (await bridge("/api/mcp/info")) as {
  tools: (keyof typeof toolDefinitions)[];
};
const server = new McpServer({ name: "flickgrove", version: "0.1.0" });
for (const name of identity.tools) {
  const definition = toolDefinitions[name];
  server.registerTool(
    name,
    { description: definition.description, inputSchema: definition.shape },
    async (args: Record<string, unknown>) => {
      try {
        const result = await bridge("/api/mcp/call", { name, arguments: args });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof Error
                  ? error.message.replaceAll(token!, "[redacted]")
                  : "Could not complete this tool call",
            },
          ],
        };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
