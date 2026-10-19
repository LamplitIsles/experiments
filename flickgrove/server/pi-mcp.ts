import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type {
  McpServerConfig,
  McpExposure,
} from "@earendil-works/pi-coding-agent";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  McpAuthRequiredError,
} from "@earendil-works/pi-mcp";
import {
  defineExtension,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

const exposure = z
  .enum(["direct", "deferred", "codemode", "codemode-deferred", "hidden"])
  .transform((x) => (x === "codemode-deferred" ? "codemode" : x));
const common = {
  enabled: z.boolean().optional(),
  exposure: exposure.optional(),
  toolExposure: z.record(z.string(), exposure).optional(),
  description: z.string().optional(),
  timeout: z.number().positive().optional(),
};
const oauth = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    callbackPort: z.number().int().optional(),
    callbackUrl: z.string().optional(),
    scope: z.string().optional(),
    clientName: z.string().optional(),
    clientRegistration: z.enum(["dcr", "cimd"]).optional(),
    authServerMetadataUrl: z.string().optional(),
  })
  .strict();
const serverSchema = z.union([
  z
    .object({
      ...common,
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("http").optional(),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      auth: z.object({ provider: z.string() }),
      oauth: oauth.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("http").optional(),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      oauth: oauth.optional(),
    })
    .strict(),
]);
const namespace = (name: string) => `mcp__${name.replaceAll("-", "_")}`;
export async function loadPiMcpConfig(
  agentDir: string,
  cwd: string,
  trusted: boolean,
) {
  const servers = new Map<string, McpServerConfig>();
  for (const [scope, path] of [
    ["global", join(agentDir, "mcp.json")],
    ...(trusted ? [["project", join(cwd, ".pi/mcp.json")]] : []),
  ]) {
    let text: string;
    try {
      text = await readFile(path!, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("MCP configuration could not be read");
    }
    try {
      const config = z
        .object({
          mcpServers: z.record(z.string(), z.unknown()).optional(),
          autoEnableCodemode: z.boolean().optional(),
        })
        .parse(JSON.parse(text));
      for (const [name, value] of Object.entries(config.mcpServers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error();
        if (
          [...servers.keys()].some(
            (other) => other !== name && namespace(other) === namespace(name),
          )
        )
          throw new Error();
        let raw = value;
        if (
          scope === "project" &&
          value &&
          typeof value === "object" &&
          !("command" in value) &&
          !("url" in value) &&
          !("type" in value)
        ) {
          const override = z
            .object({
              enabled: z.boolean().optional(),
              exposure: exposure.optional(),
              toolExposure: z.record(z.string(), exposure).optional(),
            })
            .strict()
            .parse(value);
          if (!servers.has(name)) throw new Error();
          raw = { ...servers.get(name), ...override };
        }
        const parsed = serverSchema.parse(raw) as McpServerConfig;
        servers.set(name, parsed);
      }
    } catch {
      throw new Error("MCP configuration is invalid");
    }
  }
  return servers;
}
export function piMcpExposure(
  config: McpServerConfig,
  name: string,
): McpExposure {
  const overrides = config.toolExposure ?? {};
  if (overrides[name]) return overrides[name]!;
  for (const [pattern, value] of Object.entries(overrides)) {
    const regex = new RegExp(
      `^${pattern
        .split("*")
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    if (regex.test(name)) return value;
  }
  return config.exposure ?? "codemode";
}
const expandHome = (s: string) =>
  s === "~" ? homedir() : s.startsWith("~/") ? join(homedir(), s.slice(2)) : s;
/** Executed only while opening a trusted execution owner, never during catalogue/history reads. */
async function configValue(value: string, cwd: string) {
  if (value.startsWith("!")) {
    const env = new NodeExecutionEnv({ cwd });
    let output = "";
    try {
      const result = await env.exec(
        value.slice(1),
        {
          timeout: 15,
          onOutput(chunk, _context, info) {
            if (info.stream === "stdout") {
              output += chunk;
              if (Buffer.byteLength(output) > 65536)
                throw new Error("MCP credential output exceeds its limit");
            }
          },
        },
        BACKGROUND_CONTEXT,
      );
      if (!result.ok || result.value.exitCode !== 0)
        throw new Error("MCP credential command failed");
      return output.trim();
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  }
  return value.replace(
    /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, a, b) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const resolved = process.env[a ?? b];
      if (!resolved)
        throw new Error("MCP credential environment is unavailable");
      return resolved;
    },
  );
}
export async function openPiMcp(options: {
  agentDir: string;
  cwd: string;
  trusted: boolean;
}) {
  const clients = new Map<string, McpClient>();
  const tools: ToolRegistration[] = [];
  const issues: string[] = [];
  const configs = await loadPiMcpConfig(
    options.agentDir,
    options.cwd,
    options.trusted,
  );
  async function close() {
    await Promise.all([...clients.values()].map((client) => client.close()));
    clients.clear();
  }
  try {
    for (const [name, config] of configs) {
      if (config.enabled === false || namespace(name) === "mcp__flickgrove")
        continue;
      const client = new McpClient({
        name: "flickgrove",
        version: "1",
        requestTimeoutMs: (config.timeout ?? 60) * 1000,
        roots: [{ uri: pathToFileURL(options.cwd).href }],
      });
      clients.set(name, client);
      try {
        let transport;
        if ("url" in config) {
          if (config.auth || config.oauth)
            throw new Error(
              "MCP OAuth is unavailable. Configure static authentication headers in Pi mcp.json.",
            );
          const headers = Object.fromEntries(
            await Promise.all(
              Object.entries(config.headers ?? {}).map(async ([key, value]) => [
                key,
                await configValue(value, options.cwd),
              ]),
            ),
          );
          transport = new StreamableHttpTransport({ url: config.url, headers });
        } else {
          const env = Object.fromEntries(
            await Promise.all(
              Object.entries(config.env ?? {}).map(async ([key, value]) => [
                key,
                await configValue(value, options.cwd),
              ]),
            ),
          );
          transport = new StdioTransport({
            command: expandHome(config.command),
            args: config.args?.map(expandHome),
            cwd: resolve(options.cwd, expandHome(config.cwd ?? ".")),
            env,
            stderr: "pipe",
          });
        }
        await client.connect(transport);
        for (const tool of client.serverCapabilities?.tools
          ? await client.listTools()
          : []) {
          const mode = piMcpExposure(config, tool.name);
          if (mode === "hidden") continue;
          tools.push({
            name: `${namespace(name)}__${tool.name}`,
            description: tool.description ?? "MCP tool",
            parameters: tool.inputSchema,
            replay: "unsafe",
            ...(mode === "deferred" ? { deferred: true as const } : {}),
            ...(mode === "codemode" ? { callers: ["tools"] as const } : {}),
            async execute(args, _api, context) {
              try {
                const result = await client.callTool(
                  tool.name,
                  args as Record<string, unknown>,
                  { signal: context.abortSignal },
                );
                if (result.isError)
                  return {
                    isError: true,
                    output: [
                      {
                        type: "text",
                        text: "MCP tool failed. Inspect the operation before retrying.",
                      },
                    ],
                  };
                return {
                  output: result.content.filter(
                    (x) => x.type === "text" || x.type === "image",
                  ),
                  isError: result.isError,
                };
              } catch (error) {
                return {
                  isError: true,
                  output: [
                    {
                      type: "text",
                      text:
                        error instanceof McpAuthRequiredError
                          ? "MCP OAuth is unavailable. Configure static authentication headers in Pi mcp.json."
                          : "MCP call failed or was cancelled. Inspect the operation before retrying.",
                    },
                  ],
                };
              }
            },
          } as ToolRegistration);
        }
      } catch {
        await client.close();
        clients.delete(name);
        issues.push(
          `MCP server "${name}" is unavailable. OAuth is unsupported; use a server without authentication or preconfigured static headers/token, and check the connection.`,
        );
      }
    }
    const resourceClients = () =>
      [...clients].filter(([name]) => configs.get(name)?.exposure !== "hidden");
    const resourceTools: ToolRegistration[] = [
      {
        name: "list_mcp_resources",
        description: "List resources on configured MCP servers",
        parameters: Type.Object({ server: Type.Optional(Type.String()) }),
        replay: "safe",
        async execute(raw, _api, ctx) {
          const args = raw as { server?: string };
          try {
            const output = [];
            for (const [server, client] of resourceClients().filter(
              ([name]) => !args.server || name === args.server,
            )) {
              if (client.serverCapabilities?.resources)
                output.push(
                  ...(
                    await client.listResources({ signal: ctx.abortSignal })
                  ).map((resource) => ({ ...resource, server })),
                );
            }
            return { output: [{ type: "text", text: JSON.stringify(output) }] };
          } catch {
            return {
              isError: true,
              output: [{ type: "text", text: "MCP resource listing failed" }],
            };
          }
        },
      },
      {
        name: "read_mcp_resource",
        description: "Read a resource from a configured MCP server",
        parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
        replay: "safe",
        async execute(raw, _api, ctx) {
          const args = raw as { server: string; uri: string };
          try {
            const client = resourceClients().find(
              ([name]) => name === args.server,
            )?.[1];
            if (!client) throw new Error();
            const result = await client.readResource(args.uri, {
              signal: ctx.abortSignal,
            });
            return { output: [{ type: "text", text: JSON.stringify(result) }] };
          } catch {
            return {
              isError: true,
              output: [{ type: "text", text: "MCP resource reading failed" }],
            };
          }
        },
      },
    ];
    return {
      extension: defineExtension({
        name: "grove-mcp",
        tools: [...tools, ...resourceTools],
        sections: [
          section("mcp_status", () =>
            issues.length ? issues.join("\n") : undefined,
          ),
        ],
      }),
      close,
      issues,
    };
  } catch {
    await close();
    throw new Error(
      "MCP connection or authentication failed. Check Pi MCP configuration and static authentication headers.",
    );
  }
}
