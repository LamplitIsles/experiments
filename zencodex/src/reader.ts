import {
  BoxRenderable,
  MarkdownRenderable,
  SelectRenderable,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollbackSurface,
} from "@opentui/core";
import type { NamedSession, TranscriptMessage } from "./types";
import type { Model } from "./conversation";
import { noTrace, type Trace } from "./tracing";

export type ReaderExit = "quit";
type CompletionOption = {
  value: string;
  label: string;
  description?: string;
  appendSpace?: boolean;
};
export interface ConversationReaderOptions {
  session: NamedSession;
  messages: TranscriptMessage[];
  renderer: CliRenderer;
  onSubmit?: (value: string) => Promise<void> | void;
  onQueue?: (value: string) => Promise<void> | void;
  onInterrupt?: () => Promise<void> | void;
  canSubmit?: () => boolean;
  queuedInputs?: () => readonly string[];
  takeRestoredDraft?: () => string;
  loadSkills?: () => Promise<Array<{ name: string; description?: string }>>;
  skillsVersion?: () => number;
  loadModels?: () => Promise<Model[]>;
  modelsVersion?: () => number;
  statusLines?: () => { cwd: string; runtime: string; telemetry: string };
  title?: () => string | undefined;
  trace?: Trace;
  hasEarlierHistory?: () => boolean;
  loadEarlierHistory?: () => Promise<TranscriptMessage[]>;
}
const keyOf = (m: TranscriptMessage) =>
  `${m.role}\0${m.timestampLabel}\0${m.body}`;
const fuzzy = (text: string, query: string) => {
  let index = 0;
  for (const char of text.toLowerCase()) if (char === query[index]) index++;
  return index === query.length;
};

export class ConversationReader {
  private readonly renderer: CliRenderer;
  private readonly trace: Trace;
  private readonly root: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly status: TextRenderable;
  private readonly identity: TextRenderable;
  private readonly runtime: TextRenderable;
  private readonly composer: TextareaRenderable;
  private readonly completion: SelectRenderable;
  private readonly syntax = SyntaxStyle.fromStyles({
    default: { fg: "#e5e7eb" },
    "markup.heading": { fg: "#93c5fd", bold: true },
    "markup.heading.1": { fg: "#bfdbfe", bold: true },
    "markup.heading.2": { fg: "#bfdbfe", bold: true },
    "markup.list": { fg: "#fbbf24" },
    "markup.raw": { fg: "#a7f3d0" },
    "markup.link": { fg: "#7dd3fc", underline: true },
  });
  private wanted: TranscriptMessage[];
  private committed: TranscriptMessage[] = [];
  private running: Promise<void> | undefined;
  private replay = true;
  private started = false;
  private disposed = false;
  private terminalHeight: number;
  private notice = "";
  private completionValues: CompletionOption[] = [];
  private completionKind: "command" | "skill" | "model" | undefined;
  private skills: Array<{ name: string; description?: string }> = [];
  private skillsVersion = -1;
  private skillsLoading = false;
  private models: Model[] = [];
  private modelsVersion = -1;
  private modelsLoading = false;
  private resolveExit!: (exit: ReaderExit) => void;
  private readonly exit = new Promise<ReaderExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly options: ConversationReaderOptions) {
    this.renderer = options.renderer;
    this.trace = options.trace ?? noTrace;
    this.wanted = options.messages.slice();
    this.terminalHeight = this.renderer.terminalHeight;
    // A split footer otherwise follows the current output cursor until enough
    // history arrives. Reserve its viewport before the first reader frame.
    this.reserveRows(Math.max(0, this.terminalHeight - this.renderer.height));
    this.root = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#111827",
    });
    const line = (fg: string) =>
      new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        truncate: true,
        fg,
      });
    this.title = line("#f8fafc");
    this.identity = line("#94a3b8");
    this.status = line("#fbbf24");
    const identityRow = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    });
    this.identity.width = "auto";
    this.identity.flexGrow = 1;
    this.identity.flexShrink = 1;
    this.runtime = new TextRenderable(this.renderer, {
      height: 1,
      flexShrink: 0,
      fg: "#cbd5e1",
    });
    identityRow.add(this.identity);
    identityRow.add(this.runtime);
    const hint = line("#64748b");
    hint.content =
      "Enter send/steer · Tab queue · Ctrl-J newline · Esc interrupt · Ctrl-D exit";
    this.composer = new TextareaRenderable(this.renderer, {
      width: "100%",
      height: 3,
      flexShrink: 0,
      placeholder: "Message Codex",
      textColor: "#f8fafc",
      focusedTextColor: "#f8fafc",
      backgroundColor: "#172033",
      focusedBackgroundColor: "#172033",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "j", ctrl: true, action: "newline" },
      ],
    });
    this.completion = new SelectRenderable(this.renderer, {
      width: "100%",
      height: 2,
      flexShrink: 0,
      visible: false,
      showDescription: true,
      showScrollIndicator: false,
    });
    for (const child of [
      this.title,
      this.composer,
      this.completion,
      identityRow,
      this.status,
      hint,
    ])
      this.root.add(child);
    this.renderer.root.add(this.root);
    this.composer.onSubmit = () => this.submit(false);
    this.renderer.keyInput.on("keypress", this.onKey);
    this.renderer.on("resize", this.onResize);
    this.renderer.once("destroy", this.onDestroy);
    this.updateStatus();
  }
  async start() {
    this.started = true;
    this.composer.focus();
    await this.schedule();
    this.renderer.requestRender();
  }
  waitForExit() {
    return this.exit;
  }
  waitForIdle() {
    return this.running ?? Promise.resolve();
  }
  async loadHistory(messages: TranscriptMessage[]) {
    this.replay = true;
    this.project(messages);
    await this.waitForIdle();
  }
  project(messages: TranscriptMessage[]) {
    if (this.disposed) return;
    this.wanted = messages.slice();
    const restored = this.options.takeRestoredDraft?.();
    if (restored)
      this.composer.setText(
        [restored, this.composer.plainText].filter(Boolean).join("\n\n"),
      );
    this.updateStatus();
    if (this.started)
      void this.schedule().catch((error) => this.showError(error));
  }
  private updateStatus() {
    if (this.disposed) return;
    const status = this.options.statusLines?.(),
      queued = this.options.queuedInputs?.() ?? [];
    this.title.content = this.options.title?.() ?? this.options.session.name;
    this.identity.content = status?.cwd ?? this.options.session.cwd;
    this.runtime.content = status ? ` · ${status.runtime}` : "";
    this.status.content = [
      status?.telemetry,
      queued.length ? `${queued.length} queued` : "",
      this.notice,
    ]
      .filter(Boolean)
      .join(" · ");
    this.renderer.requestRender();
  }
  private showError(error: unknown) {
    this.notice = error instanceof Error ? error.message : String(error);
    this.updateStatus();
  }
  private readonly onDestroy = () => {
    this.resolveExit("quit");
    this.dispose();
  };
  private reserveRows(rows: number) {
    if (!rows) return;
    this.renderer.writeToScrollback(({ renderContext, width }) => ({
      root: new TextRenderable(renderContext, {
        width,
        height: rows,
        content: "",
      }),
      width,
      height: rows,
      trailingNewline: true,
    }));
  }
  private readonly onResize = () => {
    const growth = this.renderer.terminalHeight - this.terminalHeight;
    this.terminalHeight = this.renderer.terminalHeight;
    // Native split-footer keeps its previous top when the terminal grows.
    // Extend the reserved area without clearing or replaying retained output.
    if (growth > 0 && !this.disposed) this.reserveRows(growth);
  };
  private schedule(): Promise<void> {
    if (!this.running)
      this.running = this.renderPending().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private addMessage(
    surface: ScrollbackSurface,
    message: TranscriptMessage,
    index: number,
    prepend: boolean,
  ): BoxRenderable {
    const block = new BoxRenderable(surface.renderContext, {
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
    });
    block.add(
      new TextRenderable(surface.renderContext, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: `▸ ${message.role === "user" ? "User" : "Assistant"} · ${message.timestampLabel} · message ${index + 1}`,
        fg: message.role === "user" ? "#fbbf24" : "#86efac",
      }),
    );
    block.add(
      new MarkdownRenderable(surface.renderContext, {
        width: "100%",
        flexShrink: 0,
        streaming: false,
        conceal: true,
        content: message.body || " ",
        syntaxStyle: this.syntax,
      }),
    );
    surface.root.add(block, prepend ? 0 : undefined);
    return block;
  }
  private async renderPending() {
    while (!this.disposed) {
      const next = this.wanted.slice();
      const prefix =
        this.committed.length <= next.length &&
        this.committed.every((m, i) => keyOf(m) === keyOf(next[i]));
      if (!this.replay && prefix && this.committed.length === next.length)
        return;
      const replay = this.replay || !prefix;
      this.replay = false;
      const width = this.renderer.width,
        height = this.renderer.height;
      const surface = this.renderer.createScrollbackSurface();
      const layout = () =>
        this.trace.measure("markdown.layout", async (span) => {
          await surface.settle();
          span.setAttribute("rows", surface.height);
        });
      try {
        await this.trace.measure(
          replay ? "history.replay" : "history.append",
          async (span) => {
            let rows = 0,
              start = next.length;
            if (replay) {
              for (let i = next.length - 1; i >= 0; i--) {
                const block = this.addMessage(surface, next[i], i, true);
                await layout();
                if (start < next.length && surface.height > 1000) {
                  surface.root.remove(block);
                  block.destroyRecursively();
                  break;
                }
                rows = surface.height;
                start = i;
                if (rows >= 1000) break;
              }
            } else {
              start = this.committed.length;
              for (let i = start; i < next.length; i++) {
                this.addMessage(surface, next[i], i, false);
              }
              if (start < next.length) {
                await layout();
                rows = surface.height;
              }
            }
            if (this.disposed) return;
            if (
              replay &&
              start === 0 &&
              rows < 1000 &&
              this.options.hasEarlierHistory?.() &&
              this.options.loadEarlierHistory
            ) {
              this.wanted = await this.options.loadEarlierHistory();
              this.replay = true;
              return;
            }
            if (
              width !== this.renderer.width ||
              height !== this.renderer.height
            ) {
              this.replay = replay;
              return;
            }
            const notices = [
              replay && this.committed.length
                ? "Transcript refreshed · prior output retained"
                : "",
              replay && (start > 0 || this.options.hasEarlierHistory?.())
                ? "Earlier history omitted · use flicklog search"
                : "",
            ].filter(Boolean);
            if (rows || notices.length) {
              for (let i = 0; i < notices.length; i++)
                surface.root.add(
                  new TextRenderable(surface.renderContext, {
                    width,
                    height: 1,
                    flexShrink: 0,
                    content: notices[i],
                  }),
                  i,
                );
              // Settle removals/notices, then submit one snapshot. No partial
              // history can spill across the per-frame commit count limit.
              await layout();
              if (this.disposed) return;
              if (
                width !== this.renderer.width ||
                height !== this.renderer.height
              ) {
                this.replay = replay;
                return;
              }
              await this.trace.measure("scrollback.submit", () =>
                surface.commitRows(0, surface.height, {
                  trailingNewline: true,
                }),
              );
            }
            span.setAttributes({
              rows,
              messages: next.length - start,
              truncated: replay && start > 0,
              width,
            });
            this.committed = next;
          },
        );
      } finally {
        surface.destroy();
      }
    }
  }
  private submit(queued: boolean) {
    if (this.options.canSubmit && !this.options.canSubmit()) return;
    const input = this.composer.plainText;
    if (!input.trim()) return;
    this.composer.setText("");
    this.closeCompletion();
    const callback = queued ? this.options.onQueue : this.options.onSubmit;
    void Promise.resolve(callback?.(input)).catch((error) => {
      this.showError(error);
    });
  }
  private readonly onKey = (key: KeyEvent) => {
    if (this.disposed) return;
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (key.ctrl && key.name === "d") {
      consume();
      this.resolveExit("quit");
      return;
    }
    if (key.ctrl && key.name === "c") {
      consume();
      this.composer.setText("");
      this.closeCompletion();
      return;
    }
    if (this.completionValues.length) {
      if (key.name === "tab" || key.name === "return") {
        consume();
        const option =
          this.completionValues[this.completion.getSelectedIndex()];
        if (option) this.applyCompletion(option);
        this.closeCompletion();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        consume();
        if (key.name === "up") this.completion.moveUp();
        else this.completion.moveDown();
        return;
      }
      if (key.name === "escape") {
        consume();
        this.closeCompletion();
        return;
      }
    }
    if (key.name === "tab") {
      consume();
      this.submit(true);
      return;
    }
    if (key.name === "escape") {
      consume();
      void Promise.resolve(this.options.onInterrupt?.()).catch((error) =>
        this.showError(error),
      );
      return;
    }
    if (key.ctrl && key.name === "j") {
      this.composer.handleKeyPress(key);
      consume();
      return;
    }
    queueMicrotask(() => this.updateCompletion());
  };
  private closeCompletion() {
    this.completionValues = [];
    this.completionKind = undefined;
    this.completion.visible = false;
    this.composer.height = 3;
    this.composer.focus();
  }
  private applyCompletion(option: CompletionOption) {
    const input = this.composer.plainText;
    const value = `${option.value}${option.appendSpace ? " " : ""}`;
    const result =
      this.completionKind === "model"
        ? input.replace(/(^|\s)\/model\s+.*$/, `$1/model ${value}`)
        : input.replace(/([/$])[^\s]*$/, value);
    this.composer.setText(result);
    this.composer.cursorOffset = result.length;
  }
  private updateCompletion() {
    if (this.disposed) return;
    const input = this.composer.plainText;
    const modelMatch = /(^|\s)\/model\s+(.*)$/.exec(input);
    const match = modelMatch ?? /(^|\s)([/$][^\s]*)$/.exec(input);
    if (!match) {
      this.closeCompletion();
      return;
    }
    const prefix = modelMatch ? "/model" : match[2],
      query = (modelMatch ? modelMatch[2] : prefix.slice(1)).toLowerCase();
    if (
      prefix[0] === "$" &&
      this.options.loadSkills &&
      this.skillsVersion !== (this.options.skillsVersion?.() ?? 0) &&
      !this.skillsLoading
    ) {
      this.skillsLoading = true;
      const version = this.options.skillsVersion?.() ?? 0;
      void this.options
        .loadSkills()
        .then((skills) => {
          this.skills = skills;
          this.skillsVersion = version;
        })
        .catch((error) => {
          this.skillsVersion = version;
          this.showError(error);
        })
        .finally(() => {
          this.skillsLoading = false;
          this.updateCompletion();
        });
    }
    if (
      modelMatch &&
      this.options.loadModels &&
      this.modelsVersion !== (this.options.modelsVersion?.() ?? 0) &&
      !this.modelsLoading
    ) {
      this.modelsLoading = true;
      const version = this.options.modelsVersion?.() ?? 0;
      void this.options
        .loadModels()
        .then((models) => {
          this.models = models;
          this.modelsVersion = version;
        })
        .catch((error) => {
          this.modelsVersion = version;
          this.showError(error);
        })
        .finally(() => {
          this.modelsLoading = false;
          this.updateCompletion();
        });
    }
    const modelPairs = this.models.flatMap((model) => {
      const efforts = model.efforts ?? [];
      const ordered = model.defaultEffort
        ? [
            ...efforts.filter((effort) => effort.name === model.defaultEffort),
            ...efforts.filter((effort) => effort.name !== model.defaultEffort),
          ]
        : efforts;
      return ordered.map((effort) => ({
        value: `${model.name} ${effort.name}`,
        label: `${model.name} · ${effort.name}`,
        description: [
          model.description,
          effort.description,
          effort.name === model.defaultEffort ? "Default" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
    });
    const values: CompletionOption[] = modelMatch
      ? modelPairs
      : prefix[0] === "/"
        ? [
            {
              value: "/compact",
              label: "/compact",
              description: "Compact this thread",
            },
            {
              value: "/cancel-retry",
              label: "/cancel-retry",
              description: "Cancel capacity retry",
            },
            {
              value: "/model",
              label: "/model",
              description: "Choose a model and reasoning-effort pair",
              appendSpace: true,
            },
          ]
        : this.skills.map((skill) => ({
            value: `$${skill.name}`,
            label: `$${skill.name}`,
            description: skill.description,
            appendSpace: true,
          }));
    const selected = values.filter((value) => fuzzy(value.label, query));
    this.completionKind = modelMatch
      ? "model"
      : prefix[0] === "$"
        ? "skill"
        : "command";
    this.completionValues = selected;
    this.completion.options = selected.map((value) => ({
      name: value.label,
      description: value.description ?? "",
    }));
    this.completion.setSelectedIndex(0);
    this.completion.visible = selected.length > 0;
    // Keep the terminal surface fixed: split-footer shrinking preserves its top
    // in real terminals. Suggestions borrow two composer rows instead.
    this.composer.height = this.completion.visible ? 1 : 3;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.off("resize", this.onResize);
    this.renderer.off("destroy", this.onDestroy);
    this.composer.onSubmit = undefined;
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    void (this.running ?? Promise.resolve())
      .finally(() => this.syntax.destroy())
      .catch(() => {});
  }
}
export function createTerminalRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: false,
    backgroundColor: "#0b1020",
  });
}
export async function createConversationReader(
  options: ConversationReaderOptions,
) {
  return new ConversationReader(options);
}
