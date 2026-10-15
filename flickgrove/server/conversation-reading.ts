import type { Delivery, Message, Question } from "../src/contracts";
import type { Runtime } from "./runtime";
export const LIVE_BYTES = 256 * 1024;
export const PAGE_BYTES = 1024 * 1024;
export const encodedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function deliveryMetadata(d: Delivery): Delivery {
  return {
    id: d.id,
    attemptId: d.attemptId,
    text: "",
    source: d.source,
    status: d.status,
    at: d.at,
    images: d.images,
    questionIds: [],
    reportingWorkerId: d.reportingWorkerId,
    reportingReviewerId: d.reportingReviewerId,
    reportingResearcherId: d.reportingResearcherId,
    reviewTarget: d.reviewTarget,
    researchQuestion: d.researchQuestion?.slice(0, 2000),
    error: d.error?.slice(0, 2000),
    turnId: d.turnId,
    recoveryRef: true,
  };
}
export function associate(message: Message, deliveries: Delivery[]): Message {
  const d = message.clientId
    ? deliveries.find((d) => d.id === message.clientId)
    : undefined;
  return d
    ? {
        ...message,
        at: message.at || d.at,
        delivery: deliveryMetadata(d),
        ...(d.images?.length ? { images: d.images } : {}),
      }
    : message;
}
// Projection over native identity and the existing ledger; no transcript copy.
export function questionEntry(
  message: Message,
  questions: Question[],
): Message {
  return questions.some((q) => q.itemId === message.id)
    ? { ...message, questionItemId: message.id }
    : message;
}
export function readable(message: Message, budget: number): Message {
  return encodedBytes(message) > budget
    ? { ...message, text: "", bodyRef: message.id }
    : message;
}
export function recentWindow(
  messages: Message[],
  deliveries: Delivery[],
  questions: Question[] = [],
) {
  const result: Message[] = [];
  for (const message of messages.slice(-100).reverse()) {
    const projected = readable(
      questionEntry(associate(message, deliveries), questions),
      LIVE_BYTES - 2048,
    );
    if (encodedBytes([...result, projected]) > LIVE_BYTES) break;
    result.push(projected);
  }
  return result.reverse();
}
// A clipped native page resumes immediately before the oldest returned item.
// The anchor is an item identity, not a byte offset or another transcript. Native
// cursors remain opaque. Starting at latest is safe even if new items arrive
// before the next read: seek the anchor before returning older items.
type Cursor = {
  native?: string;
  before?: string;
};
function decode(cursor?: string): Cursor {
  if (!cursor) return {};
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
  if (
    !value ||
    typeof value !== "object" ||
    (value.native !== undefined && typeof value.native !== "string") ||
    (value.before !== undefined && typeof value.before !== "string")
  )
    throw new Error("Invalid reading cursor");
  return value;
}
const encode = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
export async function readingPage(
  runtime: Runtime,
  threadId: string,
  cursor: string | undefined,
  deliveries: Delivery[],
  budget = PAGE_BYTES,
  project: (m: Message) => Message | Promise<Message> = (m) => m,
) {
  let { native, before } = decode(cursor);
  for (;;) {
    const page = await runtime.historyMessages(threadId, native);
    let messages = page.messages;
    if (before) {
      const index = messages.findIndex((m) => m.id === before);
      if (index < 0) {
        if (!page.nextCursor)
          throw new Error(
            "Reading position unavailable. Retry from the conversation.",
          );
        native = page.nextCursor;
        continue;
      }
      messages = messages.slice(0, index);
      before = undefined;
    }
    const result: Message[] = [];
    for (const message of messages.slice().reverse()) {
      const projected = readable(
        await project(associate(message, deliveries)),
        budget - 2048,
      );
      const next = encode({ native, before: projected.id });
      if (
        result.length >= 100 ||
        encodedBytes({ messages: [...result, projected], nextCursor: next }) >
          budget
      )
        break;
      result.push(projected);
    }
    if (result.length < messages.length) {
      const nextCursor = encode({ native, before: result.at(-1)!.id });
      return { messages: result.reverse(), nextCursor };
    }
    if (!result.length && page.nextCursor) {
      native = page.nextCursor;
      continue;
    }
    return {
      messages: result.reverse(),
      nextCursor: page.nextCursor ? encode({ native: page.nextCursor }) : null,
    };
  }
}
export async function nativeBody(
  runtime: Runtime,
  threadId: string,
  itemId: string,
) {
  let cursor: string | undefined;
  do {
    const page = await runtime.historyMessages(threadId, cursor);
    const message = page.messages.find((m) => m.id === itemId);
    if (message) return message.text;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throw new Error("Message body unavailable");
}
