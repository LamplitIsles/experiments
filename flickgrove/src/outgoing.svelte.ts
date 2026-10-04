import { z } from "zod";
import type { Detail, Answer } from "./contracts";
import { answerSchema, receiptSchema, type Receipt } from "./chord-contract";
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
  answers: z.array(answerSchema).optional(),
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
export function addOutgoing(
  agentId: string,
  text: string,
  id: string,
  answers?: Answer[],
) {
  const previous = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (previous) {
    if (
      previous.text !== text ||
      JSON.stringify(previous.answers) !== JSON.stringify(answers)
    )
      throw new Error("Operation ID is bound to different content");
    previous.status = "sending";
    previous.error = undefined;
    persist(previous);
    return;
  }
  const o: Outgoing = {
    agentId,
    text,
    id,
    at: Date.now(),
    status: "sending",
    ...(answers ? { answers: structuredClone(answers) } : {}),
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
    questions: detail.questions.map((q) => {
      const confirmed = local.find(
        (o) =>
          o.status === "sent" && o.answers?.some((a) => a.questionId === q.id),
      );
      const answer = confirmed?.answers?.find((a) => a.questionId === q.id);
      return answer
        ? { ...q, state: "answered" as const, answer: answer.answer }
        : q;
    }),
    messages: [
      ...detail.messages,
      ...local
        .filter((o) => !o.answers)
        .map((o) => ({
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
        source: o.answers ? ("question" as const) : ("user" as const),
        questionIds: o.answers?.map((a) => a.questionId) ?? [],
        ...(o.answers ? { answers: o.answers } : {}),
        error: o.error,
        at: o.at,
      })),
    ],
  };
}
