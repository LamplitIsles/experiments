import {
  CodexAppServerClient,
  AppServerRpcError,
  AppServerConnectionClosedError,
} from "@jaminzhou/codex-app-server-client";
import type {
  ReasoningEffort,
  v2,
} from "@jaminzhou/codex-app-server-client/protocol";
import { fileURLToPath } from "node:url";
import { nameThreadFromPrompt } from "./thread-title";
import type {
  HistoryPage,
  HistorySession,
  HistoryMessages,
  Model,
  Skill,
  WeeklyUsage,
  Message,
} from "../src/contracts";
import { z } from "zod";
import {
  DeliveryRejected,
  StaleTurn,
  type Runtime,
  type RuntimeAgent,
  type RuntimeEvent,
  type RuntimeHandle,
} from "./runtime";

const historySourceKinds: v2.ThreadSourceKind[] = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function historySession(thread: v2.Thread, archived: boolean): HistorySession {
  return {
    threadId: thread.id,
    title:
      thread.name?.trim() ||
      thread.preview.split("\n")[0]?.slice(0, 160) ||
      "Untitled session",
    preview: thread.preview,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt * 1000,
    source: typeof thread.source === "string" ? thread.source : "subAgent",
    role:
      typeof thread.source === "object" || thread.parentThreadId
        ? "worker"
        : "session",
    ownerThreadId: thread.parentThreadId ?? undefined,
    archived,
    model: thread.model ?? undefined,
    effort: thread.reasoningEffort ?? undefined,
  };
}

export class CodexRuntime implements Runtime {
  private readonly clients = new Set<CodexAppServerClient>();
  private catalog?: Promise<CodexAppServerClient>;
  private catalogModels?: Model[];
  constructor(
    private readonly options: {
      cwd: string;
      origin: () => string;
      codexPath?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private async client(cwd: string, agent?: RuntimeAgent) {
    const configOverrides: string[] = [];
    if (agent) {
      const script = fileURLToPath(new URL("./mcp.ts", import.meta.url));
      configOverrides.push(
        `mcp_servers.flickgrove.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.flickgrove.args=${JSON.stringify([script])}`,
        `mcp_servers.flickgrove.env.FLICKGROVE_ORIGIN=${JSON.stringify(this.options.origin())}`,
        `mcp_servers.flickgrove.env.FLICKGROVE_AGENT_TOKEN=${JSON.stringify(agent.token)}`,
        "features.multi_agent=true",
        "features.multi_agent_v2=true",
      );
    }
    const client = new CodexAppServerClient({
      cwd,
      codexPath: this.options.codexPath ?? "codex",
      configOverrides,
      clientInfo: { name: "flickgrove", title: "FlickGrove", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
      protocolValidation: "strict",
      env: this.options.env,
    });
    this.clients.add(client);
    try {
      await client.connect();
      return client;
    } catch (error) {
      this.clients.delete(client);
      await client.close();
      throw error;
    }
  }
  private getCatalog() {
    return (this.catalog ??= this.client(this.options.cwd)
      .then((client) => {
        client.onError((error) => {
          if (error instanceof AppServerConnectionClosedError) {
            this.clients.delete(client);
            this.catalog = undefined;
          }
        });
        return client;
      })
      .catch((error) => {
        this.catalog = undefined;
        throw error;
      }));
  }
  async models(): Promise<Model[]> {
    const client = await this.getCatalog();
    const models: Model[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await client.modelList({ limit: 100, cursor });
      for (const m of response.data)
        models.push({
          id: m.model,
          name: m.displayName,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort,
          isDefault: m.isDefault,
          fastTier: m.serviceTiers.find((t) => t.id === "priority")?.id ?? null,
        });
      cursor = response.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Model catalog returned a repeated page");
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.catalogModels = models;
    return models;
  }
  async readTitle(threadId: string) {
    return (
      await (
        await this.getCatalog()
      ).threadRead({ threadId, includeTurns: false })
    ).thread.name;
  }
  async history(cwd: string, cursor?: string): Promise<HistoryPage> {
    const schema = z.object({
      cwd: z.string(),
      positions: z.tuple([z.string().nullable(), z.string().nullable()]),
      done: z.tuple([z.boolean(), z.boolean()]),
    });
    const position = cursor
      ? schema.parse(JSON.parse(cursor))
      : {
          cwd,
          positions: [null, null] as [string | null, string | null],
          done: [false, false] as [boolean, boolean],
        };
    if (position.cwd !== cwd)
      throw new Error("Search changed. Start a new history search.");
    const client = await this.getCatalog();
    const sessions: HistorySession[] = [];
    // Read indexed metadata only. Do not invoke thread/search (full rollout search).
    if (!position.done.every(Boolean)) {
      const pages = await Promise.all(
        [0, 1].map(async (index) => {
          if (position.done[index]) return;
          const response = await client.threadList({
            cwd,
            archived: index === 1,
            limit: 50,
            cursor: position.positions[index],
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: historySourceKinds,
            modelProviders: [],
            useStateDbOnly: true,
          });
          if (
            response.nextCursor &&
            response.nextCursor === position.positions[index]
          )
            throw new Error("History returned a repeated page");
          position.positions[index] = response.nextCursor;
          position.done[index] = !response.nextCursor;
          return response.data.map((thread) =>
            historySession(thread, index === 1),
          );
        }),
      );
      for (const session of pages.flatMap((page) => page ?? [])) {
        if (session.cwd !== cwd) continue;
        sessions.push(session);
      }
    }
    sessions.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId),
    );
    return {
      sessions,
      nextCursor: position.done.every(Boolean)
        ? null
        : JSON.stringify(position),
    };
  }
  async historyThread(threadId: string): Promise<HistorySession> {
    const result = await (
      await this.getCatalog()
    ).threadRead({ threadId, includeTurns: false });
    const client = await this.getCatalog();
    let cursor: string | null = null;
    do {
      const page = await client.threadList({
        cwd: result.thread.cwd,
        archived: true,
        limit: 100,
        cursor,
        modelProviders: [],
        sourceKinds: historySourceKinds,
        useStateDbOnly: true,
      });
      if (page.data.some((thread) => thread.id === threadId))
        return historySession(result.thread, true);
      if (page.nextCursor && page.nextCursor === cursor)
        throw new Error("History returned a repeated page");
      cursor = page.nextCursor;
    } while (cursor);
    return historySession(result.thread, false);
  }
  async historyMessages(
    threadId: string,
    cursor?: string,
  ): Promise<HistoryMessages> {
    const response = await (
      await this.getCatalog()
    ).call("thread/items/list", {
      threadId,
      cursor,
      sortDirection: "desc",
      limit: 100,
    });
    const messages: Message[] = [];
    for (const entry of response.data) {
      const item = "item" in entry ? entry.item : entry;
      const turnId = "turnId" in entry ? entry.turnId : undefined;
      if (item.type === "userMessage") {
        const text = item.content
          .map((input) =>
            input.type === "text"
              ? input.text
              : input.type === "image" || input.type === "localImage"
                ? "[Image]"
                : "",
          )
          .filter(Boolean)
          .join("\n");
        if (text)
          messages.push({ id: item.id, turnId, role: "user", text, at: 0 });
      } else if (
        item.type === "agentMessage" &&
        item.text &&
        item.phase !== "commentary"
      ) {
        messages.push({
          id: item.id,
          turnId,
          role: "assistant",
          text: item.text,
          at: 0,
        });
      }
    }
    return { messages: messages.reverse(), nextCursor: response.nextCursor };
  }
  async weekly(): Promise<WeeklyUsage> {
    const result = await (
      await this.getCatalog()
    ).call("account/rateLimits/read", undefined, { timeoutMs: 4000 });
    const weekly = [
      result.rateLimits.primary,
      result.rateLimits.secondary,
    ].find((w) => w?.windowDurationMins === 10080);
    return {
      remaining:
        weekly && Number.isFinite(weekly.usedPercent)
          ? Math.max(0, Math.min(100, 100 - weekly.usedPercent))
          : null,
      resetsAt: weekly?.resetsAt ?? undefined,
      accountId: result.accountId ?? undefined,
      fetchedAt: Date.now(),
    };
  }
  async skills(cwd: string): Promise<Skill[]> {
    const response = await (
      await this.getCatalog()
    ).call("skills/list", { cwds: [cwd], forceReload: true });
    return response.data.flatMap((d) =>
      d.skills
        .filter((s) => s.enabled)
        .map((s) => ({
          name: s.name,
          description: s.description,
          shortDescription:
            s.interface?.shortDescription ??
            s.shortDescription ??
            s.description,
        })),
    );
  }
  async open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    const client = await this.client(agent.project.path, agent);
    let threadId = agent.threadId;
    let threadName: string | null = null;
    let titleGeneration: AbortController | undefined;
    const off = [
      client.onError((error) => {
        if (error instanceof AppServerConnectionClosedError) {
          this.clients.delete(client);
          notify({
            type: "disconnected",
            error:
              "App-server disconnected. Send a message to resume the thread.",
          });
        }
      }),
      client.onNotification("turn/started", (p) => {
        if (p.threadId === threadId)
          notify({ type: "working", turnId: p.turn.id });
      }),
      client.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId || p.item.type !== "agentMessage") return;
        const item = p.item;
        notify({
          type: "item",
          turnId: p.turnId,
          item: {
            id: item.id,
            type: item.type,
            text: item.text,
            phase: item.phase,
            delivery: item.delivery,
            questions: item.questions?.map((q) => ({
              question: q.title,
              options: q.options?.map((label) => ({ label })),
            })),
          },
        });
      }),
      client.onNotification("turn/completed", (p) => {
        if (p.threadId === threadId)
          notify({
            type: "completed",
            turnId: p.turn.id,
            status: p.turn.status,
            error: p.turn.error?.message,
          });
      }),
      client.onNotification("error", (p) => {
        if (p.threadId === threadId && !p.willRetry)
          notify({ type: "error", error: p.error.message });
      }),
    ];
    const roleInstructions =
      agent.role === "orc"
        ? "You are the Orchestrator (Orc) of a FlickGrove tree. Delegate using the flickgrove MCP tools. One implementation assignment has one repository, one spec, one Worker and one PR. You may coordinate many Workers. Model and reasoning settings are selected by the application; do not put them in skill calls. Before the user can close the tree, request worker_close on each Worker. Running Workers finish their current work and close automatically once reports and questions resolve; closing=true means the request was accepted, not a failure. Pending closure rejects new tasks but allows explicit answers to existing questions. Worker questions and reports arrive as messages; answer them with worker_send and explicit questionIds when appropriate. Ask the user with request_user_input_async when their judgement is needed. Use native spawn_agent only for independent review. Reviewer selection belongs to the applicable skills and agent configuration. Manage these reviewers with native messaging, waiting, follow-up and close tools. Implementation delegation must use FlickGrove Workers. Do not use Herdr for delegation."
        : "You are a Worker in FlickGrove, assigned to one repository and one spec. Use worker_report to send progress, questions and completion to your owning Orc. Do not create or close FlickGrove agents or use Herdr. Use native spawn_agent only for independent review. Reviewer selection belongs to the applicable skills and agent configuration. Manage these reviewers with native messaging, waiting, follow-up and close tools. Send implementation delegation requests to your owning Orc for assignment through FlickGrove. Do not choose models/reasoning settings in skills. The Orc manages your lifecycle. Implementation assignments deliver one PR according to the assigned spec. Async questions are forwarded to Orc by the host.";
    const params = {
      cwd: agent.project.path,
      model: agent.inheritSettings ? undefined : agent.model,
      serviceTier: agent.inheritSettings
        ? undefined
        : (agent.serviceTier ?? "default"),
      approvalPolicy: "never" as const,
      sandbox: "danger-full-access" as const,
      developerInstructions: roleInstructions,
    };
    let historyCursor: string | undefined;
    let resumedSettings: {
      model?: string;
      effort?: string;
      serviceTier?: string;
    } = {};
    try {
      if (agent.restoreArchived && agent.threadId)
        await client.call("thread/unarchive", { threadId: agent.threadId });
      const response = agent.threadId
        ? await client.threadResume({
            ...params,
            threadId: agent.threadId,
            excludeTurns: true,
          })
        : await client.threadStart({
            ...params,
            historyMode: "paginated",
            config: { model_reasoning_effort: agent.effort },
          });
      threadId = response.thread.id;
      threadName = response.thread.name;
      if (
        "itemsBackwardsCursor" in response &&
        typeof response.itemsBackwardsCursor === "string"
      )
        historyCursor = response.itemsBackwardsCursor;
      if (agent.threadId && !historyCursor) {
        const latest = await client.call("thread/items/list", {
          threadId,
          sortDirection: "desc",
          limit: 1,
        });
        historyCursor = latest.backwardsCursor ?? undefined;
      }
      resumedSettings = {
        model: response.model,
        effort: response.reasoningEffort ?? undefined,
        serviceTier: response.serviceTier ?? "default",
      };
    } catch (error) {
      off.forEach((f) => f());
      await client.close();
      this.clients.delete(client);
      if (
        error instanceof AppServerRpcError &&
        /already has an active writer/i.test(error.message)
      )
        throw new Error(
          "This session is in use by another Codex instance. Close it there, then retry.",
        );
      throw error;
    }
    const id = threadId!;
    return {
      threadId: id,
      threadName,
      historyCursor,
      ...resumedSettings,
      rename: async (name) => {
        titleGeneration?.abort();
        await client.call("thread/name/set", { threadId: id, name });
      },
      send: async (text, activeTurn) => {
        const input = [{ type: "text" as const, text, text_elements: [] }];
        try {
          if (activeTurn)
            return (
              await client.turnSteer({
                threadId: id,
                expectedTurnId: activeTurn,
                input,
              })
            ).turnId;
          return (
            await client.turnStart({
              threadId: id,
              input,
              model: agent.model,
              effort: agent.effort as ReasoningEffort,
              serviceTier: agent.serviceTier ?? "default",
            })
          ).turn.id;
        } catch (error) {
          if (error instanceof AppServerRpcError) {
            if (activeTurn) {
              const mismatch =
                /expected active turn id [`']([^`']+)[`'] but found [`']([^`']+)[`']/i.exec(
                  error.message,
                );
              if (mismatch) throw new StaleTurn(error.message, mismatch[2]);
              if (/no active turn|turn.*not active/i.test(error.message))
                throw new StaleTurn(error.message);
            }
            throw new DeliveryRejected(error.message);
          }
          throw error;
        }
      },
      interrupt: async (turnId) => {
        await client.turnInterrupt(
          { threadId: id, turnId },
          { timeoutMs: 4000 },
        );
      },
      title: async (input) => {
        const controller = new AbortController();
        titleGeneration = controller;
        const models = this.catalogModels ?? (await this.models());
        const lightweight = models.find(
          (m) => m.id === "gpt-6-luna" && m.efforts.includes("low"),
        );
        await nameThreadFromPrompt(
          client,
          id,
          agent.project.path,
          input,
          lightweight?.id ?? agent.model,
          lightweight ? "low" : agent.effort,
          controller.signal,
        );
        return (
          (await client.threadRead({ threadId: id, includeTurns: false }))
            .thread.name ?? undefined
        );
      },
      close: async () => {
        off.forEach((f) => f());
        await client.close();
        this.clients.delete(client);
      },
    };
  }
  async close() {
    await Promise.allSettled([...this.clients].map((client) => client.close()));
    this.clients.clear();
    this.catalog = undefined;
  }
}
