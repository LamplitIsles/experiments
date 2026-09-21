import { watch as watchPath, type FSWatcher } from "node:fs";
import {
  BoxRenderable,
  CodeRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  TextareaRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  RGBA,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type OptimizedBuffer,
  type Renderable,
  type Selection,
} from "@opentui/core";
import type { NamedSession, TranscriptMessage } from "./types";

export type ReaderExit = "back" | "quit";

export type WatchHandle = Pick<FSWatcher, "close"> & {
  on?: (event: "error", listener: (error: Error) => void) => unknown;
  off?: (event: "error", listener: (error: Error) => void) => unknown;
};

export type WatchFactory = (
  path: string,
  listener: (eventType: string) => void,
) => WatchHandle;

export type RendererFactory = () => Promise<CliRenderer>;

export interface ConversationReaderOptions {
  session: NamedSession;
  messages: TranscriptMessage[];
  load: () => Promise<TranscriptMessage[]>;
  renderer?: CliRenderer;
  ownsRenderer?: boolean;
  rendererFactory?: RendererFactory;
  watchFactory?: WatchFactory;
  coalesceDelayMs?: number;
  /** zencodex adapter: source reader stays the interaction owner. */
  onSubmit?: (value: string) => Promise<void> | void;
  loadSkills?: () => Promise<Array<{ name: string; description?: string }>>;
  skillsVersion?: () => number;
  statusLines?: () => { cwd: string; runtime: string; telemetry: string };
  title?: () => string | undefined;
}

export interface ReaderSnapshot {
  messages: number;
  scrollTop: number;
  maxScrollTop: number;
  searchQuery: string;
  searchMatch: number;
  searchMatches: number;
  searchEditing: boolean;
  status: string;
  focus: "COMPOSING" | "READING";
  completion: "command" | "skill" | undefined;
  disposed: boolean;
}

type MessageView = {
  box: BoxRenderable;
  heading: TextRenderable;
  body: MarkdownRenderable;
};

type SearchMatch = {
  ranges: RenderedRange[];
};

type RenderedRange = {
  row: number;
  start: number;
  end: number;
};

type RenderedCell = {
  row: number;
  column: number;
  text: string;
  width: number;
};

type Anchor = {
  messageIndex: number;
  messageKey: string;
  offset: number;
};

const DEFAULT_COALESCE_DELAY_MS = 40;
const WATCH_RETRY_DELAY_MS = 100;

const syntaxStyle = {
  default: { fg: "#e5e7eb" },
  "markup.heading": { fg: "#93c5fd", bold: true },
  "markup.heading.1": { fg: "#bfdbfe", bold: true },
  "markup.heading.2": { fg: "#bfdbfe", bold: true },
  "markup.list": { fg: "#fbbf24" },
  "markup.raw": { fg: "#a7f3d0" },
  "markup.link": { fg: "#7dd3fc", underline: true },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statusText(value: string, limit = 140): string {
  const line = oneLine(value);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function safeDisplay(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function fuzzyMatches(value: string, query: string): boolean {
  let queryIndex = 0;
  for (const character of value.toLocaleLowerCase()) {
    if (character === query[queryIndex]) queryIndex += 1;
  }
  return queryIndex === query.length;
}

function messageKey(message: TranscriptMessage): string {
  return [
    message.role,
    message.phase ?? "",
    message.timestampLabel,
    message.body,
  ].join("\u0000");
}

function sameMessages(
  left: TranscriptMessage[],
  right: TranscriptMessage[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (message, index) => messageKey(message) === messageKey(right[index]),
  );
}

function hasPrefix(
  prefix: TranscriptMessage[],
  value: TranscriptMessage[],
): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every(
      (message, index) => messageKey(message) === messageKey(value[index]),
    )
  );
}

function displayWidth(character: string): number {
  const width = Bun.stringWidth(character);
  return width > 0 ? width : 1;
}

function messageHeading(message: TranscriptMessage, index: number): string {
  const role = message.role === "user" ? "User" : "Assistant";
  return `▸ ${role} · ${message.timestampLabel} · message ${index + 1}`;
}

function makeWatchFactory(): WatchFactory {
  return (path, listener) =>
    watchPath(path, (eventType) => listener(eventType));
}

export class ConversationReader {
  private readonly session: NamedSession;
  private readonly load: () => Promise<TranscriptMessage[]>;
  private readonly renderer: CliRenderer;
  private readonly ownsRenderer: boolean;
  private readonly watchFactory: WatchFactory;
  private readonly coalesceDelayMs: number;
  private readonly syntax: SyntaxStyle;
  private readonly appRoot: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly scrollBox: ScrollBoxRenderable;
  private readonly footer: BoxRenderable;
  private readonly searchHint: TextRenderable;
  private readonly searchPrompt: TextRenderable;
  private readonly searchInput: InputRenderable;
  private readonly status: TextRenderable;
  private readonly identityStatus: BoxRenderable;
  private readonly cwdStatus: TextRenderable;
  private readonly runtimeStatus: TextRenderable;
  private readonly composerFrame: BoxRenderable;
  private readonly composer: TextareaRenderable;
  private readonly completion: SelectRenderable;
  private readonly keyHandler: (key: KeyEvent) => void;
  private readonly frameHandler: () => void;
  private readonly searchDecorator: (buffer: OptimizedBuffer) => void;
  private readonly rendererDestroyHandler: () => void;
  private readonly inputHandler: (value: string) => void;
  private readonly enterHandler: (value: string) => void;
  private readonly submitHandler: () => void;
  private readonly onSubmit?: (value: string) => Promise<void> | void;
  private readonly statusLines?: ConversationReaderOptions["statusLines"];
  private readonly nativeTitle?: ConversationReaderOptions["title"];
  private readonly loadSkills?: ConversationReaderOptions["loadSkills"];
  private readonly skillsVersion?: ConversationReaderOptions["skillsVersion"];

  private messages: TranscriptMessage[];
  private messageViews: MessageView[] = [];
  private unreadBelow = false;
  private refreshError: string | undefined;
  private refreshNote: string | undefined;
  private clipboardNote: string | undefined;
  private readonly selectionHandler = (selection: Selection) => {
    if (this.disposed || selection.isDragging) return;
    const text = selection.getSelectedText();
    if (!text) return;
    if (this.renderer.copyToClipboardOSC52(text)) {
      this.renderer.clearSelection();
      this.clipboardNote = "copy sent to terminal";
    } else {
      this.clipboardNote = "terminal clipboard unavailable";
    }
    this.updateFooter();
  };
  private searchQuery = "";
  private pendingSearchQuery = "";
  private searchMatches: SearchMatch[] = [];
  private searchMatchIndex = -1;
  private searchLayoutSignature = "";
  private searchNeedsRebuild = true;
  private searchEditing = false;
  private focus: "COMPOSING" | "READING" = "COMPOSING";
  private completionKind: "command" | "skill" | undefined;
  private completionValues: Array<{ insert: string; name: string }> = [];
  private skills: Array<{ name: string; description?: string }> = [];
  private skillsLoaded = false;
  private skillsLoading: Promise<void> | undefined;
  private loadedSkillsVersion = -1;
  private pendingG = false;
  private watcher: WatchHandle | undefined;
  private watcherRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight = false;
  private refreshQueued = false;
  private idleWaiters: Array<() => void> = [];
  private refreshWaiters: Array<() => void> = [];
  private pendingPosition: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private resolveExit!: (result: ReaderExit) => void;
  private readonly exitPromise: Promise<ReaderExit>;

  public constructor(
    options: ConversationReaderOptions & {
      renderer: CliRenderer;
      ownsRenderer?: boolean;
    },
  ) {
    this.session = options.session;
    this.messages = options.messages.slice();
    this.load = options.load;
    this.renderer = options.renderer;
    this.ownsRenderer = options.ownsRenderer ?? true;
    this.watchFactory = options.watchFactory ?? makeWatchFactory();
    this.coalesceDelayMs = options.coalesceDelayMs ?? DEFAULT_COALESCE_DELAY_MS;
    this.onSubmit = options.onSubmit;
    this.statusLines = options.statusLines;
    this.nativeTitle = options.title;
    this.loadSkills = options.loadSkills;
    this.skillsVersion = options.skillsVersion;
    this.syntax = SyntaxStyle.fromStyles(syntaxStyle);
    this.exitPromise = new Promise<ReaderExit>((resolve) => {
      this.resolveExit = resolve;
    });

    try {
      this.appRoot = new BoxRenderable(this.renderer, {
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#0b1020",
      });
      this.title = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        truncate: true,
        fg: "#f8fafc",
      });
      this.scrollBox = new ScrollBoxRenderable(this.renderer, {
        width: "100%",
        flexGrow: 1,
        flexShrink: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        scrollbarOptions: {
          trackOptions: {
            foregroundColor: "#64748b",
            backgroundColor: "#0b1020",
          },
        },
      });
      this.footer = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 8,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: "#111827",
      });
      const searchLine = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
      });
      this.searchHint = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        truncate: true,
        fg: "#64748b",
        content:
          "READING · q quit · b/Esc back · / search · j/k ↑↓ · ^d/^u half · gg/G ends · n/N",
      });
      this.searchPrompt = new TextRenderable(this.renderer, {
        width: 2,
        height: 1,
        flexShrink: 0,
        fg: "#fbbf24",
        content: "/ ",
        visible: false,
      });
      this.searchInput = new InputRenderable(this.renderer, {
        width: "100%",
        flexGrow: 1,
        flexShrink: 1,
        textColor: "#f8fafc",
        backgroundColor: "#111827",
        cursorColor: "#fbbf24",
        visible: false,
        placeholder: "literal search; Enter applies, Esc cancels",
      });
      this.status = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        truncate: true,
        fg: "#fbbf24",
      });
      this.identityStatus = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
      });
      this.cwdStatus = new TextRenderable(this.renderer, {
        flexGrow: 1,
        flexShrink: 1,
        truncate: true,
        fg: "#94a3b8",
      });
      this.runtimeStatus = new TextRenderable(this.renderer, {
        flexShrink: 0,
        truncate: true,
        fg: "#cbd5e1",
      });
      this.completion = new SelectRenderable(this.renderer, {
        width: "100%",
        height: 2,
        flexShrink: 0,
        visible: false,
        backgroundColor: "#172033",
        textColor: "#e5e7eb",
        selectedBackgroundColor: "#1e3a5f",
        selectedTextColor: "#f8fafc",
        showDescription: true,
        showScrollIndicator: false,
      });
      this.composerFrame = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 4,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: "#111827",
        border: true,
        borderColor: "#334155",
        focusedBorderColor: "#fbbf24",
        focusable: true,
        paddingX: 1,
      });
      this.composer = new TextareaRenderable(this.renderer, {
        width: "100%",
        height: 2,
        flexShrink: 0,
        placeholder: "Message Codex · Enter submit · Ctrl-J newline · Tab read",
        backgroundColor: "#111827",
        focusedBackgroundColor: "#172033",
        textColor: "#f8fafc",
        focusedTextColor: "#f8fafc",
        keyBindings: [
          { name: "return", action: "submit" },
          { name: "j", ctrl: true, action: "newline" },
        ],
      });

      searchLine.add(this.searchHint);
      searchLine.add(this.searchPrompt);
      searchLine.add(this.searchInput);
      this.composerFrame.add(this.composer);
      this.identityStatus.add(this.cwdStatus);
      this.identityStatus.add(this.runtimeStatus);
      this.footer.add(this.composerFrame);
      this.footer.add(this.completion);
      this.footer.add(this.identityStatus);
      this.footer.add(this.status);
      this.footer.add(searchLine);
      this.appRoot.add(this.title);
      this.appRoot.add(this.scrollBox);
      this.appRoot.add(this.footer);
      // Events bubble here after ScrollBox has applied its native wheel movement.
      this.appRoot.onMouseScroll = (event) => {
        if (
          event.y >= this.scrollBox.y &&
          event.y < this.scrollBox.y + this.scrollBox.height
        ) {
          this.moveScroll(0);
        }
      };
      this.renderer.root.add(this.appRoot);

      this.keyHandler = (key) => this.handleKey(key);
      this.frameHandler = () => this.applyPendingPosition();
      this.searchDecorator = (buffer) => this.decorateSearchFrame(buffer);
      this.rendererDestroyHandler = () => this.handleRendererDestroy();
      this.inputHandler = (value) => {
        this.pendingSearchQuery = value;
        this.updateFooter();
      };
      this.enterHandler = (value) => this.applySearch(value);
      this.submitHandler = () => {
        const value = this.composer.plainText;
        if (!value.trim() || !this.onSubmit) return;
        this.composer.setText("");
        void Promise.resolve(this.onSubmit(value)).catch((error) =>
          this.setRefreshError(`submit error: ${errorText(error)}`),
        );
      };
      this.renderer.keyInput.on("keypress", this.keyHandler);
      this.renderer.on("frame", this.frameHandler);
      this.renderer.addPostProcessFn(this.searchDecorator);
      this.renderer.on("selection", this.selectionHandler);
      this.renderer.once("destroy", this.rendererDestroyHandler);
      this.searchInput.on(InputRenderableEvents.INPUT, this.inputHandler);
      this.searchInput.on(InputRenderableEvents.ENTER, this.enterHandler);
      this.composer.onSubmit = this.submitHandler;

      this.replaceMessageViews(this.messages);
      this.updateHeader();
      this.updateFooter();
    } catch (error) {
      this.syntax.destroy();
      throw error;
    }
  }

  public start(): void {
    if (!this.started && !this.disposed) {
      this.started = true;
      this.attachWatcher();
      this.composer.focus();
      this.schedulePosition(() => this.scrollToBottom());
      this.renderer.requestRender();
    }
  }

  public waitForExit(): Promise<ReaderExit> {
    return this.exitPromise;
  }

  public refresh(): Promise<void> {
    this.queueRefresh(true);
    return this.waitForIdle();
  }

  public waitForIdle(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (
      !this.refreshInFlight &&
      !this.refreshQueued &&
      this.refreshTimer === undefined
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  public waitForNextRefresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.refreshWaiters.push(resolve));
  }

  public snapshot(): ReaderSnapshot {
    const maxScrollTop = this.maximumScrollTop();
    return {
      messages: this.messages.length,
      scrollTop: this.scrollBox.scrollTop,
      maxScrollTop,
      searchQuery: this.searchQuery,
      searchMatch: this.searchMatchIndex < 0 ? 0 : this.searchMatchIndex + 1,
      searchMatches: this.searchMatches.length,
      searchEditing: this.searchEditing,
      status: this.currentStatus(),
      focus: this.focus,
      completion: this.completionKind,
      disposed: this.disposed,
    };
  }

  public dispose(result: ReaderExit = "quit"): void {
    this.finish(result, false);
  }

  private handleRendererDestroy(): void {
    this.finish("quit", true);
  }

  private finish(result: ReaderExit, rendererAlreadyDestroyed: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeWatcher();
    if (this.watcherRetryTimer !== undefined)
      clearTimeout(this.watcherRetryTimer);
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.watcherRetryTimer = undefined;
    this.refreshTimer = undefined;
    this.refreshQueued = false;
    this.pendingPosition = undefined;
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.renderer.off("frame", this.frameHandler);
    this.renderer.removePostProcessFn(this.searchDecorator);
    this.renderer.off("selection", this.selectionHandler);
    this.renderer.clearSelection();
    this.renderer.off("destroy", this.rendererDestroyHandler);
    this.searchInput.off(InputRenderableEvents.INPUT, this.inputHandler);
    this.searchInput.off(InputRenderableEvents.ENTER, this.enterHandler);
    this.composer.onSubmit = undefined;
    if (!this.composer.isDestroyed) this.composer.blur();
    if (!this.searchInput.isDestroyed) this.searchInput.blur();
    if (
      !rendererAlreadyDestroyed &&
      this.ownsRenderer &&
      !this.renderer.isDestroyed
    ) {
      this.renderer.destroy();
    }
    if (!this.appRoot.isDestroyed) this.appRoot.destroyRecursively();
    this.syntax.destroy();
    this.resolveIdleWaiters(true);
    this.resolveRefreshWaiters();
    this.resolveExit(result);
  }

  private attachWatcher(): void {
    if (this.disposed || this.watcher !== undefined) return;
    let handle: WatchHandle;
    try {
      handle = this.watchFactory(this.session.path, (eventType) => {
        if (this.disposed || this.watcher !== handle) return;
        this.fileChanged(eventType);
      });
    } catch (error) {
      this.setRefreshError(`watch error: ${errorText(error)}`);
      this.scheduleWatcherRetry();
      return;
    }
    this.watcher = handle;
    handle.on?.("error", this.watcherErrorHandler);
    this.queueRefresh(false);
  }

  private readonly watcherErrorHandler = (error: Error): void => {
    if (this.disposed) return;
    this.setRefreshError(`watch error: ${error.message}`);
    this.closeWatcher();
    this.scheduleWatcherRetry();
  };

  private closeWatcher(): void {
    const watcher = this.watcher;
    if (!watcher) return;
    watcher.off?.("error", this.watcherErrorHandler);
    this.watcher = undefined;
    try {
      watcher.close();
    } catch {
      // A watcher can already be closed after a rename notification.
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.disposed || this.watcherRetryTimer !== undefined) return;
    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = undefined;
      if (this.disposed) return;
      this.attachWatcher();
      if (this.watcher === undefined) this.scheduleWatcherRetry();
    }, WATCH_RETRY_DELAY_MS);
  }

  private fileChanged(eventType: string): void {
    if (eventType === "rename") {
      this.closeWatcher();
      this.scheduleWatcherRetry();
    }
    this.queueRefresh(false);
  }

  private queueRefresh(explicit: boolean): void {
    if (this.disposed) return;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      if (explicit) this.updateFooter();
      return;
    }
    if (explicit && this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined;
        void this.performRefresh();
      },
      explicit ? 0 : this.coalesceDelayMs,
    );
    this.updateFooter();
  }

  private async performRefresh(): Promise<void> {
    if (this.disposed || this.refreshInFlight) return;
    this.refreshInFlight = true;
    this.updateFooter();
    try {
      const nextMessages = await this.load();
      if (!this.disposed) this.applyMessages(nextMessages);
    } catch (error) {
      if (!this.disposed)
        this.setRefreshError(`refresh error: ${errorText(error)}`);
    } finally {
      this.refreshInFlight = false;
      if (this.disposed) {
        this.refreshQueued = false;
        this.resolveIdleWaiters();
        this.resolveRefreshWaiters();
      } else if (this.refreshQueued) {
        this.refreshQueued = false;
        this.queueRefresh(true);
      } else {
        this.resolveIdleWaiters();
        this.resolveRefreshWaiters();
        this.updateFooter();
      }
    }
  }

  private applyMessages(nextMessages: TranscriptMessage[]): void {
    const oldMessages = this.messages;
    if (sameMessages(oldMessages, nextMessages)) {
      this.refreshError = undefined;
      this.refreshNote = undefined;
      this.updateFooter();
      return;
    }

    const oldAnchor = this.captureAnchor();
    const wasAtEnd = this.scrollBox.scrollTop >= this.maximumScrollTop();
    const appendOnly = hasPrefix(oldMessages, nextMessages);
    this.messages = nextMessages.slice();
    if (appendOnly) {
      for (
        let index = oldMessages.length;
        index < nextMessages.length;
        index += 1
      ) {
        this.messageViews.push(
          this.createMessageView(nextMessages[index], index),
        );
        this.scrollBox.add(this.messageViews.at(-1)!.box);
      }
    } else {
      this.replaceMessageViews(this.messages);
    }

    this.invalidateRenderedSearch();
    this.refreshError = undefined;
    if (appendOnly) {
      if (!wasAtEnd) this.unreadBelow = true;
      this.refreshNote = undefined;
    } else if (this.searchQuery.length > 0 && this.searchMatchIndex >= 0) {
      this.refreshNote = undefined;
      this.schedulePosition(() => this.scrollToCurrentMatch());
    } else {
      this.refreshNote = "log changed; reading position adjusted";
      this.schedulePosition(() => this.restoreAnchor(oldAnchor));
    }
    this.updateHeader();
    this.updateFooter();
    this.renderer.requestRender();
  }

  private replaceMessageViews(messages: TranscriptMessage[]): void {
    for (const view of this.messageViews) {
      this.scrollBox.remove(view.box);
      if (!view.box.isDestroyed) view.box.destroyRecursively();
    }
    this.messageViews = messages.map((message, index) =>
      this.createMessageView(message, index),
    );
    for (const view of this.messageViews) this.scrollBox.add(view.box);
  }

  private createMessageView(
    message: TranscriptMessage,
    index: number,
  ): MessageView {
    const color = message.role === "user" ? "#fbbf24" : "#86efac";
    const box = new BoxRenderable(this.renderer, {
      id: `message-${index}`,
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      paddingX: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });
    const heading = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      truncate: true,
      fg: color,
      content: messageHeading(message, index),
    });
    const body = new MarkdownRenderable(this.renderer, {
      id: `message-${index}-body`,
      width: "100%",
      flexShrink: 0,
      conceal: true,
      streaming: false,
      content: message.body.length > 0 ? message.body : " ",
      syntaxStyle: this.syntax,
    });
    // Static markdown otherwise hides text until Tree-sitter finishes. Keep the
    // first frame readable without changing markdown's parsing/streaming state.
    for (const code of this.markdownCodeBlocks(body))
      code.drawUnstyledText = true;
    box.add(heading);
    box.add(body);
    return { box, heading, body };
  }

  private markdownCodeBlocks(body: MarkdownRenderable): CodeRenderable[] {
    const codeBlocks: CodeRenderable[] = [];
    const renderables: Renderable[] = [body];
    while (renderables.length > 0) {
      const renderable = renderables.pop()!;
      if (renderable instanceof CodeRenderable) codeBlocks.push(renderable);
      renderables.push(...renderable.getChildren());
    }
    return codeBlocks;
  }

  private updateHeader(): void {
    this.title.content = safeDisplay(this.nativeTitle?.() ?? this.session.name);
  }

  private updateFooter(): void {
    this.footer.height = this.completionKind ? 9 : 8;
    this.searchHint.visible = !this.searchEditing;
    this.searchPrompt.visible = this.searchEditing;
    this.searchInput.visible = this.searchEditing;
    const lines = this.statusLines?.();
    this.cwdStatus.content = lines?.cwd ?? "";
    this.runtimeStatus.content = lines?.runtime ?? "";
    this.status.content = this.currentStatus();
    this.renderer.requestRender();
  }

  private currentStatus(): string {
    const readingStatus = this.currentReadingStatus();
    const native = this.statusLines?.().telemetry;
    const full = native ? `${native} · ${readingStatus}` : readingStatus;
    return this.clipboardNote ? `${full} · ${this.clipboardNote}` : full;
  }

  private currentReadingStatus(): string {
    if (this.searchEditing) {
      const query = safeDisplay(this.pendingSearchQuery);
      return `search: /${query} · Enter apply · Esc cancel`;
    }

    if (this.refreshInFlight) return "refreshing…";
    if (this.refreshError) return statusText(this.refreshError);
    if (this.searchQuery.length > 0) {
      if (this.searchMatches.length === 0)
        return `no matches for /${safeDisplay(this.searchQuery)}/`;
      return `match ${this.searchMatchIndex + 1}/${this.searchMatches.length} · /${safeDisplay(this.searchQuery)}/`;
    }
    if (this.refreshNote) return this.refreshNote;
    return this.unreadBelow
      ? "new reply below · G go to end"
      : "reader anchored";
  }

  private setRefreshError(error: string): void {
    this.refreshError = statusText(error);
    this.updateFooter();
  }

  private handleKey(key: KeyEvent): void {
    if (this.disposed) return;
    if (this.focus === "COMPOSING" && key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      this.composer.setText("");
      this.closeCompletion();
      return;
    }
    if (this.focus === "COMPOSING" && key.ctrl && key.name === "d") {
      key.preventDefault();
      key.stopPropagation();
      this.finish("quit", false);
      return;
    }
    if (this.focus === "READING" && key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (this.completionKind) {
      if (key.name === "escape") {
        key.preventDefault();
        this.closeCompletion();
      } else if (key.name === "up") {
        key.preventDefault();
        this.completion.moveUp();
      } else if (key.name === "down") {
        key.preventDefault();
        this.completion.moveDown();
      } else if (key.name === "return" || key.name === "tab") {
        key.preventDefault();
        this.acceptCompletion();
      } else if (!key.ctrl) {
        this.composer.handleKeyPress(key);
        key.preventDefault();
        key.stopPropagation();
        this.scheduleCompletionUpdate();
      }
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.switchFocus();
      return;
    }
    if (this.focus === "COMPOSING" && this.composer.focused) {
      if (key.ctrl && key.name === "j") {
        // Global reader handlers run before focused renderables. Route Ctrl-J
        // through TextareaRenderable so its configured newline action wins.
        this.composer.handleKeyPress(key);
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (!key.ctrl) {
        this.scheduleCompletionUpdate();
        return;
      }
    }
    this.clipboardNote = undefined;
    if (this.searchEditing) {
      if (key.name === "escape") {
        key.preventDefault();
        this.cancelSearch();
      }
      return;
    }

    if (key.name === "q") {
      key.preventDefault();
      this.finish("quit", false);
    } else if (key.name === "b") {
      key.preventDefault();
      this.finish("back", false);
    } else if (key.name === "escape") {
      key.preventDefault();
      if (this.searchQuery.length > 0) this.cancelSearch();
      else this.finish("back", false);
    } else if (!key.ctrl && key.name === "/") {
      key.preventDefault();
      this.beginSearch();
    } else if (key.name === "n") {
      key.preventDefault();
      this.moveMatch(key.shift ? -1 : 1);
    } else if (key.name === "g") {
      key.preventDefault();
      if (key.shift) {
        this.pendingG = false;
        this.goToBottom();
      } else if (this.pendingG) {
        this.pendingG = false;
        this.goToTop();
      } else {
        this.pendingG = true;
      }
    } else if (key.name === "j" || key.name === "down") {
      key.preventDefault();
      this.pendingG = false;
      this.moveScroll(1);
    } else if (key.name === "k" || key.name === "up") {
      key.preventDefault();
      this.pendingG = false;
      this.moveScroll(-1);
    } else if (key.ctrl && key.name === "d") {
      key.preventDefault();
      this.pendingG = false;
      this.moveScroll(
        Math.max(1, Math.floor(this.scrollBox.viewport.height / 2)),
      );
    } else if (key.ctrl && key.name === "u") {
      key.preventDefault();
      this.pendingG = false;
      this.moveScroll(
        -Math.max(1, Math.floor(this.scrollBox.viewport.height / 2)),
      );
    } else {
      this.pendingG = false;
    }
  }

  private beginSearch(): void {
    this.focus = "READING";
    this.composer.blur();
    this.searchEditing = true;
    this.pendingSearchQuery = "";
    this.searchInput.value = this.pendingSearchQuery;
    this.searchHint.visible = false;
    this.searchPrompt.visible = true;
    this.searchInput.visible = true;
    this.searchInput.focus();
    this.updateFooter();
  }

  private switchFocus(): void {
    this.focus = this.focus === "COMPOSING" ? "READING" : "COMPOSING";
    if (this.focus === "COMPOSING") {
      this.searchEditing = false;
      this.searchInput.blur();
      this.composer.focus();
    } else {
      this.composer.blur();
    }
    this.updateFooter();
  }

  private async ensureSkills(): Promise<void> {
    if (this.skillsVersion && this.loadedSkillsVersion !== this.skillsVersion())
      this.skillsLoaded = false;
    if (this.skillsLoaded || !this.loadSkills) return;
    if (!this.skillsLoading) {
      this.skillsLoading = this.loadSkills()
        .then((skills) => {
          this.skills = skills.filter((skill) => Boolean(skill.name));
          this.skillsLoaded = true;
          this.loadedSkillsVersion = this.skillsVersion?.() ?? 0;
        })
        .catch((error) =>
          this.setRefreshError(`skills error: ${errorText(error)}`),
        )
        .finally(() => {
          this.skillsLoading = undefined;
        });
    }
    await this.skillsLoading;
  }

  private scheduleCompletionUpdate(): void {
    queueMicrotask(() => this.updateCompletion());
  }

  private updateCompletion(): void {
    if (this.focus !== "COMPOSING" || this.disposed) return;
    const value = this.composer.plainText;
    const match = /(^|\s)([/$][^\s]*)$/.exec(value);
    if (!match) {
      this.closeCompletion();
      return;
    }
    const prefix = match[2];
    if (prefix.startsWith("/")) {
      const query = prefix.slice(1).toLocaleLowerCase();
      const commands = [
        {
          name: "/compact",
          description: "Compact this thread",
          insert: "/compact",
        },
      ].filter((command) => fuzzyMatches(command.name.slice(1), query));
      this.showCompletion("command", commands);
      return;
    }
    if (!this.loadSkills) return;
    void this.ensureSkills().then(() => this.updateCompletion());
    const query = prefix.slice(1).toLocaleLowerCase();
    this.showCompletion(
      "skill",
      this.skills
        .filter((skill) => fuzzyMatches(skill.name, query))
        .map((skill) => ({
          name: `$${skill.name}`,
          description: skill.description ?? "",
          insert: `$${skill.name}`,
        })),
    );
  }

  private showCompletion(
    kind: "command" | "skill",
    values: Array<{ name: string; description: string; insert: string }>,
  ): void {
    this.completionKind = values.length ? kind : undefined;
    this.completionValues = values;
    this.completion.options = values.map(({ name, description }) => ({
      name,
      description,
    }));
    this.completion.setSelectedIndex(0);
    this.completion.visible = values.length > 0;
    this.updateFooter();
  }

  private closeCompletion(): void {
    this.completionKind = undefined;
    this.completionValues = [];
    this.completion.visible = false;
    if (!this.composer.focused && this.focus === "COMPOSING")
      this.composer.focus();
    this.updateFooter();
  }

  private acceptCompletion(): void {
    const selected = this.completionValues[this.completion.getSelectedIndex()];
    if (!selected) {
      this.closeCompletion();
      return;
    }
    this.composer.setText(
      this.composer.plainText.replace(/([/$])[^\s]*$/, selected.insert),
    );
    this.closeCompletion();
  }

  private cancelSearch(): void {
    this.searchEditing = false;
    this.searchQuery = "";
    this.pendingSearchQuery = "";
    this.searchInput.value = "";
    this.searchMatches = [];
    this.searchMatchIndex = -1;
    this.searchLayoutSignature = "";
    this.searchNeedsRebuild = false;
    this.searchInput.blur();
    this.updateFooter();
  }

  private applySearch(query: string): void {
    if (this.disposed) return;
    this.searchEditing = false;
    this.searchInput.blur();
    this.searchInput.visible = false;
    this.pendingSearchQuery = query;
    this.searchQuery = query;
    this.refreshNote = undefined;
    this.searchMatches = [];
    this.searchMatchIndex = -1;
    this.invalidateRenderedSearch();
    this.updateFooter();
  }

  private invalidateRenderedSearch(): void {
    this.searchNeedsRebuild = true;
    this.searchLayoutSignature = "";
    this.renderer.requestRender();
  }

  /** Build a literal corpus from laid-out text cells, never Markdown source. */
  private renderedTranscriptCells(): RenderedCell[] {
    const cells: RenderedCell[] = [];
    const visit = (node: Renderable) => {
      const textNode = node as Renderable & {
        plainText?: unknown;
        lineInfo?: {
          lineStartCols: number[];
          lineWidthCols: number[];
          lineSources: number[];
        };
      };
      if (typeof textNode.plainText === "string" && textNode.lineInfo) {
        const sourceCells: Array<RenderedCell & { source: number }> = [];
        let source = 0;
        let column = 0;
        for (const character of Array.from(textNode.plainText)) {
          if (character === "\n") {
            source += 1;
            column = 0;
            continue;
          }
          const characterWidth = displayWidth(character);
          sourceCells.push({
            source,
            row: 0,
            column,
            text: character,
            width: characterWidth,
          });
          column += characterWidth;
        }
        const lineCount = Math.min(
          textNode.lineInfo.lineSources.length,
          Math.max(0, Math.ceil(node.height)),
        );
        const sourceBases = new Map<number, number>();
        for (let line = 0; line < lineCount; line += 1) {
          const source = textNode.lineInfo.lineSources[line];
          const start = textNode.lineInfo.lineStartCols[line];
          sourceBases.set(
            source,
            Math.min(sourceBases.get(source) ?? start, start),
          );
        }
        for (let line = 0; line < lineCount; line += 1) {
          const source = textNode.lineInfo.lineSources[line];
          const start =
            textNode.lineInfo.lineStartCols[line] - sourceBases.get(source)!;
          const end = start + textNode.lineInfo.lineWidthCols[line];
          for (const sourceCell of sourceCells) {
            if (
              sourceCell.source !== source ||
              sourceCell.column < start ||
              sourceCell.column >= end
            )
              continue;
            cells.push({
              row: Math.round(node.y + this.scrollBox.scrollTop) + line,
              column: Math.round(node.x) + sourceCell.column - start,
              text: sourceCell.text,
              width: sourceCell.width,
            });
          }
        }
      }
      for (const child of node.getChildren()) visit(child);
    };
    for (const view of this.messageViews) {
      visit(view.heading);
      visit(view.body);
    }
    return cells.sort((left, right) =>
      left.row === right.row
        ? left.column - right.column
        : left.row - right.row,
    );
  }

  private rebuildRenderedSearch(): void {
    const cells = this.renderedTranscriptCells();
    const signature = cells
      .map((cell) => `${cell.row}:${cell.column}:${cell.text}`)
      .join("|");
    if (!this.searchNeedsRebuild && signature === this.searchLayoutSignature)
      return;
    const selected = this.searchMatches[this.searchMatchIndex]?.ranges[0];
    this.searchLayoutSignature = signature;
    this.searchNeedsRebuild = false;
    if (!this.searchQuery) {
      this.searchMatches = [];
      this.searchMatchIndex = -1;
      return;
    }

    const corpus: Array<{ value: string; range?: RenderedRange }> = [];
    let previous: RenderedCell | undefined;
    const addWhitespace = () => {
      if (corpus.at(-1)?.value !== " ") corpus.push({ value: " " });
    };
    for (const cell of cells) {
      if (previous) {
        const wrappedWord =
          cell.row === previous.row + 1 &&
          !/\s/u.test(previous.text) &&
          !/\s/u.test(cell.text);
        if (
          !wrappedWord &&
          (cell.row !== previous.row ||
            cell.column > previous.column + previous.width)
        )
          addWhitespace();
      }
      const value = /\s/u.test(cell.text) ? " " : cell.text.toLocaleLowerCase();
      if (value === " ") addWhitespace();
      else
        corpus.push({
          value,
          range: {
            row: cell.row,
            start: cell.column,
            end: cell.column + cell.width,
          },
        });
      previous = cell;
    }
    const needle = Array.from(oneLine(this.searchQuery).toLocaleLowerCase());
    const matches: SearchMatch[] = [];
    for (let start = 0; start <= corpus.length - needle.length; start += 1) {
      if (
        !needle.every((value, offset) => corpus[start + offset].value === value)
      )
        continue;
      const ranges: RenderedRange[] = [];
      for (const item of corpus.slice(start, start + needle.length)) {
        const range = item.range;
        if (!range) continue;
        const last = ranges.at(-1);
        if (last && last.row === range.row && last.end === range.start)
          last.end = range.end;
        else ranges.push({ ...range });
      }
      if (ranges.length > 0) matches.push({ ranges });
    }
    this.searchMatches = matches;
    const preserved = selected
      ? matches.findIndex((match) => {
          const first = match.ranges[0];
          return (
            first?.row === selected.row &&
            first.start === selected.start &&
            first.end === selected.end
          );
        })
      : -1;
    const previousIndex = this.searchMatchIndex;
    this.searchMatchIndex =
      preserved >= 0
        ? preserved
        : matches.length > 0
          ? Math.min(Math.max(previousIndex, 0), matches.length - 1)
          : -1;
    if (this.searchMatchIndex >= 0 && previousIndex < 0)
      this.schedulePosition(() => this.scrollToCurrentMatch());
    this.updateFooter();
  }

  /** Final-frame overlay: paint only the viewport cells belonging to matches. */
  private decorateSearchFrame(buffer: OptimizedBuffer): void {
    if (this.disposed) return;
    this.rebuildRenderedSearch();
    const current = this.searchMatches[this.searchMatchIndex];
    for (const [matchIndex, match] of this.searchMatches.entries()) {
      const isCurrent =
        match === current && matchIndex === this.searchMatchIndex;
      const background = RGBA.fromHex(isCurrent ? "#b45309" : "#665500");
      const attributes =
        TextAttributes.UNDERLINE |
        (isCurrent ? TextAttributes.BOLD | TextAttributes.INVERSE : 0);
      for (const range of match.ranges) {
        const y = range.row - Math.round(this.scrollBox.scrollTop);
        if (y < 0 || y >= buffer.height) continue;
        for (
          let x = Math.max(0, range.start);
          x < Math.min(buffer.width, range.end);
          x += 1
        ) {
          const index = y * buffer.width + x;
          const character = buffer.buffers.char[index];
          // Continuation and metadata cells use values outside Unicode's range.
          // Their leading cell owns the glyph and carries this visual treatment.
          if (character === 0 || character > 0x10ffff) continue;
          buffer.setCell(
            x,
            y,
            String.fromCodePoint(character),
            RGBA.fromArray(buffer.buffers.fg.slice(index * 4, index * 4 + 4)),
            background,
            buffer.buffers.attributes[index] | attributes,
          );
        }
      }
    }
  }

  private moveMatch(direction: 1 | -1): void {
    if (this.searchQuery.length === 0 || this.searchMatches.length === 0) {
      this.updateFooter();
      return;
    }
    this.refreshNote = undefined;
    this.searchMatchIndex =
      (this.searchMatchIndex + direction + this.searchMatches.length) %
      this.searchMatches.length;
    this.schedulePosition(() => this.scrollToCurrentMatch());
    this.updateFooter();
  }

  private moveScroll(delta: number): void {
    const before = this.scrollBox.scrollTop;
    this.scrollBox.scrollBy(delta, "absolute");
    const after = this.scrollBox.scrollTop;
    if (after !== before || delta <= 0) this.refreshNote = undefined;
    this.updateFooter();
  }

  private goToTop(): void {
    this.scrollBox.scrollTo(0);
    this.refreshNote = undefined;
    this.updateFooter();
  }

  private goToBottom(): void {
    this.scrollToBottom();
    this.unreadBelow = false;
    this.refreshNote = undefined;
    this.updateFooter();
  }

  private maximumScrollTop(): number {
    return Math.max(
      0,
      this.scrollBox.scrollHeight - this.scrollBox.viewport.height,
    );
  }

  private scrollToBottom(): void {
    this.scrollBox.scrollTo(this.maximumScrollTop());
  }

  private captureAnchor(): Anchor | undefined {
    if (this.messageViews.length === 0) return undefined;
    const position = this.scrollBox.scrollTop;
    let index = 0;
    for (
      let candidate = 0;
      candidate < this.messageViews.length;
      candidate += 1
    ) {
      const view = this.messageViews[candidate];
      const contentY = view.box.y + position;
      if (contentY + view.box.height > position) {
        index = candidate;
        break;
      }
      index = candidate;
    }
    const view = this.messageViews[index];
    const contentY = view.box.y + position;
    return {
      messageIndex: index,
      messageKey: messageKey(this.messages[index]),
      offset: position - contentY,
    };
  }

  private restoreAnchor(anchor: Anchor | undefined): void {
    if (!anchor || this.messageViews.length === 0) {
      this.scrollBox.scrollTo(
        Math.min(this.scrollBox.scrollTop, this.maximumScrollTop()),
      );
      return;
    }
    const index = this.messages.findIndex(
      (message, candidate) =>
        candidate >= anchor.messageIndex &&
        messageKey(message) === anchor.messageKey,
    );
    const resolvedIndex =
      index >= 0
        ? index
        : Math.min(anchor.messageIndex, this.messageViews.length - 1);
    const view = this.messageViews[resolvedIndex];
    const contentY = view.box.y + this.scrollBox.scrollTop;
    this.scrollBox.scrollTo(contentY + anchor.offset);
  }

  private schedulePosition(position: () => void): void {
    this.pendingPosition = position;
    this.renderer.requestRender();
  }

  private applyPendingPosition(): void {
    if (this.disposed || !this.pendingPosition) return;
    const position = this.pendingPosition;
    this.pendingPosition = undefined;
    position();
    this.renderer.requestRender();
  }

  /** Presentation-only update used by zencodex native event projection. */
  public project(messages: TranscriptMessage[], originIndex?: number): void {
    this.applyMessages(messages);
    this.updateHeader();
    if (originIndex !== undefined && originIndex >= 0) {
      this.unreadBelow = false;
      this.schedulePosition(() => {
        const view = this.messageViews[originIndex];
        if (view)
          this.scrollBox.scrollTo(
            Math.max(0, view.box.y + this.scrollBox.scrollTop - 1),
          );
      });
    }
  }

  private scrollToCurrentMatch(): void {
    const match = this.searchMatches[this.searchMatchIndex];
    const range = match?.ranges[0];
    if (!range) return;
    const target =
      range.row - Math.floor(Math.max(1, this.scrollBox.viewport.height) / 3);
    this.scrollBox.scrollTo(target);
  }

  private resolveIdleWaiters(force = false): void {
    if (
      !force &&
      (this.refreshInFlight ||
        this.refreshQueued ||
        this.refreshTimer !== undefined)
    )
      return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private resolveRefreshWaiters(): void {
    const waiters = this.refreshWaiters;
    this.refreshWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

export function createTerminalRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: true,
    backgroundColor: "#0b1020",
  });
}

export async function createConversationReader(
  options: ConversationReaderOptions,
): Promise<ConversationReader> {
  let renderer = options.renderer;
  const ownsRenderer = options.ownsRenderer ?? true;
  try {
    renderer ??= await (options.rendererFactory ?? createTerminalRenderer)();
    return new ConversationReader({ ...options, renderer, ownsRenderer });
  } catch (error) {
    if (ownsRenderer && renderer && !renderer.isDestroyed) renderer.destroy();
    throw error;
  }
}
