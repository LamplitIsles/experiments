import { z } from "zod";
import type { Detail } from "./contracts";
import { receiptSchema, type Receipt } from "./chord-contract";
const key = `flickgrove/${location.origin}/outgoing`;
const entry = z.object({
  agentId: z.string(),
  id: z.string(),
  text: z.string(),
  at: z.number(),
  status: z.enum(["sending", "sent", "failed", "uncertain"]),
  error: z.string().optional(),
});
export type Outgoing = z.infer<typeof entry>;
let saved: Outgoing[] = [];
try {
  saved = z
    .array(entry)
    .parse(JSON.parse(localStorage.getItem(key) ?? "[]"))
    .map((o) => ({
      ...o,
      status: o.status === "sending" ? "uncertain" : o.status,
    }));
} catch {
  /* malformed device-owned cache supplies no facts */
}
export const outgoing = $state<{ entries: Outgoing[] }>({ entries: saved });
function persist() {
  localStorage.setItem(key, JSON.stringify(outgoing.entries));
}
export function addOutgoing(agentId: string, text: string, id: string) {
  outgoing.entries.push({
    agentId,
    text,
    id,
    at: Date.now(),
    status: "sending",
  });
  persist();
}
export function observeOutgoing(detail: Detail) {
  outgoing.entries = outgoing.entries.filter((o) => {
    if (o.agentId !== detail.id) return true;
    if (detail.messages.some((m) => m.id === o.id)) return false;
    const d = detail.deliveries.find((d) => d.id === o.id);
    if (d && o.status !== "sent") {
      o.status =
        d.status === "sent"
          ? "sent"
          : d.status === "failed"
            ? "failed"
            : d.status === "uncertain"
              ? "uncertain"
              : o.status;
      o.error = d.error;
    }
    return true;
  });
  persist();
}
export function acceptReceipt(agentId: string, raw: Receipt) {
  const receipt = receiptSchema.parse(raw);
  const o = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === receipt.operationId,
  );
  if (!o || o.status === "sent") return;
  if (receipt.state === "accepted") o.status = "sent";
  else if (receipt.state === "rejected") o.status = "failed";
  else o.status = "uncertain";
  o.error = receipt.error ?? undefined;
  persist();
}
export function unknownOutgoing(agentId: string, id: string, error: string) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o && o.status !== "sent") {
    o.status = "uncertain";
    o.error = error;
    persist();
  }
}
export function withOutgoing(detail: Detail): Detail {
  const local = outgoing.entries.filter(
    (o) =>
      o.agentId === detail.id && !detail.messages.some((m) => m.id === o.id),
  );
  const unobserved = detail.deliveries.filter(
    (d) =>
      d.source === "user" &&
      !detail.messages.some((m) => m.id === d.id) &&
      !local.some((o) => o.id === d.id),
  );
  return {
    ...detail,
    messages: [
      ...detail.messages,
      ...local.map((o) => ({
        id: o.id,
        text: o.text,
        role: "user" as const,
        at: o.at,
      })),
      ...unobserved.map((d) => ({
        id: d.id,
        text: d.text,
        role: "user" as const,
        at: d.at,
      })),
    ],
    deliveries: [
      ...detail.deliveries.filter((d) => !local.some((o) => o.id === d.id)),
      ...local.map((o) => ({
        id: o.id,
        text: o.text,
        status: o.status,
        source: "user" as const,
        questionIds: [],
        error: o.error,
        at: o.at,
      })),
    ],
  };
}
