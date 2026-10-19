import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { sameDirectory } from "./directory";
import {
  ModelRuntime,
  getAgentDir,
  SessionManager,
  parseSessionEntries,
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
import { openPiSession } from "./pi-session";

export class PiRuntime implements Runtime {
  private readonly handles = new Set<RuntimeHandle>();
  private readonly paths = new Map<string, string>();
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

  private async list() {
    const entries = await SessionManager.listAll();
    for (const e of entries) this.paths.set(e.id, e.path);
    return entries;
  }
  async history(cwd: string, cursor?: string): Promise<HistoryPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid Pi history cursor");
    const entries = (await this.list())
      .filter((e) => sameDirectory(e.cwd, cwd))
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return {
      sessions: entries.slice(offset, offset + 40).map((e) => ({
        backend: "pi",
        threadId: e.id,
        title: e.name ?? e.firstMessage.slice(0, 160) ?? "Pi session",
        preview: e.firstMessage,
        cwd: e.cwd,
        updatedAt: e.modified.getTime(),
        source: "Pi",
        archived: false,
        role: "session",
      })),
      nextCursor: offset + 40 < entries.length ? String(offset + 40) : null,
    };
  }
  private async sessionPath(id: string) {
    if (!this.paths.has(id)) await this.list();
    const path = this.paths.get(id);
    if (!path) throw new Error("Pi session was not found");
    return path;
  }
  private async manager(id: string) {
    const entries = parseSessionEntries(
      await readFile(await this.sessionPath(id), "utf8"),
    );
    const header = entries.find((entry) => entry.type === "session");
    if (!header || header.id !== id)
      throw new Error("Pi session history is unavailable");
    return SessionManager.inMemory(header.cwd, undefined, entries);
  }
  async historyThread(id: string): Promise<HistorySession> {
    const manager = await this.manager(id),
      header = manager.getHeader()!,
      projection = manager.buildSessionContext();
    return {
      backend: "pi",
      threadId: id,
      title: manager.getSessionName() ?? "Pi session",
      preview: "",
      cwd: manager.getCwd(),
      updatedAt: Date.parse(
        manager.getLeafEntry()?.timestamp ?? header.timestamp,
      ),
      source: "Pi",
      archived: false,
      role: "session",
      model: projection.model?.modelId,
      provider: projection.model?.provider,
      effort: projection.thinkingLevel,
    };
  }
  async readTitle(id: string) {
    return (await this.manager(id)).getSessionName() ?? null;
  }
  async historyMessages(id: string, cursor?: string): Promise<HistoryMessages> {
    const manager = await this.manager(id),
      entries = manager.getBranch();
    const receipts = new Map<string, { operation: string; runId: string }>();
    for (const e of entries)
      if (e.type === "custom" && e.customType === "grove-accepted") {
        const receipt = e.data as {
          itemId: string;
          operation: string;
          runId: string;
        };
        receipts.set(receipt.itemId, receipt);
      }
    const visible = entries.filter(
      (e) =>
        (e.type === "message" &&
          (e.message.role === "user" || e.message.role === "assistant")) ||
        (e.type === "custom" && e.customType === "grove-question"),
    );
    const end = cursor ? Number(cursor) : visible.length;
    if (!Number.isSafeInteger(end) || end < 0 || end > visible.length)
      throw new Error("Invalid Pi message cursor");
    const start = Math.max(0, end - 100);
    const messages: Message[] = [];
    for (const e of visible.slice(start, end)) {
      if (e.type === "custom" && e.customType === "grove-question") {
        const question = e.data as {
          itemId: string;
          runId: string;
          questions: { title?: string; question: string; options?: string[] }[];
        };
        messages.push({
          id: question.itemId,
          questionItemId: question.itemId,
          turnId: question.runId,
          role: "assistant",
          at: Date.parse(e.timestamp),
          text: question.questions.map((q) => q.question).join("\n\n"),
        });
        continue;
      }
      if (
        e.type !== "message" ||
        (e.message.role !== "user" && e.message.role !== "assistant")
      )
        continue;
      const receipt = receipts.get(e.id),
        message = e.message;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      const images =
        typeof message.content === "string"
          ? []
          : await Promise.all(
              message.content
                .flatMap((part, index) =>
                  part.type === "image" ? [{ part, index }] : [],
                )
                .map(async ({ part, index }) => {
                  const bytes = Buffer.from(part.data, "base64");
                  const metadata = await sharp(bytes).metadata();
                  return {
                    id: `${e.id}:${index}`,
                    name: "Pi image",
                    width: metadata.width!,
                    height: metadata.height!,
                    bytes: bytes.length,
                    mediaType: part.mimeType,
                  };
                }),
            );
      messages.push({
        ...(images.length ? { images } : {}),
        id: e.id,
        role: message.role,
        text,
        at: Date.parse(e.timestamp),
        clientId: receipt?.operation,
        turnId: receipt?.runId,
      });
    }
    return { messages, nextCursor: start ? String(start) : null };
  }

  async historyImage(id: string, imageId: string): Promise<File | null> {
    const manager = await this.manager(id);
    const separator = imageId.lastIndexOf(":");
    const entry = manager.getEntry(imageId.slice(0, separator));
    const index = Number(imageId.slice(separator + 1));
    if (
      separator < 0 ||
      !Number.isSafeInteger(index) ||
      entry?.type !== "message" ||
      !("content" in entry.message) ||
      !Array.isArray(entry.message.content)
    )
      return null;
    const part = entry.message.content[index];
    return part?.type === "image"
      ? new File([Buffer.from(part.data, "base64")], "Pi image", {
          type: part.mimeType,
        })
      : null;
  }
  async open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (!agent.provider) throw new Error("Select a Pi provider");
    const handle = await openPiSession(agent, notify, {
      ...this.options,
      sessionDir: SessionManager.create(agent.project.path).getSessionDir(),
      sessionPath: agent.threadId
        ? await this.sessionPath(agent.threadId)
        : undefined,
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
    await Promise.all([...this.handles].map((h) => h.close()));
    this.paths.clear();
  }
}
