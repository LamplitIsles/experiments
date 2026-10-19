import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rename } from "node:fs/promises";
import sharp from "sharp";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { z } from "zod";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  createMcpExtension,
  getAgentDir,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  parseSessionEntries,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sameDirectory } from "./directory";
import { roleInstructions } from "./role-instructions";
import { roleTools, toolDefinitions } from "./tools";
import { PiAdmission } from "./pi-admission";
import {
  DeliveryRejected,
  StaleTurn,
  type RuntimeAgent,
  type RuntimeEvent,
  type RuntimeHandle,
  type ExecutionSettings,
} from "./runtime";

function piErrorKind(message: string | undefined): "capacity" | "error" {
  return /\b(?:429|503|overloaded|at capacity|rate.?limit|too many requests)\b/i.test(
    message ?? "",
  )
    ? "capacity"
    : "error";
}

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
const questionSchema = z.object({
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

/** One native Pi session and the resources retained until its handle closes. */
export async function openPiSession(
  agent: RuntimeAgent,
  notify: (event: RuntimeEvent) => void,
  options: PiSessionOptions,
): Promise<RuntimeHandle> {
  const cwd = agent.project.path;
  const { agentDir, selection } = options;
  if (resolve(agentDir) !== resolve(getAgentDir()))
    throw new Error(
      "Pi agent directory must match the host PI_CODING_AGENT_DIR",
    );
  let models: ModelRuntime;
  try {
    models = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
  } catch {
    throw new DeliveryRejected("Pi configuration could not be loaded");
  }
  const selected = models.getModel(selection.provider, selection.model);
  if (!selected)
    throw new DeliveryRejected("The selected Pi model is unavailable");
  if (!models.hasConfiguredAuth(selection.provider))
    throw new DeliveryRejected(
      "The selected Pi provider has no configured credentials",
    );
  let manager: SessionManager;
  if (agent.threadId) {
    const path =
      options.sessionPath ??
      SessionManager.findById(cwd, agent.threadId, options.sessionDir);
    if (!path) throw new Error("Pi session was not found");
    const header = parseSessionEntries(await readFile(path, "utf8")).find(
      (entry) => entry.type === "session",
    );
    if (!header || header.id !== agent.threadId)
      throw new DeliveryRejected("The original Pi session is unavailable");
    manager = SessionManager.open(path);
    if (manager.getSessionId() !== agent.threadId)
      throw new DeliveryRejected("The original Pi session is unavailable");
  } else {
    // Pi intentionally defers fresh file creation until a user message. Grove
    // needs an empty session to survive restart and native metadata edits. The
    // public open(empty-file) contract initializes its own native header; no
    // user item or acceptance is fabricated by this bootstrap.
    const draft = SessionManager.create(cwd, options.sessionDir);
    const path = draft.getSessionFile()!;
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    manager = SessionManager.open(path, options.sessionDir, cwd);
    const initializedPath = join(
      manager.getSessionDir(),
      basename(path).replace(draft.getSessionId(), manager.getSessionId()),
    );
    await rename(path, initializedPath);
    manager = SessionManager.open(initializedPath, options.sessionDir, cwd);
  }
  if (!sameDirectory(manager.getCwd(), cwd))
    throw new Error("Pi session belongs to another project");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createToolSearchExtension(),
      createMcpExtension(),
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName.startsWith("mcp__flickgrove__"))
            return {
              block: true,
              reason:
                "Use this session's Grove tools, which retain its role and owner.",
            };
        });
      },
    ],
    noThemes: true,
    additionalSkillPaths: [
      fileURLToPath(new URL("../skills", import.meta.url)),
    ],
    systemPromptOverride: (base) =>
      `${base ?? ""}\n\n${roleInstructions(agent)}`,
  });
  await resourceLoader.reload();
  const defaults = settingsManager.getDefaultTools();
  const additions = ["codemode", "tool_search"];
  const modifiers = defaults?.every((name) => /^[+-]/.test(name)) ?? true;
  settingsManager.applyOverrides({
    defaultTools: modifiers
      ? [
          ...(defaults ?? []).filter(
            (name) => !additions.some((tool) => name === `-${tool}`),
          ),
          ...additions.map((name) => `+${name}`),
        ]
      : [...new Set([...defaults!, ...additions])],
  });

  let closing: Promise<void> | undefined;
  let closed = false,
    runId: string | undefined,
    failure: string | undefined;
  let failureKind: "capacity" | "error" = "error";
  const dispatch = (event: RuntimeEvent) => {
    if (!closed) notify({ ...event, threadId: manager.getSessionId() });
  };
  const names = roleTools[agent.role];
  const customTools: ToolDefinition[] = names.map((name) => ({
    name,
    label: name,
    description: toolDefinitions[name].description,
    parameters: z.toJSONSchema(z.object(toolDefinitions[name].shape)),
    async execute(_id: string, args: unknown) {
      const result = await options.tool(agent.token, name, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {},
      };
    },
  }));
  customTools.push({
    name: "request_user_input_async",
    label: "Ask a question",
    description:
      "Ask asynchronously through Grove. Returns immediately; answers arrive as a later instruction.",
    parameters: z.toJSONSchema(questionSchema),
    async execute(itemId: string, args: unknown) {
      const input = questionSchema.parse(args);
      manager.appendCustomEntry("grove-question", {
        itemId,
        questions: input.questions,
        runId,
      });
      dispatch({
        type: "item",
        turnId: runId!,
        item: {
          id: itemId,
          type: "agentMessage",
          delivery: "async",
          questions: input.questions.map((q) => ({
            header: q.title,
            question: q.question,
            options: q.options?.map((label) => ({ label })),
          })),
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "Questions recorded. Continue independent work; answers arrive in a later message.",
          },
        ],
        details: {},
      };
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model: selected,
    thinkingLevel: selection.effort as AgentSession["thinkingLevel"],
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    customTools,
  });
  if (
    !session
      .getAvailableThinkingLevels()
      .includes(selection.effort as AgentSession["thinkingLevel"])
  ) {
    session.dispose();
    throw new DeliveryRejected(
      "The selected Pi reasoning effort is unavailable",
    );
  }
  try {
    await session.bindExtensions({});
  } catch (error) {
    try {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session.dispose();
    }
    throw error;
  }
  const admission = new PiAdmission(session, manager, (receipt, message) => {
    dispatch({
      type: "item",
      turnId: receipt.runId,
      item: {
        id: receipt.itemId,
        type: "userMessage",
        clientId: receipt.operation,
        text:
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((x) => x.type === "text")
                .map((x) => x.text)
                .join("\n"),
      },
    });
  });
  const unsub = session.agent.subscribe((event) => {
    if (
      closed ||
      !runId ||
      event.type !== "message_end" ||
      event.message.role !== "assistant"
    )
      return;
    const entry = manager.getLeafEntry();
    if (entry?.type !== "message" || entry.message !== event.message) return;
    failureKind = piErrorKind(event.message.errorMessage);
    failure =
      event.message.stopReason === "error"
        ? "Pi request failed. Check the selected provider’s configuration and availability."
        : undefined;
    dispatch({
      type: "item",
      turnId: runId,
      item: {
        id: entry.id,
        type: "agentMessage",
        text: event.message.content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n"),
      },
    });
  });
  const settled = session.subscribe((event) => {
    if (closed || !runId) return;
    if (event.type === "agent_settled") {
      failure ??= session.agent.state.errorMessage
        ? "Pi execution failed. Check the selected provider’s configuration and availability."
        : undefined;
      dispatch({
        type: "completed",
        turnId: runId,
        status: event.aborted
          ? "interrupted"
          : failure
            ? "failed"
            : "completed",
        error: failure,
        errorKind: failureKind,
      });
      runId = undefined;
    } else if (
      event.type === "auto_retry_start" ||
      event.type === "summarization_retry_scheduled"
    ) {
      dispatch({
        type: "error",
        turnId: runId,
        error:
          piErrorKind(event.errorMessage) === "capacity"
            ? "Pi is waiting for provider capacity"
            : "Pi is retrying the request",
        errorKind: piErrorKind(event.errorMessage),
        willRetry: true,
      });
    } else if (
      event.type === "summarization_retry_attempt_start" ||
      (event.type === "message_start" && event.message.role === "assistant")
    ) {
      dispatch({ type: "progress", turnId: runId });
    }
  });
  let current: ExecutionSettings = {
    provider: selection.provider,
    model: selection.model,
    effort: session.thinkingLevel,
    serviceTier: "default",
  };
  const handle: RuntimeHandle = {
    threadId: manager.getSessionId(),
    threadName: manager.getSessionName() ?? null,
    ...current,
    async readSettings() {
      return { ...current };
    },
    async updateSettings(value) {
      if (closed) throw new Error("Pi session is closed");
      if ("serviceTier" in value && value.serviceTier !== "default")
        throw new Error("Fast is unavailable for Pi");
      if ("model" in value) {
        const model = models.getModel(
          value.provider ?? current.provider!,
          value.model,
        );
        if (!model) throw new Error("The selected Pi model is unavailable");
        if (
          !getSupportedThinkingLevels(model).includes(
            value.effort as AgentSession["thinkingLevel"],
          )
        )
          throw new Error("The selected Pi reasoning effort is unavailable");
        if (!models.hasConfiguredAuth(model.provider))
          throw new Error(
            "The selected Pi provider has no configured credentials",
          );
        // Confirm the next execution's native configuration while retaining
        // this run's captured model/effort until its settled boundary.
        manager.appendModelChange(model.provider, model.id);
        manager.appendThinkingLevelChange(value.effort);
        current = {
          provider: value.provider ?? current.provider,
          model: value.model,
          effort: value.effort,
          serviceTier: "default",
        };
      }
      return { ...current };
    },
    async rename(title) {
      if (closed) throw new Error("Pi session is closed");
      manager.appendSessionInfo(title);
    },
    async send(text, turnId, images = [], clientId) {
      if (closed) throw new DeliveryRejected("Pi session is closed");
      if (turnId && turnId !== runId)
        throw new StaleTurn("Pi run has settled", runId);
      if (images.length && settingsManager.getBlockImages())
        throw new DeliveryRejected("Image reading is disabled in Pi settings");
      if (!runId) {
        try {
          await models.refresh({ allowNetwork: false });
        } catch {
          throw new DeliveryRejected("Pi configuration could not be loaded");
        }
        const model = models.getModel(current.provider!, current.model);
        if (
          !model ||
          !getSupportedThinkingLevels(model).includes(
            current.effort as AgentSession["thinkingLevel"],
          )
        )
          throw new DeliveryRejected(
            "The selected Pi model or reasoning effort is unavailable",
          );
        if (!models.hasConfiguredAuth(model.provider))
          throw new DeliveryRejected(
            "The selected Pi provider has no configured credentials",
          );
        await session.setModel(model);
        session.setThinkingLevel(
          current.effort as AgentSession["thinkingLevel"],
        );
      }
      if (images.length && !session.model?.input.includes("image"))
        throw new DeliveryRejected(
          "The selected Pi model does not support images",
        );
      const content = await Promise.all(
        images.map(async (path) => {
          try {
            const bytes = await readFile(path);
            const metadata = await sharp(bytes).metadata();
            await sharp(bytes).raw().toBuffer();
            if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? ""))
              throw new DeliveryRejected("Unsupported image format");
            return {
              type: "image" as const,
              data: bytes.toString("base64"),
              mimeType: `image/${metadata.format}`,
            };
          } catch (error) {
            if (error instanceof DeliveryRejected) throw error;
            throw new DeliveryRejected("Image could not be read or decoded");
          }
        }),
      );
      if (!runId) {
        failure = undefined;
        failureKind = "error";
        runId = crypto.randomUUID();
        dispatch({ type: "working", turnId: runId });
      }
      try {
        return (
          await admission.send(
            clientId ?? crypto.randomUUID(),
            text,
            content,
            runId,
          )
        ).runId;
      } catch (error) {
        if (error instanceof DeliveryRejected) throw error;
        if (!closed && runId && session.isIdle) {
          dispatch({
            type: "completed",
            turnId: runId,
            status: "failed",
            error: "Pi execution failed before admission could be confirmed",
          });
          runId = undefined;
        }
        throw new Error(
          "Pi admission could not be confirmed; inspect this operation before continuing",
        );
      }
    },
    async interrupt(turnId) {
      if (turnId !== runId) throw new StaleTurn("Pi run has settled", runId);
      session.clearQueue();
      await session.abort();
    },
    async title() {
      return undefined;
    },
    async close() {
      if (closing) return closing;
      closed = true;
      admission.dispose();
      unsub();
      settled();
      session.clearQueue();
      closing = (async () => {
        try {
          await session.abort();
        } finally {
          try {
            await session.extensionRunner.emit({
              type: "session_shutdown",
              reason: "quit",
            });
          } finally {
            session.dispose();
          }
        }
      })();
      try {
        await closing;
      } catch (error) {
        closing = undefined;
        throw error;
      }
    },
  };
  return handle;
}
