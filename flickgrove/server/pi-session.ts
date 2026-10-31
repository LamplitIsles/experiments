import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  type ModelThinkingLevel,
  type TSchema,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import {
  Harness,
  createRegistry,
  defineExtension,
  type ToolRegistration,
  type ConversationWatch,
  type ConversationView,
  type LiveState,
  type SubmissionRecord,
  type EntryRecord,
  type InboxState,
  LiveDoc,
  InboxDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import {
  createCodingTools,
  DEFAULT_IMAGE_LIMITS,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { roleInstructions } from "./role-instructions";
import { roleTools, toolDefinitions } from "./tools";
import { PiMetadata, PiOperation, PiWithdrawal } from "./pi-documents";
import { openPiStorage, acquirePiWriter } from "./pi-storage";
import { recoveredPiActivity } from "./pi-completion";
import { openPiMcp } from "./pi-mcp";
import { createDeepSeekSearch } from "./pi-deepseek-search";
import { parseTitle, titlePrompt } from "./thread-title";
import {
  DeliveryRejected,
  StaleTurn,
  type RuntimeAgent,
  type RuntimeEvent,
  type RuntimeHandle,
  type ExecutionSettings,
} from "./runtime";

export interface PiSelection {
  provider: string;
  model: string;
  effort: string;
}
export interface PiSessionOptions {
  agentDir: string;
  sessionDir: string;
  sessionPath?: string;
  selection: PiSelection;
  tool: (token: string, name: string, args: unknown) => Promise<unknown>;
}
export const piSessionPath = (directory: string, id: string) =>
  join(directory, `${id}.sqlite`);
export function entryText(entry: EntryRecord) {
  return (
    entryMessages(entry)
      .flatMap((message) =>
        "content" in message
          ? typeof message.content === "string"
            ? [message.content]
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
          : [],
      )
      .join("\n") ?? ""
  );
}
export function entryMessages(entry: EntryRecord) {
  if (entry.kind === "grove.withdrawn") {
    const data = entry.data as { content: UserMessage["content"] };
    return [{ role: "user" as const, content: data.content, timestamp: 0 }];
  }
  return entry.model ?? [];
}
const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        title: z.string().optional(),
        question: z.string(),
        options: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** One Grove-owned Harness, storage writer lock, environment and fixed MCP extension. */
export async function openPiSession(
  agent: RuntimeAgent,
  notify: (event: RuntimeEvent) => void,
  options: PiSessionOptions,
): Promise<RuntimeHandle> {
  const ctx = BACKGROUND_CONTEXT,
    cwd = agent.project.path;
  if (resolve(options.agentDir) !== resolve(getAgentDir()))
    throw new Error(
      "Pi agent directory must match the host PI_CODING_AGENT_DIR",
    );
  let persistedTurn = agent.turnId;
  const id = agent.threadId ?? crypto.randomUUID(),
    path = options.sessionPath ?? piSessionPath(options.sessionDir, id);
  if (agent.threadId) await access(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquirePiWriter(path);
  let storage: Awaited<ReturnType<typeof openPiStorage>> | undefined,
    harness: Harness | undefined,
    mcp: Awaited<ReturnType<typeof openPiMcp>> | undefined;
  let env = new NodeExecutionEnv({ cwd });
  const sandbox = new CodemodeSandbox();
  let photon: Promise<ImageProcessor> | undefined;
  // The public processor has no dispose hook. In-process mode owns no worker,
  // timer or background task; Photon frees each image and retains process WASM.
  const imageProcessor: ImageProcessor = {
    async prepare(...args) {
      if (closed) throw new Error("Pi session is closed");
      const processor = await (photon ??= createNodePhotonImages({
        worker: false,
      }));
      if (closed) throw new Error("Pi session is closed");
      return processor.prepare(...args);
    },
  };
  let closed = false,
    closing: Promise<void> | undefined,
    watch: ConversationWatch | undefined;
  let titleGeneration: AbortController | undefined;
  let titleRevision = 0;
  let sending: Promise<unknown> = Promise.resolve(),
    projecting: Promise<void> = Promise.resolve();
  const cleanup = () =>
    (closing ??= (async () => {
      closed = true;
      titleGeneration?.abort();
      await sending;
      const watchResults = await Promise.allSettled([watch?.stop()]);
      await projecting.catch(() => {});
      const results = [
        ...watchResults,
        ...(await Promise.allSettled([
          harness ? harness.close(ctx) : storage?.close(ctx),
          mcp?.close(),
          env.cleanup(ctx),
          sandbox.close(),
        ])),
      ];
      results.push(...(await Promise.allSettled([release()])));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Pi resources could not be released",
        );
    })());
  // The first native snapshot includes history, not newly observed activity.
  let replaying = true;
  const dispatch = (event: RuntimeEvent) => {
    if (!closed) notify({ ...event, threadId: id, replayed: replaying });
  };
  try {
    let models: ModelRuntime;
    try {
      models = await ModelRuntime.create({
        authPath: join(options.agentDir, "auth.json"),
        modelsPath: join(options.agentDir, "models.json"),
        modelsStorePath: join(options.agentDir, "models-store.json"),
        allowModelNetwork: false,
      });
    } catch {
      throw new DeliveryRejected("Pi configuration could not be loaded");
    }
    if (models.getError())
      throw new DeliveryRejected("Pi configuration could not be loaded");
    const validate = (selection: PiSelection) => {
      const model = models.getModel(selection.provider, selection.model);
      if (
        !model ||
        !getSupportedThinkingLevels(model).includes(
          selection.effort as ModelThinkingLevel,
        )
      )
        throw new DeliveryRejected(
          "The selected Pi model or reasoning effort is unavailable",
        );
      if (!models.hasConfiguredAuth(selection.provider))
        throw new DeliveryRejected(
          "The selected Pi provider has no configured credentials",
        );
      return model;
    };
    validate(options.selection);
    const settings = SettingsManager.create(cwd, options.agentDir);
    if (settings.drainErrors().length)
      throw new DeliveryRejected("Pi settings could not be loaded");
    env = new NodeExecutionEnv({ cwd, shellPath: settings.getShellPath() });
    const prefix = settings.getShellCommandPrefix();
    if (prefix) {
      const exec = env.exec.bind(env);
      env.exec = (command, options, context) =>
        exec(
          typeof command === "string" ? `${prefix}\n${command}` : command,
          options,
          context,
        );
    }
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) =>
      streamSimple(model, context, {
        ...options,
        thinkingBudgets: settings.getThinkingBudgets(),
      });
    // This capability is built in. Exclude the upstream package from resource
    // discovery so Pi does not install it when a configured copy is missing.
    const globalResources = settings.getGlobalSettings();
    const projectResources = settings.getProjectSettings();
    for (const resources of [globalResources, projectResources])
      resources.packages = resources.packages?.filter((entry) => {
        const source = typeof entry === "string" ? entry : entry.source;
        return !/^npm:pi-deepseek-search(?:@[^\s]+)?$/.test(source);
      });
    const resourceSettings = SettingsManager.fromStorage(
      {
        withLock(scope, read) {
          read(
            JSON.stringify(
              scope === "global" ? globalResources : projectResources,
            ),
          );
        },
      },
      { projectTrusted: settings.isProjectTrusted() },
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: options.agentDir,
      settingsManager: resourceSettings,
      noExtensions: true,
      disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
      noThemes: true,
      additionalSkillPaths: [
        fileURLToPath(new URL("../skills", import.meta.url)),
      ],
    });
    try {
      await loader.reload();
    } catch {
      throw new DeliveryRejected("Pi resources could not be loaded");
    }
    const instructions = [
      loader.getSystemPrompt() ??
        "You are a coding assistant. Use read to load a skill's SKILL.md when its description matches the task.",
      ...loader.getAppendSystemPrompt(),
      ...loader
        .getAgentsFiles()
        .agentsFiles.map((file) => `# ${file.path}\n${file.content}`),
      formatSkillsForPrompt(loader.getSkills().skills),
      roleInstructions(agent),
    ].join("\n\n");
    const registry = createRegistry();
    const CodingTools = createCodingTools({ images: imageProcessor });
    const defaultTools = settings.getDefaultTools();
    const modifiers = defaultTools?.every((name) => /^[+-]/.test(name));
    const codingNames = new Set(
      defaultTools === undefined || modifiers
        ? CodingTools.tools!.map((tool) => tool.name)
        : defaultTools,
    );
    if (modifiers)
      for (const entry of defaultTools!) {
        if (entry.startsWith("-")) codingNames.delete(entry.slice(1));
        else codingNames.add(entry.slice(1));
      }
    registry.install({
      ...CodingTools,
      tools: CodingTools.tools!.filter((tool) => codingNames.has(tool.name)),
    });
    registry.install(createCodemodeExtension({ sandbox }));
    registry.install(createToolSearchExtension());
    registry.install(createDeepSeekSearch(models));
    mcp = await openPiMcp({
      agentDir: options.agentDir,
      cwd,
      trusted: settings.isProjectTrusted(),
    });
    registry.install(mcp.extension);
    let mcpClosed = false;
    let runId: string | undefined;
    const custom: ToolRegistration[] = roleTools[agent.role].map((name) => ({
      name,
      description: toolDefinitions[name].description,
      parameters: z.toJSONSchema(
        z.object(toolDefinitions[name].shape),
      ) as TSchema,
      replay: "unsafe",
      async execute(args) {
        const result = await options.tool(agent.token, name, args);
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }));
    custom.push({
      name: "request_user_input_async",
      description:
        "Ask asynchronously through Grove. Continue independent work; answers arrive as a later instruction.",
      parameters: z.toJSONSchema(questionsSchema) as TSchema,
      replay: "unsafe",
      async execute(args, api, context) {
        const input = questionsSchema.parse(args),
          itemId = api.callId;
        await api.commit(
          (tx) =>
            tx.appendEntry(api.conversationId, {
              kind: "grove.question",
              data: {
                itemId,
                questions: input.questions,
                runId: runId ?? String(api.taskId),
              },
            }),
          context,
        );
        return {
          output: [
            {
              type: "text",
              text: "Questions recorded. Continue independent work; answers arrive in a later message.",
            },
          ],
        };
      },
    });
    registry.install(defineExtension({ name: "grove", tools: custom }));
    storage = await openPiStorage(path);
    if (
      agent.threadId &&
      !(await storage.conversation(ROOT_CONVERSATION_ID, ctx))
    )
      throw new Error("The original Pi session is unavailable");
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: () => env,
        settings: {
          retry: settings.getRetrySettings(),
          compaction: settings.getCompactionSettings(
            validate(options.selection),
          ),
          steeringMode: settings.getSteeringMode(),
          followUpMode: settings.getFollowUpMode(),
          stream: {
            transport: settings.getTransport(),
            timeoutMs:
              settings.getProviderRetrySettings().timeoutMs ??
              (settings.getHttpIdleTimeoutMs() || 2147483647),
            maxRetries: settings.getProviderRetrySettings().maxRetries,
            maxRetryDelayMs:
              settings.getProviderRetrySettings().maxRetryDelayMs,
          },
        },
        onReport() {},
      },
      ctx,
    );
    void harness.closed
      .then((end) => {
        if (end.reason === "failed")
          dispatch({
            type: "disconnected",
            error:
              "Pi runtime failed. Inspect the original operation before continuing.",
          });
      })
      .catch(() => {});
    const root = await harness.root(ctx, {
      agent: {
        model: {
          provider: options.selection.provider,
          modelId: options.selection.model,
        },
        thinkingLevel: options.selection.effort as ModelThinkingLevel,
        cwd,
        instructions,
      },
    });
    if (!agent.threadId)
      await root.commit(async (tx) => {
        const metadata = await tx.doc(PiMetadata);
        metadata.id = id;
        metadata.agentId = agent.id;
        metadata.role = agent.role;
        metadata.ownerId = agent.ownerId ?? "";
        metadata.cwd = cwd;
        metadata.title = agent.title;
      }, ctx);
    const metadata = await harness.snapshot(PiMetadata, ctx);
    if (
      metadata?.id !== id ||
      metadata.agentId !== agent.id ||
      metadata.role !== agent.role ||
      metadata.ownerId !== (agent.ownerId ?? "") ||
      resolve(metadata.cwd) !== resolve(cwd)
    )
      throw new Error("The original Pi session is unavailable");
    const originalAgent = await root.agent(ctx);
    if (originalAgent.cwd && resolve(originalAgent.cwd) !== resolve(cwd))
      throw new Error("Pi session belongs to another project");
    let current: ExecutionSettings = {
      provider: options.selection.provider,
      model: options.selection.model,
      effort: options.selection.effort,
      serviceTier: "default",
    };
    watch = await root.watch(ctx);
    let lastEntry = 0;
    const knownSubmissions = new Map<number, SubmissionRecord>();
    const pending = new Set<number>();
    let runInputs = new Set<number>();
    for (const delivery of agent.deliveries.filter(
      (d) =>
        d.status !== "failed" &&
        (d.status !== "sent" || d.turnId === persistedTurn),
    )) {
      const record = await storage.submissionByRequest(
        root.id,
        delivery.id,
        ctx,
      );
      if (record) pending.add(record.id);
    }
    runInputs = new Set(pending);
    const liveOf = (value: ConversationView) =>
      value.docs["pi.live"] as LiveState | undefined;
    const project = async (value: ConversationView) => {
      if (closed) return;
      const nativeNext = liveOf(value)?.run?.taskId;
      const next = nativeNext === undefined ? undefined : String(nativeNext);
      // The initial snapshot may contain work committed before its observer ran.
      const recoveredEnd =
        replaying && !next && persistedTurn
          ? await recoveredPiActivity(
              storage!,
              root.id,
              persistedTurn,
              agent.deliveries,
            )
          : undefined;
      if (next && next !== runId) {
        runInputs = new Set(liveOf(value)?.run?.inputs ?? []);
        runId = next;
        dispatch({ type: "working", turnId: next });
      }
      const active = runId ?? persistedTurn ?? "history";
      let newestEntry = lastEntry;
      for (const entry of value.entries) {
        if (entry.id <= lastEntry) continue;
        newestEntry = Math.max(newestEntry, entry.id);
        if (entry.kind === "grove.input") {
          const data = entry.data as { operation: string };
          dispatch({
            type: "item",
            turnId: active,
            item: {
              id: String(entry.id),
              type: "userMessage",
              clientId: data.operation,
              text: entryText(entry),
            },
          });
        } else if (entry.kind === "grove.withdrawn") {
          const data = entry.data as {
            operation: string;
            submissionId: number;
          };
          const receipt = await storage!.submission(
            data.submissionId as SubmissionRecord["id"],
            ctx,
          );
          if (
            receipt?.status === "unanswered" &&
            receipt.reason === "aborted" &&
            !receipt.entry
          ) {
            dispatch({
              type: "item",
              turnId: active,
              item: {
                id: String(entry.id),
                type: "userMessage",
                clientId: data.operation,
                text: entryText(entry),
              },
            });
            dispatch({
              type: "submission",
              operationId: data.operation,
              status: "unanswered",
              turnId: active,
              reason: "aborted",
            });
          }
        } else if (entry.kind === "pi.assistant") {
          const text = entryText(entry);
          if (!text.trim()) continue;
          dispatch({
            type: "item",
            turnId: active,
            item: {
              id: String(entry.id),
              type: "agentMessage",
              text,
            },
          });
        } else if (entry.kind === "grove.question") {
          const data = entry.data as {
            itemId: string;
            runId: string;
            questions: z.infer<typeof questionsSchema>["questions"];
          };
          dispatch({
            type: "item",
            turnId: data.runId,
            item: {
              id: data.itemId,
              type: "agentMessage",
              delivery: "async",
              questions: data.questions.map((q) => ({
                header: q.title,
                question: q.question,
                options: q.options?.map((label) => ({ label })),
              })),
            },
          });
        }
      }
      lastEntry = newestEntry;
      for (const input of liveOf(value)?.run?.inputs ?? []) {
        pending.add(input);
        runInputs.add(input);
      }
      for (const input of (value.docs["pi.inbox"] as InboxState | undefined)
        ?.items ?? [])
        pending.add(input.id);
      for (const input of pending) {
        const submission = await storage!.submission(
          input as SubmissionRecord["id"],
          ctx,
        );
        if (!submission) continue;
        const prior = knownSubmissions.get(input);
        knownSubmissions.set(input, submission);
        if (
          submission.status === "unanswered" &&
          submission.reason === "aborted" &&
          !submission.entry
        ) {
          const capture = value.entries.find(
            (entry) =>
              entry.kind === "grove.withdrawn" &&
              (entry.data as { submissionId: number }).submissionId ===
                submission.id,
          );
          if (capture)
            dispatch({
              type: "item",
              turnId: active,
              item: {
                id: String(capture.id),
                type: "userMessage",
                clientId: submission.requestId,
                text: entryText(capture),
              },
            });
        }
        if (submission.requestId && prior?.status !== submission.status)
          dispatch({
            type: "submission",
            operationId: submission.requestId,
            status: submission.status,
            turnId: active,
            itemId:
              submission.entry === undefined
                ? undefined
                : String(submission.entry),
            reason:
              submission.status === "unanswered"
                ? submission.reason
                : undefined,
          });
        if (submission.status === "done" || submission.status === "unanswered")
          pending.delete(input);
      }
      const retry = liveOf(value)?.generation?.retry;
      if (next && retry)
        dispatch({
          type: "error",
          turnId: next,
          error: "Pi is waiting to retry the provider request",
          willRetry: true,
          errorKind: /429|503|capacity|rate.?limit|overload|too many/i.test(
            retry.error,
          )
            ? "capacity"
            : "error",
        });
      else if (next) dispatch({ type: "progress", turnId: next });
      if (!next && (runId || persistedTurn)) {
        const settledRun = runId ?? persistedTurn!;
        const interrupted = [...knownSubmissions.values()]
          .filter((s) => runInputs.has(s.id))
          .some((s) => s.status === "unanswered" && s.reason === "aborted");
        const failed = [...knownSubmissions.values()]
          .filter((s) => runInputs.has(s.id))
          .some((s) => s.status === "unanswered" && s.reason !== "aborted");
        dispatch({
          type: "completed",
          turnId: settledRun,
          ...(recoveredEnd === undefined
            ? {}
            : { recoveredActivityAt: recoveredEnd }),
          status: interrupted ? "interrupted" : failed ? "failed" : "completed",
          ...(failed
            ? {
                error:
                  "Pi work ended without an answer. Inspect the conversation before continuing.",
              }
            : {}),
        });
        runId = undefined;
        persistedTurn = undefined;
        runInputs.clear();
        knownSubmissions.clear();
      }
    };
    await project(watch.value);
    replaying = false;
    watch.start((value) => {
      projecting = project(value);
      return projecting;
    });
    void watch.closed
      .then((end) => {
        if (
          !closed &&
          (end.reason === "listener_error" || end.reason === "session_failed")
        ) {
          try {
            dispatch({
              type: "disconnected",
              error:
                "Pi observation failed. Inspect the original operation before continuing.",
            });
          } finally {
            void cleanup().catch(() => {});
          }
        }
      })
      .catch(() => {});
    harness.resume();
    const serialize = <T>(work: () => Promise<T>) => {
      const result = sending.then(work, work);
      sending = result.catch(() => {});
      return result;
    };
    const handle: RuntimeHandle = {
      threadId: id,
      threadName: metadata.title === "New session" ? null : metadata.title,
      ...current,
      async readSettings() {
        return { ...current };
      },
      async updateSettings(value) {
        if (closed) throw new Error("Pi session is closed");
        if (value.serviceTier !== "default")
          throw new Error("Fast is unavailable for Pi");
        if ("model" in value) {
          validate({
            provider: value.provider ?? current.provider!,
            model: value.model,
            effort: value.effort,
          });
          current = {
            ...value,
            provider: value.provider ?? current.provider,
            serviceTier: "default",
          };
        }
        return { ...current };
      },
      async rename(title) {
        titleRevision++;
        await root.commit(async (tx) => {
          (await tx.doc(PiMetadata)).title = title;
        }, ctx);
      },
      async send(text, observed, images = [], clientId, envelopeContext) {
        return serialize(async () => {
          if (closed) throw new DeliveryRejected("Pi session is closed");
          const nativeActive = (await harness!.snapshot(LiveDoc, root.id, ctx))
            ?.run?.taskId;
          const active =
            nativeActive === undefined ? undefined : String(nativeActive);
          if (observed && observed !== active)
            throw new StaleTurn("Pi run has settled", active);
          if (!active) {
            try {
              await models.refresh({ allowNetwork: false });
            } catch {
              throw new DeliveryRejected(
                "Pi configuration could not be loaded",
              );
            }
            if (mcpClosed) {
              mcp = await openPiMcp({
                agentDir: options.agentDir,
                cwd,
                trusted: settings.isProjectTrusted(),
              });
              registry.install(mcp.extension);
              mcpClosed = false;
            }
          }
          const executing = active ? await root.agent(ctx) : undefined;
          const model = validate(
            executing?.model
              ? {
                  provider: executing.model.provider,
                  model: executing.model.modelId,
                  effort: executing.thinkingLevel,
                }
              : {
                  provider: current.provider!,
                  model: current.model,
                  effort: current.effort,
                },
          );
          if (
            images.length &&
            (settings.getBlockImages() || !model.input.includes("image"))
          )
            throw new DeliveryRejected(
              settings.getBlockImages()
                ? "Image reading is disabled in Pi settings"
                : "The selected Pi model does not support images",
            );
          const originals = await Promise.all(
            images.map(async (path) => {
              try {
                const bytes = await readFile(path),
                  metadata = await sharp(bytes).metadata();
                if (
                  !["png", "jpeg", "webp", "gif"].includes(
                    metadata.format ?? "",
                  )
                )
                  throw new Error();
                return { bytes, mimeType: `image/${metadata.format}` };
              } catch {
                throw new DeliveryRejected(
                  "Image could not be read or decoded",
                );
              }
            }),
          );
          const content: UserMessage["content"] = [
            { type: "text", text },
            ...originals.map(({ bytes, mimeType }) => ({
              type: "image" as const,
              data: bytes.toString("base64"),
              mimeType,
            })),
          ];
          // Bind original bytes, before model-dependent transformation. Two
          // different originals must never dedupe because they resize alike.
          const operation = clientId ?? crypto.randomUUID(),
            fingerprint = createHash("sha256")
              .update(JSON.stringify({ content, envelopeContext }))
              .digest("hex");
          const existing = await storage!.submissionByRequest(
            root.id,
            operation,
            ctx,
          );
          const envelope = await harness!.snapshot(PiOperation, operation, ctx);
          if (envelope && envelope.fingerprint !== fingerprint)
            throw new DeliveryRejected(
              "Operation ID was already used with different content",
            );
          if (existing) {
            if (!envelope)
              throw new Error(
                "Original Pi operation metadata is unavailable; inspect before continuing",
              );
            return active ?? String(existing.id);
          }
          if (envelope)
            throw new Error(
              "Pi admission is unconfirmed; inspect the original operation before continuing",
            );
          const resize = model.inputLimits?.images?.resize;
          for (let index = 0; index < originals.length; index++) {
            try {
              const original = originals[index]!;
              const prepared = await imageProcessor.prepare(
                original.bytes,
                original.mimeType,
                {
                  maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
                  maxHeight:
                    resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
                  maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
                },
              );
              if (!prepared) throw new Error();
              content[index + 1] = {
                type: "image",
                data: prepared.data,
                mimeType: prepared.mimeType,
              };
            } catch {
              throw new DeliveryRejected(
                "Image could not be prepared for the selected Pi model",
              );
            }
          }
          await root.commit(
            (tx) => tx.doc(PiOperation, operation, fingerprint),
            ctx,
          );
          if (!active)
            await root.configure(
              {
                model: { provider: current.provider!, modelId: current.model },
                thinkingLevel: current.effort as ModelThinkingLevel,
              },
              ctx,
            );
          const submission = await root.submit(
            {
              type: "input",
              requestId: operation,
              content,
              whenBusy: "steer",
              entry: { kind: "grove.input", data: { operation, fingerprint } },
            },
            ctx,
          );
          // Use the committed native snapshot, independent of watch callback scheduling.
          pending.add(submission.id);
          return String(
            (await harness!.snapshot(LiveDoc, root.id, ctx))?.run?.taskId ??
              submission.id,
          );
        });
      },
      async interrupt(observed) {
        await serialize(async () => {
          const nativeActive = (await harness!.snapshot(LiveDoc, root.id, ctx))
            ?.run?.taskId;
          const active =
            nativeActive === undefined ? undefined : String(nativeActive);
          if (observed !== active)
            throw new StaleTurn("Pi run has settled", active);
          const queued = await harness!.snapshot(InboxDoc, root.id, ctx);
          await root.commit(async (tx) => {
            const records = await Promise.all(
              (queued?.items ?? [])
                .filter((item) => item.mode !== "write")
                .map((item) => storage!.submission(item.id, ctx)),
            );
            const inbox = await tx.doc(InboxDoc, root.id);
            for (const record of records) {
              if (record?.status !== "queued" || !record.requestId) continue;
              const item = inbox.items.find((item) => item.id === record.id);
              if (!item || item.mode === "write") continue;
              const capture = await tx.doc(
                PiWithdrawal,
                String(record.id),
                null,
              );
              if (!capture.entryId) {
                const entry = await tx.appendEntry(root.id, {
                  kind: "grove.withdrawn",
                  data: {
                    operation: record.requestId,
                    submissionId: record.id,
                    content: item.content,
                  },
                });
                capture.entryId = entry.id;
              }
            }
          }, ctx);
          await root.abort(ctx);
          await mcp!.close();
          mcpClosed = true;
        });
      },
      async title(input) {
        if (closed) return;
        const revision = titleRevision;
        const selection = {
          provider: current.provider!,
          model: current.model,
          effort: current.effort,
        };
        const model = validate(selection);
        const controller = new AbortController();
        titleGeneration = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);
        timeout.unref?.();
        try {
          const aborted = new Promise<undefined>((resolve) => {
            controller.signal.addEventListener(
              "abort",
              () => resolve(undefined),
              { once: true },
            );
          });
          const response = await Promise.race([
            models
              .streamSimple(
                model,
                {
                  systemPrompt:
                    'Return only a JSON object with one string property named "title".',
                  messages: [
                    {
                      role: "user",
                      content: titlePrompt(input),
                      timestamp: Date.now(),
                    },
                  ],
                },
                { signal: controller.signal, maxTokens: 256 },
              )
              .result(),
            aborted,
          ]);
          if (
            !response ||
            response.stopReason !== "stop" ||
            controller.signal.aborted ||
            closed
          )
            return;
          const title = parseTitle(
            response.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
          if (!title) return;
          let saved = false;
          await root.commit(async (tx) => {
            const metadata = await tx.doc(PiMetadata);
            if (
              !closed &&
              !controller.signal.aborted &&
              titleRevision === revision &&
              metadata.title === "New session"
            ) {
              metadata.title = title;
              saved = true;
            }
          }, ctx);
          return saved && titleRevision === revision ? title : undefined;
        } finally {
          clearTimeout(timeout);
          if (titleGeneration === controller) titleGeneration = undefined;
        }
      },
      close: cleanup,
    };
    return handle;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
