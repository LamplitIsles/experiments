import { createHash } from "node:crypto";
import type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DeliveryRejected } from "./runtime";

type NativeMessage = Extract<
  Parameters<AgentSession["agent"]["steer"]>[0],
  { role: "user" }
>;
type Receipt = {
  operation: string;
  fingerprint: string;
  itemId: string;
  runId: string;
};
type Pending = {
  operation: string;
  fingerprint: string;
  runId: string;
  imageCount: number;
  resolve: (receipt: Receipt) => void;
  reject: (error: Error) => void;
};

/** Relates Grove envelopes to exact Pi message objects, then native entry IDs.
 * A queued message is never a receipt. Only the post-persistence Agent listener
 * may append the native association and release the caller's acceptance wait.
 */
export class PiAdmission {
  private readonly messages = new WeakMap<object, Pending>();
  private readonly pending = new Map<string, Pending>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly envelopes = new Map<string, string>();
  private starting?: Pending;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSettled: () => void;
  private closed = false;
  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly accepted: (
      receipt: Receipt,
      message: NativeMessage,
    ) => void,
  ) {
    for (const entry of manager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "grove-envelope") {
        const data = entry.data as { operation: string; fingerprint: string };
        this.envelopes.set(data.operation, data.fingerprint);
      } else if (entry.customType === "grove-accepted") {
        const data = entry.data as Receipt;
        this.receipts.set(data.operation, data);
      }
    }
    this.unsubscribeSettled = session.subscribe((event) => {
      if (event.type !== "agent_settled" || this.closed) return;
      if (this.pending.size) session.clearQueue();
      for (const pending of this.pending.values())
        pending.reject(
          new Error(
            "Pi run settled without durable admission; outcome is unknown",
          ),
        );
      this.pending.clear();
      this.starting = undefined;
    });
    // AgentSession subscribed at construction. Agent awaits subscribers in
    // registration order; unlike session.subscribe, this listener runs after
    // SessionManager.appendMessage returned successfully.
    this.unsubscribe = session.agent.subscribe((event) => {
      if (
        this.closed ||
        event.type !== "message_end" ||
        event.message.role !== "user"
      )
        return;
      let pending = this.messages.get(event.message);
      if (!pending && this.starting) {
        pending = this.starting;
        this.starting = undefined;
        this.messages.set(event.message, pending);
      }
      if (!pending) return;
      const imageCount =
        typeof event.message.content === "string"
          ? 0
          : event.message.content.filter((part) => part.type === "image")
              .length;
      if (imageCount !== pending.imageCount) {
        const error = new Error(
          "Pi did not persist the complete image envelope; admission is unknown",
        );
        pending.reject(error);
        throw error;
      }
      const entry = manager.getLeafEntry();
      if (entry?.type !== "message" || entry.message !== event.message)
        throw new Error("Pi native message identity was not persisted");
      const receipt = {
        operation: pending.operation,
        fingerprint: pending.fingerprint,
        itemId: entry.id,
        runId: pending.runId,
      };
      manager.appendCustomEntry("grove-accepted", receipt);
      this.receipts.set(pending.operation, receipt);
      this.pending.delete(pending.operation);
      pending.resolve(receipt);
      this.accepted(receipt, event.message);
    });
  }
  async send(
    operation: string,
    text: string,
    images: NonNullable<
      NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"]
    >,
    runId: string,
  ): Promise<Receipt> {
    if (this.closed) throw new DeliveryRejected("Pi session is closed");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ text, images }))
      .digest("hex");
    const prior = this.envelopes.get(operation);
    if (
      (prior && prior !== fingerprint) ||
      (this.receipts.has(operation) &&
        this.receipts.get(operation)!.fingerprint !== fingerprint)
    )
      throw new DeliveryRejected("Operation ID is bound to different content");
    const receipt = this.receipts.get(operation);
    if (receipt) return receipt;
    if (prior)
      throw new Error(
        "Pi admission is unknown; inspect history before continuing",
      );
    if (this.starting)
      throw new DeliveryRejected("Pi session is starting another prompt");
    // This intent is not acceptance. It prevents a restart from replaying an
    // envelope that may already have crossed the native seam.
    this.manager.appendCustomEntry("grove-envelope", {
      operation,
      fingerprint,
      runId,
    });
    this.envelopes.set(operation, fingerprint);
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const result = new Promise<Receipt>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending = {
      operation,
      fingerprint,
      runId,
      imageCount: images.length,
      resolve,
      reject,
    };
    this.pending.set(operation, pending);
    const fail = (error: Error) => {
      if (this.receipts.has(operation)) return;
      this.pending.delete(operation);
      if (this.starting === pending) this.starting = undefined;
      reject(error);
    };
    if (this.session.isStreaming) {
      const message: NativeMessage = {
        role: "user",
        content: [{ type: "text", text }, ...images],
        timestamp: Date.now(),
      };
      this.messages.set(message, pending);
      this.session.agent.steer(message);
    } else {
      this.starting = pending;
      void this.session
        .prompt(text, { images, expandPromptTemplates: false })
        .then(
          () => {
            if (this.pending.has(operation))
              fail(new Error("Pi prompt ended without durable admission"));
          },
          (error) => {
            fail(error);
          },
        );
    }
    return result;
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeSettled();
    for (const p of this.pending.values())
      p.reject(new Error("Pi admission is unknown after session release"));
    this.pending.clear();
    this.envelopes.clear();
    this.receipts.clear();
    this.starting = undefined;
  }
}
