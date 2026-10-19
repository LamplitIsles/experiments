import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { openPiMcp, loadPiMcpConfig, piMcpExposure } from "./pi-mcp";

test("official HTTP MCP static auth/resources, OAuth rejection, redaction, and trusted project overrides", async () => {
  if (!process.env.GROVE_HTTP_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-http-home-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_HTTP_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "grove-mcp-http-")),
    agentDir = join(home, "agent"),
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  const server = new McpServer({ name: "owned-http", version: "1" });
  let calls = 0,
    unauthorized = 0,
    configuredOAuthCalls = 0,
    headerChecks = 0;
  const secret = "OWNED-STATIC-SECRET";
  server.registerTool(
    "echo",
    { inputSchema: { value: z.string() } },
    async ({ value }) => {
      calls++;
      return {
        content: [{ type: "text", text: value }],
        ...(value === "fail"
          ? { isError: true, content: [{ type: "text", text: secret }] }
          : {}),
      };
    },
  );
  server.registerResource("owned", "owned://http", {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "owned HTTP resource" }],
  }));
  await server.connect(transport);
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/oauth") {
        unauthorized++;
        return new Response(secret, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://secret.invalid/metadata"',
          },
        });
      }
      if (path === "/configured-oauth") {
        configuredOAuthCalls++;
        return new Response("Unexpected call", { status: 500 });
      }
      if (req.headers.get("authorization") !== `Bearer ${secret}`)
        return new Response(secret, { status: 401 });
      headerChecks++;
      return transport.handleRequest(req);
    },
  });
  const url = `http://127.0.0.1:${endpoint.port}`;
  const authPath = join(agentDir, "mcp-auth.json");
  await writeFile(authPath, "deliberately-invalid-unused-MCP-auth");
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        http: {
          url: url + "/good",
          headers: { Authorization: `Bearer ${secret}` },
          exposure: "deferred",
          toolExposure: { echo: "direct" },
        },
        oauth: { url: url + "/oauth" },
        configured: {
          url: url + "/configured-oauth",
          oauth: { clientId: secret },
          headers: {
            Authorization: `!printf should-not-run > "${join(home, "oauth-command")}"; printf ${secret}`,
          },
        },
        disabled: { url: url + "/must-not-run", enabled: false },
      },
    }),
  );
  await writeFile(
    join(cwd, ".pi/mcp.json"),
    JSON.stringify({
      mcpServers: {
        http: { exposure: "codemode", toolExposure: { echo: "direct" } },
        disabled: { enabled: false },
      },
    }),
  );
  let host: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  try {
    const global = await loadPiMcpConfig(agentDir, cwd, false),
      trusted = await loadPiMcpConfig(agentDir, cwd, true);
    expect(global.get("http")?.exposure).toBe("deferred");
    expect(trusted.get("http")?.exposure).toBe("codemode");
    expect(piMcpExposure(trusted.get("http")!, "echo")).toBe("direct");
    expect(
      "url" in trusted.get("http")! &&
        (trusted.get("http")! as { headers: Record<string, string> }).headers
          .Authorization,
    ).toBe(`Bearer ${secret}`);
    host = await openPiMcp({ agentDir, cwd, trusted: true });
    expect(host.issues).toHaveLength(2);
    expect(JSON.stringify(host.issues)).not.toContain(secret);
    expect(JSON.stringify(host.issues)).not.toContain(url);
    expect(host.issues.join(" ")).toContain("OAuth is unsupported");
    expect(unauthorized).toBe(1);
    expect(configuredOAuthCalls).toBe(0);
    expect(await Bun.file(join(home, "oauth-command")).exists()).toBe(false);
    const invoke = (name: string, args: unknown) => {
      const tool = host!.extension.tools?.find((t) => t.name === name);
      if (!tool) throw new Error("Fixture tool missing");
      return tool.execute(args, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    };
    expect(
      JSON.stringify(
        await invoke("mcp__http__echo", { value: "HTTP actual call" }),
      ),
    ).toContain("HTTP actual call");
    expect(
      JSON.stringify(await invoke("list_mcp_resources", { server: "http" })),
    ).toContain("owned://http");
    expect(
      JSON.stringify(
        await invoke("read_mcp_resource", {
          server: "http",
          uri: "owned://http",
        }),
      ),
    ).toContain("owned HTTP resource");
    const error = await invoke("mcp__http__echo", { value: "fail" });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(calls).toBe(2);
    expect(
      host.extension.tools?.some((t) => t.name.startsWith("mcp__oauth__")),
    ).toBe(false);
    expect(headerChecks).toBeGreaterThan(3);
    expect(await readFile(authPath, "utf8")).toBe(
      "deliberately-invalid-unused-MCP-auth",
    );
    await host.close();
    await host.close();
  } finally {
    await host?.close();
    await server.close();
    endpoint.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
