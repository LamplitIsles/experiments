import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { sameDirectory } from "./directory";
import {
  ModelRuntime,
  getAgentDir,
  DefaultPackageManager,
  CONFIG_DIR_NAME,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  HistoryPage,
  HistoryMessages,
  HistorySession,
  Model,
  Skill,
  WeeklyUsage,
  Message,
} from "../src/contracts";
import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";
import {
  openPiSession,
  piSessionPath,
  entryText,
  entryMessages,
} from "./pi-session";
import { PiMetadata } from "./pi-documents";
import { readPiStorage } from "./pi-storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  createSession,
  AgentDoc,
  type EntryRecord,
} from "@earendil-works/pi-durable";

export class PiRuntime implements Runtime {
  private readonly handles = new Set<RuntimeHandle>();
  private get sessionDir() {
    return join(this.options.agentDir, "grove-durable");
  }
  constructor(
    private readonly options: {
      agentDir: string;
      tool: (token: string, name: string, args: unknown) => Promise<unknown>;
    },
  ) {
    if (resolve(options.agentDir) !== resolve(getAgentDir()))
      throw new Error(
        "Pi agent directory must match the host PI_CODING_AGENT_DIR",
      );
  }
  private async modelsRuntime() {
    return ModelRuntime.create({
      authPath: join(this.options.agentDir, "auth.json"),
      modelsPath: join(this.options.agentDir, "models.json"),
      modelsStorePath: join(this.options.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
  }
  async models(): Promise<Model[]> {
    let runtime: ModelRuntime;
    try {
      runtime = await this.modelsRuntime();
    } catch {
      throw new Error("Pi model configuration could not be loaded");
    }
    const settings = SettingsManager.create(
      process.cwd(),
      this.options.agentDir,
    );
    if (runtime.getError())
      throw new Error("Pi model configuration could not be loaded");
    return runtime.getAvailableSnapshot().map((model) => {
      const efforts = getSupportedThinkingLevels(model);
      return {
        backend: "pi",
        provider: model.provider,
        id: model.id,
        name: `${model.name} · ${model.provider}`,
        efforts,
        defaultEffort: efforts.includes(
          settings.getDefaultThinkingLevel() ?? "medium",
        )
          ? (settings.getDefaultThinkingLevel() ?? "medium")
          : efforts[0],
        isDefault:
          settings.getDefaultProvider() === model.provider &&
          settings.getDefaultModel() === model.id,
        fastTier: null,
      };
    });
  }
  async weekly(): Promise<WeeklyUsage> {
    return { remaining: null, fetchedAt: Date.now(), source: "Pi" };
  }
  async skills(cwd: string): Promise<Skill[]> {
    const settingsManager = SettingsManager.fromStorage({
      withLock: (scope, read) => {
        const path =
          scope === "global"
            ? join(this.options.agentDir, "settings.json")
            : join(cwd, CONFIG_DIR_NAME, "settings.json");
        let content: string | undefined;
        try {
          content = readFileSync(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // SDK parses/migrates settings in memory; passive reads neither lock
        // nor apply any write returned by the storage callback.
        read(content);
      },
    });
    // The public resolver's skip callback prevents installs, but missing user
    // npm packages first trigger a legacy global npm/pnpm lookup. Only retain
    // standard managed packages for passive discovery; execution keeps Pi's
    // full official resource loader and legacy lookup behavior.
    const global = settingsManager.getGlobalSettings();
    const project = settingsManager.getProjectSettings();
    global.packages = global.packages?.filter((pkg) => {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      if (!source.startsWith("npm:")) return true;
      const name = source
        .slice(4)
        .trim()
        .match(/^(@[^/@\s]+\/[^/@\s]+|[^/@\s]+)(?:@.+)?$/)?.[1];
      return (
        !!name &&
        !name.split("/").some((part) => part === "." || part === "..") &&
        !name.includes("\\") &&
        existsSync(join(this.options.agentDir, "npm", "node_modules", name))
      );
    });
    const readonlySettings = SettingsManager.fromStorage(
      {
        withLock(scope, read) {
          read(JSON.stringify(scope === "global" ? global : project));
        },
      },
      { projectTrusted: settingsManager.isProjectTrusted() },
    );
    const packages = new DefaultPackageManager({
      cwd,
      agentDir: this.options.agentDir,
      settingsManager: readonlySettings,
    });
    const resolved = await packages.resolve(async () => "skip");
    const skillPaths = resolved.skills
      .filter((resource) => resource.enabled)
      .map((resource) => {
        const rootSkill = join(resource.path, "SKILL.md");
        return (resource.metadata.source === "auto" ||
          resource.metadata.origin === "package") &&
          existsSync(rootSkill)
          ? rootSkill
          : resource.path;
      });
    return loadSkills({
      cwd,
      agentDir: this.options.agentDir,
      includeDefaults: false,
      skillPaths: [
        ...skillPaths,
        fileURLToPath(new URL("../skills", import.meta.url)),
      ],
    }).skills.map((s) => ({ name: s.name, description: s.description }));
  }

  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid Pi session identity");
    return piSessionPath(this.sessionDir, id);
  }
  private async read<T>(
    id: string,
    body: (storage: Awaited<ReturnType<typeof readPiStorage>>) => Promise<T>,
  ) {
    const storage = await readPiStorage(this.path(id));
    try {
      return await body(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  async history(cwd: string, cursor?: string): Promise<HistoryPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid Pi history cursor");
    let names: string[];
    try {
      names = await readdir(this.sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { sessions: [], nextCursor: null };
      throw error;
    }
    const sessions: HistorySession[] = [];
    for (const name of names.filter((name) =>
      /^[a-f0-9-]{36}\.sqlite$/.test(name),
    )) {
      const item = await this.historyThread(name.slice(0, -7));
      if (sameDirectory(item.cwd, cwd)) sessions.push(item);
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      sessions: sessions.slice(offset, offset + 40),
      nextCursor: offset + 40 < sessions.length ? String(offset + 40) : null,
    };
  }
  async historyThread(id: string): Promise<HistorySession> {
    const modified = (await stat(this.path(id))).mtimeMs;
    return this.read(id, async (storage) => {
      const session = createSession(storage),
        ctx = BACKGROUND_CONTEXT;
      try {
        const agent = await session.snapshot(
          AgentDoc,
          ROOT_CONVERSATION_ID,
          ctx,
        );
        const metadata = await session.snapshot(PiMetadata, ctx);
        if (metadata?.id !== id)
          throw new Error("The original Pi session is unavailable");
        const first = await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
          1,
          undefined,
          ctx,
        );
        return {
          backend: "pi",
          threadId: id,
          title:
            metadata.title ||
            entryText(
              first.items[0] ?? {
                id: "" as never,
                conversationId: ROOT_CONVERSATION_ID,
                kind: "",
              },
            ).slice(0, 160) ||
            "Pi session",
          preview: first.items[0] ? entryText(first.items[0]) : "",
          cwd: metadata.cwd,
          updatedAt: modified,
          source: "Pi",
          archived: false,
          role: metadata.role as HistorySession["role"],
          model: agent?.model?.modelId,
          provider: agent?.model?.provider,
          effort: agent?.thinkingLevel,
        };
      } finally {
        await session.close(ctx);
      }
    });
  }
  async readTitle(id: string) {
    return (await this.historyThread(id)).title;
  }
  async historyMessages(id: string, cursor?: string): Promise<HistoryMessages> {
    return this.read(id, async (storage) => {
      const page = await storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID, order: "descending" },
        100,
        cursor
          ? JSON.parse(Buffer.from(cursor, "base64url").toString())
          : undefined,
        BACKGROUND_CONTEXT,
      );
      const messages: Message[] = [];
      for (const entry of [...page.items].reverse()) {
        if (
          ![
            "grove.input",
            "grove.withdrawn",
            "pi.assistant",
            "grove.question",
          ].includes(entry.kind)
        )
          continue;
        if (entry.kind === "grove.withdrawn") {
          const receipt = await storage.submission(
            (entry.data as { submissionId: number })
              .submissionId as import("@earendil-works/pi-durable").SubmissionId,
            BACKGROUND_CONTEXT,
          );
          if (
            receipt?.status !== "unanswered" ||
            receipt.reason !== "aborted" ||
            receipt.entry
          )
            continue;
        }
        const data = entry.data as
          | {
              operation?: string;
              itemId?: string;
              runId?: string;
              questions?: { question: string }[];
            }
          | undefined;
        const images = [];
        for (const [index, part] of entryMessages(entry)
          .flatMap((m) =>
            "content" in m && Array.isArray(m.content)
              ? m.content.filter((part) => part.type === "image")
              : [],
          )
          .entries() ?? []) {
          if (part.type !== "image") continue;
          const bytes = Buffer.from(part.data, "base64"),
            metadata = await sharp(bytes).metadata();
          images.push({
            id: `${entry.id}:${index}`,
            name: "Pi image",
            width: metadata.width!,
            height: metadata.height!,
            bytes: bytes.length,
            mediaType: part.mimeType,
          });
        }
        messages.push({
          id: data?.itemId ?? String(entry.id),
          role:
            entry.kind === "grove.input" || entry.kind === "grove.withdrawn"
              ? "user"
              : "assistant",
          text:
            entry.kind === "grove.question"
              ? (data?.questions?.map((q) => q.question).join("\n\n") ?? "")
              : entryText(entry),
          at:
            entry.model?.[0] && "timestamp" in entry.model[0]
              ? entry.model[0].timestamp
              : 0,
          clientId: data?.operation,
          turnId: data?.runId,
          ...(entry.kind === "grove.question"
            ? { questionItemId: data?.itemId }
            : {}),
          ...(images.length ? { images } : {}),
        });
      }
      return {
        messages,
        nextCursor: page.next
          ? Buffer.from(JSON.stringify(page.next)).toString("base64url")
          : null,
      };
    });
  }
  async historyImage(id: string, imageId: string): Promise<File | null> {
    return this.read(id, async (storage) => {
      const separator = imageId.lastIndexOf(":"),
        index = Number(imageId.slice(separator + 1));
      if (separator < 0 || !Number.isSafeInteger(index) || index < 0)
        return null;
      const record = await storage.entry(
        ROOT_CONVERSATION_ID,
        Number(imageId.slice(0, separator)) as EntryRecord["id"],
        BACKGROUND_CONTEXT,
      );
      const parts = (record ? entryMessages(record.entry) : []).flatMap((m) =>
          "content" in m && Array.isArray(m.content)
            ? m.content.filter((part) => part.type === "image")
            : [],
        ),
        part = parts?.[index];
      return part?.type === "image"
        ? new File([Buffer.from(part.data, "base64")], "Pi image", {
            type: part.mimeType,
          })
        : null;
    });
  }
  async open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (!agent.provider) throw new Error("Select a Pi provider");
    const handle = await openPiSession(agent, notify, {
      ...this.options,
      sessionDir: this.sessionDir,
      sessionPath: agent.threadId ? this.path(agent.threadId) : undefined,
      selection: {
        provider: agent.provider,
        model: agent.model,
        effort: agent.effort,
      },
    });
    this.handles.add(handle);
    const close = handle.close;
    handle.close = async () => {
      await close();
      this.handles.delete(handle);
    };
    return handle;
  }
  async close() {
    await Promise.all([...this.handles].map((handle) => handle.close()));
  }
}
