import { saveImages, operationKey } from "./image-drafts";
import { z } from "zod";
import type { Detail, Answer } from "./contracts";
import {
  imageSchema,
  answerSchema,
  lookupSchema,
  type Receipt,
} from "./chord-contract";
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
  images: z.array(imageSchema).optional(),
  localImageIds: z.array(z.string()).optional(),
  answers: z.array(answerSchema).optional(),
});
// The operation journal keeps its existing encoding; presentation has three results.
export type SubmissionResult = "pending" | "accepted" | "rejected";
export function submissionResult(
  delivery: Pick<import("./contracts").Delivery, "status">,
): SubmissionResult {
  const { status } = delivery;
  return status === "sent"
    ? "accepted"
    : status === "failed"
      ? "rejected"
      : "pending";
}
const journalStatus = (status: SubmissionResult) =>
  status === "accepted"
    ? ("sent" as const)
    : status === "rejected"
      ? ("failed" as const)
      : ("sending" as const);
export type Outgoing = Omit<z.infer<typeof entry>, "status"> & {
  status: SubmissionResult;
};
const saved: Outgoing[] = [];
for (const storageKey of Object.keys(localStorage)) {
  if (!storageKey.startsWith(prefix)) continue;
  try {
    const o = entry.parse(JSON.parse(localStorage.getItem(storageKey)!));
    if (localStorage.getItem(storageKey + "/dismissed")) continue;
    saved.push({
      ...o,
      status: submissionResult(o),
    });
  } catch {
    /* malformed device-owned cache supplies no facts */
  }
}
export const outgoing = $state<{ entries: Outgoing[] }>({ entries: saved });
function persist(o: Outgoing) {
  // Each operation owns its record; an unrelated tab cannot erase its journal.
  if (receiptAlreadyAccepted(o.agentId, o.id)) {
    o.status = "accepted";
    o.error = undefined;
  }
  const raw = localStorage.getItem(key(o));
  try {
    const previous = entry.safeParse(JSON.parse(raw ?? "null"));
    if (previous.success && previous.data.status === "sent") {
      o.status = "accepted";
      o.error = undefined;
    }
  } catch {
    /* A malformed record supplies no receipt. */
  }
  localStorage.setItem(
    key(o),
    JSON.stringify({ ...o, status: journalStatus(o.status) }),
  );
}
export function addOutgoing(
  agentId: string,
  text: string,
  id: string,
  answers?: Answer[],
  images?: import("./contracts").MessageImage[],
  localImageIds?: string[],
) {
  const previous = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === id,
  );
  if (previous) {
    if (
      previous.text !== text ||
      JSON.stringify(previous.answers) !== JSON.stringify(answers) ||
      JSON.stringify(previous.images ?? []) !== JSON.stringify(images ?? []) ||
      JSON.stringify(previous.localImageIds ?? []) !==
        JSON.stringify(localImageIds ?? [])
    )
      throw new Error("Operation ID is bound to different content");
    if (previous.status === "accepted" || receiptAlreadyAccepted(agentId, id))
      return;
    previous.status = "pending";
    previous.error = undefined;
    persist(previous);
    return;
  }
  const o: Outgoing = {
    agentId,
    text,
    id,
    at: Date.now(),
    status: "pending",
    images: images ? structuredClone(images) : undefined,
    localImageIds: localImageIds ? [...localImageIds] : undefined,
    ...(answers ? { answers: structuredClone(answers) } : {}),
  };
  persist(o);
  outgoing.entries.push(o);
}
export function receiptAlreadyAccepted(agentId: string, id: string) {
  return !!localStorage.getItem(
    `flickgrove/${location.origin}/accepted/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
  );
}
function rememberAccepted(agentId: string, id: string) {
  localStorage.setItem(
    `flickgrove/${location.origin}/accepted/${encodeURIComponent(agentId)}/${encodeURIComponent(id)}`,
    "true",
  );
}
export function observeOutgoing(detail: Detail) {
  for (const delivery of detail.deliveries)
    if (
      delivery.status === "sent" ||
      detail.messages.some((m) => m.role === "user" && m.id === delivery.id)
    )
      rememberAccepted(detail.id, delivery.id);
  outgoing.entries = outgoing.entries.filter((o) => {
    if (localStorage.getItem(key(o) + "/dismissed")) return false;
    if (o.agentId !== detail.id) return true;
    if (detail.messages.some((m) => m.role === "user" && m.id === o.id)) {
      rememberAccepted(o.agentId, o.id);
      localStorage.removeItem(key(o));
      if (o.localImageIds?.length || o.images?.length)
        void saveImages(operationKey(o.agentId, o.id), []).catch(() => {});
      return false;
    }
    const d = detail.deliveries.find((d) => d.id === o.id);
    if (d && o.status !== "accepted") {
      o.status = submissionResult(d);
      if (o.status === "accepted") rememberAccepted(o.agentId, o.id);
      o.error = d.error;
      persist(o);
    }
    return true;
  });
}
export function acceptReceipt(agentId: string, raw: Receipt | null) {
  const receipt = lookupSchema.parse(raw);
  if (!receipt) return;
  if (receipt.state === "accepted")
    rememberAccepted(agentId, receipt.operationId);
  if (
    receipt.state !== "accepted" &&
    receiptAlreadyAccepted(agentId, receipt.operationId)
  )
    return;
  const o = outgoing.entries.find(
    (o) => o.agentId === agentId && o.id === receipt.operationId,
  );
  if (!o || o.status === "accepted") return;
  o.status = receipt.state === "accepted" ? "accepted" : "rejected";
  o.error = receipt.error ?? undefined;
  persist(o);
}
export function unknownOutgoing(agentId: string, id: string, error: string) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o && o.status !== "accepted" && !receiptAlreadyAccepted(agentId, id)) {
    o.status = "pending";
    o.error = error;
    persist(o);
  }
}
export function withOutgoing(detail: Detail): Detail {
  void dismissedVersion.value;
  const dismissed = (id: string) =>
    !!localStorage.getItem(
      `${prefix}${encodeURIComponent(detail.id)}/${encodeURIComponent(id)}/dismissed`,
    );
  const local = outgoing.entries.filter(
    (o) =>
      o.agentId === detail.id &&
      !dismissed(o.id) &&
      !detail.messages.some((m) => m.id === o.id),
  );
  const unobserved = detail.deliveries.filter(
    (d) =>
      !dismissed(d.id) &&
      (d.source === "user" || d.source === "question") &&
      !detail.messages.some((m) => m.id === d.id) &&
      !local.some((o) => o.id === d.id),
  );
  return {
    ...detail,
    questions: detail.questions.map((q) => {
      const confirmed = local.find(
        (o) =>
          o.status === "accepted" &&
          o.answers?.some((a) => a.questionId === q.id),
      );
      const accepted =
        confirmed ??
        detail.deliveries.find(
          (d) =>
            receiptAlreadyAccepted(detail.id, d.id) &&
            d.answers?.some((a) => a.questionId === q.id),
        );
      const answer = accepted?.answers?.find((a) => a.questionId === q.id);
      return answer
        ? { ...q, state: "answered" as const, answer: answer.answer }
        : q;
    }),
    messages: [
      ...detail.messages,
      ...local.map((o) => ({
        id: o.id,
        text: o.text,
        images: o.images,
        localImageIds: o.localImageIds,
        role: "user" as const,
        at: o.at,
      })),
      ...unobserved.map((d) => ({
        id: d.id,
        text: d.text,
        images: d.images,
        role: "user" as const,
        at: d.at,
      })),
    ],
    deliveries: [
      ...detail.deliveries
        .filter((d) => !dismissed(d.id) && !local.some((o) => o.id === d.id))
        .map((d) =>
          receiptAlreadyAccepted(detail.id, d.id)
            ? { ...d, status: "sent" as const, error: undefined }
            : d,
        ),
      ...local.map((o) => ({
        id: o.id,
        text: o.text,
        images: o.images,
        status: journalStatus(o.status),
        source: o.answers ? ("question" as const) : ("user" as const),
        questionIds: o.answers?.map((a) => a.questionId) ?? [],
        ...(o.answers ? { answers: o.answers } : {}),
        error: o.error,
        at: o.at,
      })),
    ],
  };
}

const dismissedVersion = $state({ value: 0 });
window.addEventListener("storage", (event) => {
  if (!event.key?.startsWith(prefix)) return;
  dismissedVersion.value++;
  if (event.key.endsWith("/dismissed")) {
    outgoing.entries = outgoing.entries.filter(
      (o) => !localStorage.getItem(key(o) + "/dismissed"),
    );
    return;
  }
  if (event.newValue) {
    try {
      const parsed = entry.parse(JSON.parse(event.newValue));
      const local = outgoing.entries.find(
        (o) => o.id === parsed.id && o.agentId === parsed.agentId,
      );
      if (local && parsed.status === "sent") {
        Object.assign(local, { ...parsed, status: "accepted" });
        rememberAccepted(local.agentId, local.id);
      }
    } catch {}
  }
});

export function setOutgoingImages(
  agentId: string,
  id: string,
  images: import("./contracts").MessageImage[],
) {
  const o = outgoing.entries.find((o) => o.agentId === agentId && o.id === id);
  if (o) {
    if (o.images && JSON.stringify(o.images) !== JSON.stringify(images))
      throw new Error("Operation ID is bound to different images");
    o.images = structuredClone(images);
    persist(o);
  }
}
