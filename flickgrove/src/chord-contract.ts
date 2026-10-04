import {
  defineService,
  type Context,
  type JsonValue,
  type JsonRepresentation,
  type ReplicatedState,
} from "@earendil-works/chord";
import { z } from "zod";
import type { Detail, Snapshot } from "./contracts";

export type View = { snapshot: Snapshot; details: Record<string, Detail> };
export type Receipt = {
  operationId: string;
  state: "accepted" | "rejected" | "uncertain" | "pending" | "missing";
  turnId: string | null;
  error: string | null;
};
const id = z.string().min(1).max(500);
const text = z.string().trim().min(1).max(100_000);
export const answerSchema = z.object({ questionId: id, answer: text });
const defaults = z.object({ model: id, effort: id });
export const inputs = {
  select: z.object({ ids: z.array(id).max(100) }),
  identity: z.object({}),
  projects: z.object({ host: id.optional() }),
  models: z.object({ host: id.optional() }),
  weekly: z.object({ host: id.optional() }),
  history: z.object({
    project: id,
    query: z.string(),
    cursor: id.optional(),
    host: id.optional(),
  }),
  historySession: z.object({ project: id, threadId: id, host: id.optional() }),
  historyMessages: z.object({
    project: id,
    threadId: id,
    cursor: id.optional(),
    host: id.optional(),
  }),
  resumeHistory: z.object({
    project: id,
    threadId: id,
    archived: z.boolean(),
    host: id.optional(),
  }),
  agentHistory: z.object({ id, cursor: id.optional() }),
  detail: z.object({ id }),
  skills: z.object({ id }),
  createOrc: z.object({ project: id, host: id.optional() }),
  saveSettings: z.object({
    fast: z.boolean(),
    orc: defaults,
    worker: defaults,
  }),
  register: z.object({
    id: id.optional(),
    name: z.string().min(1).max(120),
    url: z.string().max(2048),
    credential: z.string().max(1000),
  }),
  send: z.object({ id, text, operationId: z.string().min(1).max(120) }),
  retryDelivery: z.object({ id, deliveryId: id }),
  lookup: z.object({ id, operationId: z.string().min(1).max(120) }),
  answerBatch: z.object({
    id,
    answers: z.array(answerSchema).min(1),
    operationId: z.string().min(1).max(120),
  }),
  stop: z.object({ id, turnId: id }),
  rename: z.object({ id, title: z.string().max(1000) }),
  closeTree: z.object({ id }),
};
export type Method = keyof typeof inputs;
type Methods = {
  [K in Method]: (input: JsonValue, context: Context) => Promise<JsonValue>;
};
export type GroveContract = Methods & {
  view: ReplicatedState<JsonRepresentation<View>>;
};
export const Grove = defineService<GroveContract>("flickgrove.workspace.v1");
export const receiptSchema = z.object({
  operationId: id,
  state: z.enum(["accepted", "rejected", "uncertain", "pending", "missing"]),
  turnId: z.string().nullable(),
  error: z.string().nullable(),
});
// Domain fields are validated on both receiving boundaries; unknown engine fields never enter state.
const question = z.object({
  id,
  itemId: id,
  index: z.number(),
  title: z.string(),
  text: z.string(),
  options: z.array(
    z.object({ label: z.string(), description: z.string().optional() }),
  ),
  state: z.enum(["unanswered", "delegated", "answered"]),
  answer: z.string().optional(),
  at: z.number(),
});
const agent = z.object({
  id,
  role: z.enum(["orc", "worker"]),
  ownerId: id.optional(),
  hostId: id.optional(),
  hostName: z.string().optional(),
  project: z.object({ alias: id, name: z.string(), path: z.string() }),
  title: z.string(),
  model: z.string(),
  effort: z.string(),
  serviceTier: z.string(),
  state: z.enum(["idle", "working", "stopping", "error"]),
  closed: z.boolean(),
  questions: z.array(question),
  threadId: id.optional(),
  turnId: id.optional(),
  workingSince: z.number().optional(),
  error: z.string().optional(),
  historyCursor: z.string().optional(),
  historyMessageCount: z.number().optional(),
  closeRequest: z.object({ reason: z.string() }).optional(),
  stop: z
    .object({
      turnId: id,
      status: z.enum(["pending", "unknown", "confirmed", "completed"]),
    })
    .optional(),
});
export const detailSchema = agent.extend({
  messages: z.array(
    z.object({
      id,
      role: z.enum(["user", "assistant"]),
      text: z.string(),
      at: z.number(),
      turnId: id.optional(),
    }),
  ),
  deliveries: z.array(
    z.object({
      id,
      text: z.string(),
      status: z.enum(["queued", "sending", "sent", "failed", "uncertain"]),
      source: z.enum(["user", "worker", "question"]),
      questionIds: z.array(id),
      answers: z.array(answerSchema).optional(),
      at: z.number(),
      reportingWorkerId: id.optional(),
      error: z.string().optional(),
      turnId: id.optional(),
    }),
  ),
});
export const snapshotSchema = z.object({
  hubId: id.optional(),
  revision: z.number(),
  settings: inputs.saveSettings.nullable(),
  agents: z.array(agent),
  hosts: z
    .array(
      z.object({
        id,
        name: z.string(),
        url: z.string(),
        role: z.enum(["hub", "execution"]),
        connected: z.boolean(),
        defaults: z.enum(["synced", "pending", "failed"]),
        lastSeen: z.number().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});
export const viewSchema = z.object({
  snapshot: snapshotSchema,
  details: z.record(z.string(), detailSchema),
});
export function jsonValue<T>(value: T): JsonRepresentation<T> {
  return JSON.parse(JSON.stringify(value));
}

// Repository callers share this mapping while necessary HTTP reads remain available.
export function routeCall(
  path: string,
  body?: unknown,
): { member: Method; input: JsonValue } {
  const url = new URL(path, "http://grove.invalid");
  const host = url.searchParams.get("host") ?? undefined;
  const project = url.searchParams.get("project") ?? "";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const threadId = url.searchParams.get("thread") ?? "";
  const simple: Record<string, [Method, unknown]> = {
    "/identity": ["identity", {}],
    "/projects": ["projects", { host }],
    "/models": ["models", { host }],
    "/weekly": ["weekly", { host }],
    "/settings": ["saveSettings", body],
    "/hosts": ["register", body],
    "/agents": ["createOrc", { ...(body as object), host }],
    "/history": [
      "history",
      { project, host, cursor, query: url.searchParams.get("query") ?? "" },
    ],
    "/history/session": ["historySession", { project, host, threadId }],
    "/history/messages": [
      "historyMessages",
      { project, host, threadId, cursor },
    ],
    "/history/resume": ["resumeHistory", { ...(body as object), host }],
  };
  let route = simple[url.pathname];
  const match =
    /^\/agents\/([^/]+)(?:\/(messages|lookup|answers|skills|stop|title|close|history))?$/.exec(
      url.pathname,
    );
  if (match) {
    const id = decodeURIComponent(match[1]);
    const members = {
      messages: "send",
      lookup: "lookup",
      answers: "answerBatch",
      skills: "skills",
      stop: "stop",
      title: "rename",
      close: "closeTree",
      history: "agentHistory",
    } as const;
    const member = match[2]
      ? members[match[2] as keyof typeof members]
      : "detail";
    const input = { ...(body as object), id, cursor };
    route = [member, input];
  }
  if (!route) throw new Error("Action not found");
  return {
    member: route[0],
    input: jsonValue(inputs[route[0]].parse(route[1])) as JsonValue,
  };
}
