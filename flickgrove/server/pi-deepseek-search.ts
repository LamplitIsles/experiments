import {
  ModelRegistry,
  type ModelRuntime,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import deepseekSearchExtension from "./vendor/pi-deepseek-search/index";

/** Adapt the two vendored coding-agent tools to Durable's cancellation and result contract. */
export function createDeepSeekSearch(models: ModelRuntime) {
  const definitions: ToolDefinition[] = [];
  deepseekSearchExtension({
    registerTool(tool: ToolDefinition) {
      definitions.push(tool);
    },
  } as ExtensionAPI);
  const modelRegistry = new ModelRegistry(models);
  const tools: ToolRegistration[] = definitions.map((tool) => ({
    name: tool.name,
    description: [tool.description, ...(tool.promptGuidelines ?? [])].join(
      "\n",
    ),
    parameters: tool.parameters,
    replay: "unsafe",
    async execute(args, api, context) {
      const secrets: string[] = [];
      const registry = new Proxy(modelRegistry, {
        get(target, property, receiver) {
          if (property === "getApiKeyForProvider")
            return async (provider: string) => {
              const key = await target.getApiKeyForProvider(provider);
              const used =
                key ||
                process.env.DEEPSEEK_API_KEY ||
                process.env.ANTHROPIC_AUTH_TOKEN;
              if (used) secrets.push(used);
              return key;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await tool.execute(
        api.callId,
        args,
        context.abortSignal,
        undefined,
        { modelRegistry: registry } as ExtensionToolContext,
      );
      // Provider error bodies and fetched pages are untrusted. Do not persist a
      // credential even if a provider echoes one back in its response.
      const clean = JSON.parse(JSON.stringify(result), (_key, value) =>
        typeof value === "string"
          ? secrets.reduce(
              (text, secret) => text.replaceAll(secret, "[redacted]"),
              value,
            )
          : value,
      );
      return {
        output: clean.content,
        details: clean.details,
        isError: clean.isError,
      };
    },
  }));
  return defineExtension({ name: "deepseek-search", tools });
}
