/** Narrow direct CFL client setup transplant; runtime remains PATH `codex`. */
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import type { AppServer } from "./conversation";

export type ZencodexClient = AppServer & {
  startThread(): Promise<string>;
  resumeThread(id: string): Promise<void>;
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
    ...(testOptions?.env ? { env: testOptions.env } : {}),
  });
  await client.connect();
  return {
    call: client.call.bind(client),
    onNotification: client.onNotification.bind(client),
    close: () => client.close(),
    async startThread() {
      return (
        await client.threadStart({
          cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          historyMode: "paginated",
          sessionStartSource: "startup",
        })
      ).thread.id;
    },
    async resumeThread(id: string) {
      await client.threadResume({
        threadId: id,
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    },
  };
}
