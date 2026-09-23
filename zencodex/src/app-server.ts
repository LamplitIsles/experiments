/** Narrow direct CFL client setup transplant; runtime remains PATH `codex`. */
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { isHerdrSessionHook } from "./herdr";
import type { AppServer, Model, Skill } from "./conversation";
import { nameThreadFromPrompt } from "./thread-title";
import { noTrace, type Trace } from "./tracing";

export type ZencodexClient = AppServer & {
  startThread(): Promise<{
    id: string;
    name?: string;
    model?: string;
    effort?: string;
  }>;
  resumeThread(
    id: string,
  ): Promise<{ id: string; name?: string; model?: string; effort?: string }>;
};

export async function connect(
  cwd: string,
  codexPath = "codex",
  testOptions?: {
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
    performance?: Trace;
    signal?: AbortSignal;
  },
): Promise<ZencodexClient> {
  const client = new CodexAppServerClient({
    codexPath,
    cwd,
    capabilities: { experimentalApi: true, requestAttestation: false },
    clientInfo: { name: "zencodex", title: "zencodex", version: "0.1.0" },
    protocolValidation: "strict",
    requestTimeoutMs: testOptions?.requestTimeoutMs ?? 60_000,
    env: testOptions?.env,
  });
  const performance = testOptions?.performance ?? noTrace;
  const signal = testOptions?.signal;
  const abort = () => {
    void client.close().catch(() => {});
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await performance.measure("app_server.initialize", () => client.connect());
    signal?.throwIfAborted();
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    await client.close();
    throw error;
  }
  async function hookConfig() {
    const env = { ...process.env, ...testOptions?.env };
    if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return undefined;
    const { data } = await performance.measure("hooks.discover", () =>
      client.call("hooks/list", { cwds: [cwd] }),
    );
    const state: Record<string, { enabled: false }> = {};
    for (const entry of data) {
      if (entry.errors.length)
        throw new Error(
          "Cannot inspect Codex hooks: " +
            entry.errors.map((e) => e.message).join("; "),
        );
      for (const hook of entry.hooks) {
        if (!hook.enabled || !isHerdrSessionHook(hook)) continue;
        if (hook.isManaged)
          throw new Error(
            "The Herdr session hook is managed and cannot be disabled for zencodex",
          );
        state[hook.key] = { enabled: false };
      }
    }
    return Object.keys(state).length ? { "hooks.state": state } : undefined;
  }
  return {
    call: client.call.bind(client),
    async listSkills(skillCwd: string): Promise<Skill[]> {
      const response = await client.call("skills/list", { cwds: [skillCwd] });
      return response.data.flatMap(({ skills }) =>
        skills.flatMap((skill) =>
          skill.enabled
            ? [
                {
                  name: skill.name,
                  description:
                    skill.interface?.shortDescription ??
                    skill.shortDescription ??
                    skill.description,
                },
              ]
            : [],
        ),
      );
    },
    async listModels(): Promise<Model[]> {
      const models: Model[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await client.modelList({ limit: 100, cursor });
        for (const model of response.data)
          models.push({
            name: model.model,
            description: [model.displayName, model.description]
              .filter(
                (value, index, values) =>
                  value && values.indexOf(value) === index,
              )
              .join(" · "),
            efforts: model.supportedReasoningEfforts.map((effort) => ({
              name: effort.reasoningEffort,
              description: effort.description,
            })),
            defaultEffort: model.defaultReasoningEffort,
          });
        cursor = response.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("Model list returned a repeated cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return models;
    },
    onNotification: client.onNotification.bind(client),
    nameThreadFromPrompt: (threadId, input, model, effort, signal) =>
      nameThreadFromPrompt(client, threadId, cwd, input, model, effort, signal),
    close: () => {
      signal?.removeEventListener("abort", abort);
      return client.close();
    },
    async startThread() {
      const response = await client.threadStart({
        config: await hookConfig(),
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        historyMode: "paginated",
        sessionStartSource: "startup",
      });
      return {
        id: response.thread.id,
        name: response.thread.name ?? undefined,
        model: response.model,
        effort:
          response.reasoningEffort ??
          response.thread.reasoningEffort ??
          undefined,
      };
    },
    async resumeThread(id: string) {
      const response = await client.threadResume({
        config: await hookConfig(),
        threadId: id,
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      return {
        id: response.thread.id,
        name: response.thread.name ?? undefined,
        model: response.model ?? response.thread.model ?? undefined,
        effort:
          response.reasoningEffort ??
          response.thread.reasoningEffort ??
          undefined,
      };
    },
  };
}
