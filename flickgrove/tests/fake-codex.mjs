#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Adapt the shared ZenCodex protocol fixture at the wire seam for this SDK.
// This crash mode is used only with a test-owned FAKE_SERVER_ROOT.
const crashMarker = process.env.FAKE_EXIT_AFTER_ACCEPT
  ? join(process.env.FAKE_SERVER_ROOT, "crashed")
  : null;
const shouldCrash = crashMarker && !existsSync(crashMarker);
if (crashMarker && existsSync(crashMarker)) {
  // A fresh process has no running task, even though the fixture persisted it.
  const statePath = join(
    process.env.FAKE_SERVER_ROOT,
    ".fake-app-server-state.json",
  );
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.active = null;
  writeFileSync(statePath, JSON.stringify(state));
}
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  let message;
  try {
    message = JSON.parse(String(chunk));
  } catch {
    return write(chunk, ...args);
  }
  if (
    shouldCrash &&
    ["item/completed", "turn/completed"].includes(message.method)
  )
    return true;
  if (shouldCrash && message.result?.turn?.status === "inProgress") {
    writeFileSync(crashMarker, "accepted");
    setTimeout(() => process.exit(42), 10);
  }
  if (message.result?.data?.[0]?.serviceTiers)
    message.result.data[0].serviceTiers = [
      { id: "priority", name: "Fast", description: "Faster responses" },
    ];
  if (
    message.id != null &&
    message.result &&
    Object.keys(message.result).length === 0
  )
    message.result = { status: "unsubscribed" };
  if (
    message.method === "item/completed" &&
    message.params.item.type === "agentMessage" &&
    message.params.threadId === "thread-fake"
  ) {
    const question = {
      ...message,
      params: {
        ...message.params,
        item: {
          ...message.params.item,
          id: "async-question",
          text: "Choose a color",
          phase: null,
          delivery: "async",
          questions: [
            { title: "Which color?", options: ["Blue", "Green"] },
            { title: "Any context?", options: null },
          ],
        },
      },
    };
    write(JSON.stringify(question) + "\n");
  }
  return write(JSON.stringify(message) + "\n", ...args);
};
await import("../../zencodex/src/fake-app-server-entry.mjs");
