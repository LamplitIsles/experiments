/** Directly adapted from Codex-for-Love's app-server construction (MIT client). */
import type { AppServer } from "./conversation";

export type Session = {
  id: string;
  name: string;
  updatedAt?: string;
  cwd?: string;
};

export async function connect(
  cwd: string,
  codexPath = "codex",
): Promise<
  AppServer & {
    sessions(): Promise<Session[]>;
    start(): Promise<string>;
    resume(id: string): Promise<void>;
  }
> {
  // Keep the maintained generated protocol client at the process boundary rather
  // than duplicating JSON-RPC schemas here.
  // Bun resolves the pinned maintained client at runtime; its generated
  // protocol performs request validation at the transport boundary.
  const clientPackage = "@jaminzhou/codex-app-server-client";
  const mod = await import(clientPackage);
  const client = new mod.CodexAppServerClient({
    codexPath,
    codexExecutableType: "app-server",
    cwd,
    capabilities: { experimentalApi: true, requestAttestation: false },
    clientInfo: { name: "zencodex", title: "zencodex", version: "0.1.0" },
    protocolValidation: "strict",
    requestTimeoutMs: 60_000,
  });
  await client.connect();
  return {
    call: (method, params) => client.call(method as never, params as never),
    onNotification: (method, listener) =>
      client.onNotification(method as never, listener as never),
    close: () => client.close(),
    async sessions() {
      const page = await client.call("thread/list", {
        cwd,
        sortDirection: "desc",
      });
      return page.data
        .filter((thread: any) => thread.cwd === cwd)
        .map((thread: any) => ({
          id: thread.id,
          name: thread.name ?? "Untitled session",
          updatedAt: thread.updatedAt,
          cwd: thread.cwd,
        }));
    },
    async start() {
      const result = await client.call("thread/start", {
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        historyMode: "paginated",
        sessionStartSource: "startup",
      });
      return result.thread.id;
    },
    async resume(id) {
      await client.call("thread/resume", {
        threadId: id,
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        historyMode: "paginated",
      });
    },
  };
}
