/** Narrow direct CFL client setup transplant; runtime remains PATH `codex`. */
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { isHerdrSessionHook } from "./herdr";
import type { AppServer, Skill } from "./conversation";

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
  testOptions?: { env?: NodeJS.ProcessEnv; requestTimeoutMs?: number },
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
  await client.connect();
  async function hookConfig() {
    const env = { ...process.env, ...testOptions?.env };
    if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return undefined;
    const { data } = await client.call("hooks/list", { cwds: [cwd] });
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
    onNotification: client.onNotification.bind(client),
    close: () => client.close(),
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
        model: response.thread.model ?? undefined,
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
