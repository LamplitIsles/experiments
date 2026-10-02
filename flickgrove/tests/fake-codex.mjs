#!/usr/bin/env node
// Adapt the shared ZenCodex protocol fixture at the wire seam for this SDK.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  let message;
  try {
    message = JSON.parse(String(chunk));
  } catch {
    return write(chunk, ...args);
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
