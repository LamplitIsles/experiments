import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";
const log = (event: string) =>
  appendFileSync(
    process.env.GROVE_MCP_LOG!,
    JSON.stringify({ event, pid: process.pid }) + "\n",
  );
log("start");
const server = new McpServer({ name: "owned-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo the fixture value", inputSchema: { value: z.string() } },
  async ({ value }, extra) => {
    log("echo");
    if (value === "hold") {
      log("hold");
      await new Promise<void>((resolve) => {
        if (extra.signal.aborted) resolve();
        else
          extra.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      log("cancelled");
    }
    return { content: [{ type: "text", text: value }] };
  },
);
server.registerResource(
  "owned-resource",
  "owned://fixture",
  { description: "Owned fixture resource" },
  async (uri) => {
    log("read-resource");
    return { contents: [{ uri: uri.href, text: "owned resource value" }] };
  },
);
process.on("SIGTERM", () => {
  log("stop");
  process.exit(0);
});
process.stdin.on("end", () => log("end"));
await server.connect(new StdioServerTransport());
