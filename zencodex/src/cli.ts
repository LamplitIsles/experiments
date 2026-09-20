#!/usr/bin/env bun
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { createHerdrReporter } from "./herdr";

const formatDuration = (ms?: number) =>
  ms === undefined
    ? ""
    : ` · worked ${Math.floor(ms / 60_000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;

async function main() {
  const cwd = process.cwd();
  const server = await connect(cwd);
  const sessions = await server.sessions();
  const threadId = sessions[0]?.id ?? (await server.start());
  if (sessions[0]) await server.resume(threadId);
  const conversation = new ReaderConversation(
    server,
    threadId,
    createHerdrReporter(),
  );
  await conversation.loadHistory();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0b1020",
  });
  const title = new TextRenderable(renderer, {
    height: 1,
    content: `zencodex · ${cwd}`,
    fg: "#f8fafc",
  });
  const transcript = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
  });
  const input = new InputRenderable(renderer, {
    width: "100%",
    placeholder:
      "Message Codex · Enter submit · Ctrl-/ search · Ctrl-C stop/exit",
  });
  const footer = new TextRenderable(renderer, { height: 1, fg: "#cbd5e1" });
  root.add(title);
  root.add(transcript);
  root.add(input);
  root.add(footer);
  renderer.root.add(root);
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#e5e7eb" } });
  let drawn = 0;
  let origin = -1;
  const draw = () => {
    while (drawn < conversation.visible.length) {
      const message = conversation.visible[drawn];
      const box = new BoxRenderable(renderer, {
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        paddingX: 1,
        paddingTop: 1,
      });
      box.add(
        new TextRenderable(renderer, {
          height: 1,
          content: `▸ ${message.role === "user" ? "User" : "Assistant"} · ${message.timestamp} · message ${drawn + 1}${formatDuration(message.workedMs)}`,
          fg: message.role === "user" ? "#fbbf24" : "#86efac",
        }),
      );
      box.add(
        new MarkdownRenderable(renderer, {
          width: "100%",
          flexShrink: 0,
          streaming: false,
          content: message.body,
          syntaxStyle: syntax,
        }),
      );
      transcript.add(box);
      drawn++;
    }
    if (origin !== conversation.readingOrigin) {
      origin = conversation.readingOrigin;
      const child = transcript.getChildren()[origin];
      if (child) transcript.scrollTo(child.y);
    }
    footer.content = `${conversation.contextLabel()} · ${conversation.status} · Ctrl-C ${conversation.activeTurnId ? "stop" : "exit"}`;
    renderer.requestRender();
  };
  input.on(InputRenderableEvents.ENTER, (value) => {
    input.value = "";
    void conversation
      .submit(value)
      .then(draw)
      .catch((error) => {
        footer.content = String(error);
      });
    draw();
  });
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (conversation.activeTurnId) void conversation.interrupt();
      else renderer.destroy();
    }
  });
  const timer = setInterval(draw, 250);
  renderer.once("destroy", () => {
    clearInterval(timer);
    syntax.destroy();
    void conversation.close();
  });
  draw();
}
void main();
