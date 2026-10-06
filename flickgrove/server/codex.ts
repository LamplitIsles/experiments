import {
  CodexAppServerClient,
  AppServerRpcError,
  AppServerConnectionClosedError,
  AppServerServerRequestError,
} from "@jaminzhou/codex-app-server-client";
import type {
  ReasoningEffort,
  v2,
} from "@jaminzhou/codex-app-server-client/protocol";
import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sameDirectory } from "./directory";
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
  type ExecutionSettings,
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
  private managed?: Promise<CodexAppServerClient>;
  private readonly historyImages = new Map<
    string,
    { threadId: string; content: v2.UserInput }
  >();
  private readonly threads = new Map<string, CodexAppServerClient>();
  private readonly openingThreads = new Set<string>();
  private catalogModels?: Model[];
  constructor(
    private readonly options: {
      cwd: string;
      origin: () => string;
      codexPath?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  // The promise is assigned before connecting so concurrent agents and catalog
  // reads share one Grove-owned process. It never attaches to a system daemon.
  private getCatalog(): Promise<CodexAppServerClient> {
    if (this.managed) return this.managed;
    const client = new CodexAppServerClient({
      cwd: this.options.cwd,
      codexPath: this.options.codexPath ?? "codex",
      clientInfo: { name: "flickgrove", title: "FlickGrove", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
      protocolValidation: "strict",
      configOverrides: ["thread_unload_delay_secs=0"],
      env: this.options.env,
    });
    const connecting = client
      .connect()
      .then(() => client)
      .catch(async (error) => {
        if (this.managed === connecting) this.managed = undefined;
        await client.close();
        throw error;
      });
    this.managed = connecting;
    client.onError((error) => {
      if (!(error instanceof AppServerConnectionClosedError)) return;
      if (this.managed === connecting) this.managed = undefined;
      for (const [id, owner] of this.threads)
        if (owner === client) this.threads.delete(id);
    });
    client.onServerRequest((request) => {
      const params = request.params;
      const threadId =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>).threadId
          : undefined;
      if (typeof threadId !== "string" || this.threads.get(threadId) !== client)
        throw new AppServerServerRequestError(
          "Request has no owned Grove thread",
          -32602,
        );
      // Grove's questions arrive through async agent messages/MCP. There is no
      // synchronous native approval/tool responder; do not fabricate consumption.
      throw new AppServerServerRequestError(
        `Unsupported native request: ${request.method}`,
        -32601,
      );
    });
    return connecting;
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
        if (!sameDirectory(session.cwd, cwd)) continue;
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
          .filter((input) => input.type === "text")
          .map((input) => input.text)
          .join("\n");
        const images = item.content.flatMap((content, index) => {
          if (content.type !== "image" && content.type !== "localImage")
            return [];
          const imageId = createHash("sha256")
            .update(`${threadId}/${item.id}/${index}`)
            .digest("hex");
          this.historyImages.set(imageId, { threadId, content });
          if (this.historyImages.size > 1000)
            this.historyImages.delete(this.historyImages.keys().next().value!);
          return [
            {
              id: imageId,
              name: "Native message image",
              width: 1,
              height: 1,
              bytes: 0,
              mediaType: "image/png",
              availability: "missing" as const,
            },
          ];
        });
        if (text || images.length)
          messages.push({
            id: item.id,
            turnId,
            role: "user",
            text,
            at: 0,
            ...(images.length ? { images } : {}),
          });
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
  async historyImage(threadId: string, imageId: string): Promise<File | null> {
    // Membership comes only from an actual thread/items/list response. Browser
    // callers supply opaque IDs; they never supply paths or external URLs.
    const image = this.historyImages.get(imageId);
    if (!image || image.threadId !== threadId) return null;
    const content = image.content;
    try {
      if (content.type === "localImage") {
        const info = await stat(content.path);
        if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
        return new File([await readFile(content.path)], basename(content.path));
      }
      if (
        content.type === "image" &&
        /^data:image\/(png|jpeg|webp|gif);base64,/.test(content.url) &&
        content.url.length < 7_000_000
      ) {
        const [header, data] = content.url.split(",");
        return new File([Buffer.from(data, "base64")], "Native message image", {
          type: header.slice(5).split(";")[0],
        });
      }
    } catch {
      /* Missing native attachments remain an explicit placeholder. */
    }
    return null;
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
    const client = await this.getCatalog();
    if (
      agent.threadId &&
      (this.threads.has(agent.threadId) ||
        this.openingThreads.has(agent.threadId))
    )
      throw new Error("This session already has an active Grove handle.");
    if (agent.threadId) this.openingThreads.add(agent.threadId);
    let closed = false;
    let nativeReleased = false;
    let releaseWaiter:
      | ReturnType<typeof Promise.withResolvers<void>>
      | undefined;
    let threadId = agent.threadId;
    let threadName: string | null = null;
    let titleGeneration: AbortController | undefined;
    const dispatch = (event: RuntimeEvent) => {
      if (!closed) notify({ ...event, threadId });
    };
    const off = [
      client.onNotification("thread/closed", (p) => {
        if (p.threadId === threadId) {
          nativeReleased = true;
          releaseWaiter?.resolve();
        }
      }),
      client.onError((error) => {
        if (error instanceof AppServerConnectionClosedError) {
          titleGeneration?.abort();
          releaseWaiter?.reject(
            new Error(
              "Native release outcome unknown: app-server disconnected. Retry Close.",
            ),
          );
          dispatch({
            type: "disconnected",
            error:
              "App-server disconnected. Send a message to resume the thread.",
          });
        }
      }),
      client.onNotification("turn/started", (p) => {
        if (p.threadId === threadId)
          dispatch({ type: "working", turnId: p.turn.id });
      }),
      client.onNotification("item/agentMessage/delta", (p) => {
        if (p.threadId === threadId && p.delta.length)
          dispatch({ type: "progress", turnId: p.turnId });
      }),
      client.onNotification("item/started", (p) => {
        if (p.threadId === threadId && p.item.type !== "userMessage")
          dispatch({ type: "progress", turnId: p.turnId });
      }),
      client.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId || p.item.type !== "agentMessage") return;
        const item = p.item;
        dispatch({
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
          dispatch({
            type: "completed",
            turnId: p.turn.id,
            status: p.turn.status,
            error: p.turn.error
              ? [p.turn.error.message, p.turn.error.additionalDetails]
                  .filter(Boolean)
                  .join("\n\n")
              : undefined,
            errorKind: p.turn.error
              ? executionErrorKind(p.turn.error)
              : undefined,
          });
      }),
      client.onNotification("error", (p) => {
        if (p.threadId === threadId)
          dispatch({
            type: "error",
            turnId: p.turnId,
            willRetry: p.willRetry,
            error: [p.error.message, p.error.additionalDetails]
              .filter(Boolean)
              .join("\n\n"),
            errorKind: executionErrorKind(p.error),
          });
      }),
    ];
    const roleInstructions =
      agent.role === "orc"
        ? "You are the Orchestrator (Orc) of a FlickGrove tree. Delegate using the flickgrove MCP tools. One implementation assignment has one repository, one spec, one Worker and one PR. You may coordinate many Workers. Model and reasoning settings are selected by the application; do not put them in skill calls. Before the user can close the tree, request worker_close on each Worker. Running Workers finish their current work and close automatically once reports and questions resolve; closing=true means the request was accepted, not a failure. Pending closure rejects new tasks but allows explicit answers to existing questions. Worker questions and reports arrive as messages; answer them with worker_send and explicit questionIds when appropriate. Ask the user with request_user_input_async when their judgement is needed. Use native spawn_agent only for independent review. Reviewer selection belongs to the applicable skills and agent configuration. Manage these reviewers with native messaging, waiting, follow-up and close tools. Implementation delegation must use FlickGrove Workers. Do not use Herdr for delegation."
        : "You are a Worker in FlickGrove, assigned to one repository and one spec. Use worker_report to send progress, questions and completion to your owning Orc. Do not create or close FlickGrove agents or use Herdr. Use native spawn_agent only for independent review. Reviewer selection belongs to the applicable skills and agent configuration. Manage these reviewers with native messaging, waiting, follow-up and close tools. Send implementation delegation requests to your owning Orc for assignment through FlickGrove. Do not choose models/reasoning settings in skills. The Orc manages your lifecycle. Implementation assignments deliver one PR according to the assigned spec. Async questions are forwarded to Orc by the host.";
    const params = {
      cwd: agent.project.path,
      model: agent.threadId || agent.inheritSettings ? undefined : agent.model,
      serviceTier:
        agent.threadId || agent.inheritSettings
          ? undefined
          : (agent.serviceTier ?? "default"),
      approvalPolicy: "never" as const,
      sandbox: "danger-full-access" as const,
      developerInstructions: roleInstructions,
      config: {
        ...(agent.threadId || agent.inheritSettings
          ? {}
          : { model_reasoning_effort: agent.effort }),
        "features.multi_agent": true,
        "features.multi_agent_v2": true,
        "mcp_servers.flickgrove": {
          command: process.execPath,
          args: [fileURLToPath(new URL("./mcp.ts", import.meta.url))],
          env: {
            FLICKGROVE_ORIGIN: this.options.origin(),
            FLICKGROVE_AGENT_TOKEN: agent.token,
          },
        },
      },
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
          });
      threadId = response.thread.id;
      this.threads.set(threadId, client);
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
        effort:
          response.reasoningEffort ??
          (this.catalogModels ?? (await this.models())).find(
            (m) => m.id === response.model,
          )?.defaultEffort ??
          "",
        serviceTier: response.serviceTier ?? "default",
      };
    } catch (error) {
      off.forEach((f) => f());
      if (threadId && this.threads.get(threadId) === client) {
        this.threads.delete(threadId);
        await client.call("thread/unsubscribe", { threadId }).catch(() => {});
      }
      if (
        error instanceof AppServerRpcError &&
        /already has an active writer/i.test(error.message)
      )
        throw new Error(
          "This session is in use by another Codex instance. Close it there, then retry.",
        );
      throw error;
    } finally {
      if (agent.threadId) this.openingThreads.delete(agent.threadId);
    }
    const id = threadId!;
    return {
      threadId: id,
      threadName,
      historyCursor,
      ...resumedSettings,
      readSettings: async () => {
        if (closed || this.threads.get(id) !== client)
          throw new Error("Session connection unavailable");
        // Loaded-thread resume returns its live config snapshot without rebuilding
        // or starting a turn. No setting overrides are sent.
        const value = await client.threadResume({
          threadId: id,
          excludeTurns: true,
        });
        if (closed || this.threads.get(id) !== client)
          throw new Error("Session connection changed");
        return {
          model: value.model,
          effort:
            value.reasoningEffort ??
            (this.catalogModels ?? (await this.models())).find(
              (m) => m.id === value.model,
            )?.defaultEffort ??
            "",
          serviceTier: value.serviceTier ?? "default",
        };
      },
      updateSettings: async (settings) => {
        if (closed || this.threads.get(id) !== client)
          throw new Error("Session connection unavailable");
        const confirmation = Promise.withResolvers<ExecutionSettings>();
        // RPC {} admits the core operation; the native notification confirms it.
        const unsubscribe = client.onNotification(
          "thread/settings/updated",
          (p) => {
            if (p.threadId !== id) return;
            const value = p.threadSettings;
            if (
              (!("model" in settings) || value.model === settings.model) &&
              (!("effort" in settings) || value.effort === settings.effort) &&
              (value.serviceTier ?? "default") === settings.serviceTier
            )
              confirmation.resolve({
                model: value.model,
                effort:
                  value.effort ??
                  this.catalogModels?.find((m) => m.id === value.model)
                    ?.defaultEffort ??
                  "",
                serviceTier: value.serviceTier ?? "default",
              });
          },
        );
        const timer = setTimeout(
          () =>
            confirmation.reject(
              new Error(
                "Settings outcome unknown. Reopen the session to check before saving again.",
              ),
            ),
          5000,
        );
        // Attach rejection before awaiting the RPC, including connection failures.
        const confirmed = confirmation.promise;
        void confirmed.catch(() => {});
        try {
          await client.call(
            "thread/settings/update",
            {
              threadId: id,
              ...settings,
              ...("effort" in settings
                ? { effort: settings.effort as ReasoningEffort }
                : {}),
            },
            { timeoutMs: 5000 },
          );
          const value = await confirmed;
          if (closed || this.threads.get(id) !== client)
            throw new Error(
              "Session connection changed. Settings outcome unknown.",
            );
          return value;
        } finally {
          clearTimeout(timer);
          unsubscribe();
        }
      },
      rename: async (name) => {
        titleGeneration?.abort();
        await client.call("thread/name/set", { threadId: id, name });
      },
      send: async (text, activeTurn, images = []) => {
        const input: v2.UserInput[] = [
          ...(text ? [{ type: "text" as const, text, text_elements: [] }] : []),
          ...images.map((path) => ({ type: "localImage" as const, path })),
        ];
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
        if (closed) return;
        titleGeneration?.abort();
        if (!nativeReleased) {
          if (this.threads.get(id) !== client)
            throw new Error(
              "Native release outcome unknown: session connection changed. Retry Close.",
            );
          // Register before unsubscribe: thread/closed can precede the RPC ack.
          // Native shutdown has a 10s budget; stay inside Chord's existing 30s.
          releaseWaiter = Promise.withResolvers<void>();
          const released = releaseWaiter.promise;
          void released.catch(() => {});
          const timer = setTimeout(
            () =>
              releaseWaiter?.reject(
                new Error("Native thread release unconfirmed. Retry Close."),
              ),
            15_000,
          );
          try {
            try {
              await client.call(
                "thread/unsubscribe",
                { threadId: id },
                { timeoutMs: 15_000 },
              );
            } catch (error) {
              if (!nativeReleased) throw error;
            }
            await released;
          } finally {
            clearTimeout(timer);
            releaseWaiter = undefined;
          }
        }
        if (this.threads.get(id) === client) this.threads.delete(id);
        closed = true;
        off.forEach((f) => f());
      },
    };
  }
  async close() {
    const managed = this.managed;
    this.managed = undefined;
    this.threads.clear();
    if (managed) await managed.then((client) => client.close()).catch(() => {});
  }
}

function executionErrorKind(error: {
  message: string;
  codexErrorInfo: unknown;
}): "capacity" | "error" {
  return error.codexErrorInfo === "serverOverloaded" ||
    (error.codexErrorInfo == null &&
      /selected model (?:is )?at capacity/i.test(error.message))
    ? "capacity"
    : "error";
}
