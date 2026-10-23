import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageWindow, Message } from "../src/contracts";
import type { Runtime, RuntimeAgent } from "./runtime";
import {
  associate,
  questionEntry,
  readable,
  PAGE_BYTES,
} from "./conversation-reading";

/** Signed read cursors. Every native position stays bound to its original
 * business identity and direction, including captured remote target. */
export class MessageNavigation {
  private scope(a: RuntimeAgent) {
    return JSON.stringify([a.id, a.threadId, a.backend ?? "codex", a.project]);
  }
  private sign(a: RuntimeAgent, payload: string) {
    return createHmac("sha256", a.token)
      .update("message-navigation-v1:")
      .update(payload)
      .digest();
  }
  private encode(a: RuntimeAgent, direction: string, native: string | null) {
    if (!native) return null;
    const payload = Buffer.from(
      JSON.stringify({ scope: this.scope(a), direction, native }),
    ).toString("base64url");
    return `${payload}.${this.sign(a, payload).toString("base64url")}`;
  }
  async read(
    runtime: Runtime,
    a: RuntimeAgent,
    selection: { operation?: string; cursor?: string; direction?: string },
    project: (m: Message) => Message = (m) => m,
  ): Promise<MessageWindow> {
    if (!a.threadId || !runtime.messageWindow)
      throw new Error("Message navigation unavailable");
    let read: import("./runtime").WindowRead;
    if (selection.cursor) {
      const [payload, signature, extra] = selection.cursor.split(".");
      const expected = this.sign(a, payload),
        actual = Buffer.from(signature ?? "", "base64url");
      if (
        extra ||
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error("Invalid navigation cursor");
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (
        value.scope !== this.scope(a) ||
        value.direction !== selection.direction ||
        !["older", "newer"].includes(value.direction) ||
        typeof value.native !== "string" ||
        selection.operation
      )
        throw new Error("Navigation cursor scope mismatch");
      read = { cursor: value.native, direction: value.direction };
    } else {
      const d = a.deliveries.find(
        (d) => d.id === selection.operation && d.source === "user",
      );
      if (!d || selection.direction) throw new Error("User input not found");
      read = { operation: d.id, turnId: d.turnId };
    }
    const scope = this.scope(a);
    const page = await runtime.messageWindow(a.threadId, read);
    if (a.closed || this.scope(a) !== scope)
      throw new Error("Navigation identity changed");
    return {
      ...page,
      // Reserve an equal bounded slice per native item: preserve the whole page
      // and its cursor boundaries; long bodies use existing authorized bodyRefs.
      messages: page.messages.map((m) =>
        readable(
          project(questionEntry(associate(m, a.deliveries), a.questions)),
          Math.floor(PAGE_BYTES / 110),
        ),
      ),
      olderCursor: this.encode(a, "older", page.olderCursor),
      newerCursor: this.encode(a, "newer", page.newerCursor),
    };
  }
}
