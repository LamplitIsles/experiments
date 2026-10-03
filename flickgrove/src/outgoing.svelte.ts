import { z } from "zod";
import type { Detail } from "./contracts";
import { receiptSchema, type Receipt } from "./chord-contract";
const prefix = `flickgrove/${location.origin}/outgoing/`;
const key = (o: Outgoing) =>
  `${prefix}${encodeURIComponent(o.agentId)}/${encodeURIComponent(o.id)}`;
const entry = z.object({
  agentId: z.string(),
  id: z.string(),
  text: z.string(),
  at: z.number(),
  status: z.enum(["sending", "sent", "failed", "uncertain"]),
  error: z.string().optional(),
});
export type Outgoing = z.infer<typeof entry>;
const saved: Outgoing[] = [];
for (const storageKey of Object.keys(localStorage)) {
  if (!storageKey.startsWith(prefix)) continue;
  try {
    const o = entry.parse(JSON.parse(localStorage.getItem(storageKey)!));
    saved.push({
      ...o,
      status: o.status === "sending" ? "uncertain" : o.status,
    });
  } catch {
    /* malformed device-owned cache supplies no facts */
  }
}
export const outgoing = $state<{ entries: Outgoing[] }>({ entries: saved });
function persist(o: Outgoing) {
  // Each operation owns its record; an unrelated tab cannot erase its journal.
  const raw = localStorage.getItem(key(o));
  try {
    const previous = entry.safeParse(JSON.parse(raw ?? "null"));
    if (previous.success && previous.data.status === "sent") {
      o.status = "sent";
      o.error = undefined;
    }
  } catch {
    /* A malformed record supplies no receipt. */
  }
  localStorage.setItem(key(o), JSON.stringify(o));
}
export function addOutgoing(agentId: string, text: string, id: string) {
  const o: Outgoing = {
    agentId,
    text,
    id,
    at: Date.now(),
    status: "sending",
  };
  outgoing.entries.push(o);
  persist(o);
}
export function observeOutgoing(detail: Detail) {
  outgoing.entries = outgoing.entries.filter((o) => {
    if (o.agentId !== detail.id) return true;
    if (detail.messages.some((m) => m.id === o.id)) {
      localStorage.removeItem(key(o));
      return false;
    }
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
      persist(o);
    }
    return true;
  });
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
  persist(o);
}
export function unknownOutgoing(agentId: string, id: string, error: string) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o && o.status !== "sent") {
    o.status = "uncertain";
    o.error = error;
    persist(o);
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
