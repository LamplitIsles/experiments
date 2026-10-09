import { z } from "zod";
export const sessionTitle = z.string().trim().min(1).max(120);
const message = z.string().trim().min(1).max(100_000);
const workerId = z.string().min(1);
const reviewerId = z.string().min(1);
const profile = z.enum(["standards", "spec", "high_risk_spec", "penpot"]);
const target = {
  spec: z.string().trim().min(1).max(500),
  fixedPoint: z.string().trim().min(1).max(500),
  reviewedHead: z.string().trim().min(1).max(500),
};
export const toolDefinitions = {
  reviewer_start: {
    description:
      "Start an independent read-only Reviewer in a registered project. Captures profile configuration and prompt. Includes initial dispatch; inspect reviewer_list/read after uncertain admission, never replay blindly.",
    shape: {
      project: z.string().min(1),
      profile,
      title: sessionTitle,
      ...target,
      message,
    },
  },
  reviewer_list: {
    description:
      "List your open Reviewers and their saved review targets, state and questions.",
    shape: {},
  },
  reviewer_read: {
    description:
      "Read your Reviewer conversation and target; paginate with nextBefore. Does not poll.",
    shape: {
      reviewerId,
      before: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  reviewer_send: {
    description:
      "Continue the same Reviewer for re-review with an explicit fixed point and reviewed HEAD. questionIds answers only specific delegated questions. Pending closure accepts only such answers; target cannot change during closure. Inspect uncertain state before retrying.",
    shape: {
      reviewerId,
      ...target,
      message,
      questionIds: z.array(z.string().min(1)).max(100).optional(),
    },
  },
  reviewer_close: {
    description:
      "Request durable asynchronous Reviewer closure. Does not interrupt. Existing question/report/delivery guards apply; closing=true means accepted. Explicit confirmInterrupted resolves an inspected unknown turn, not deliveries.",
    shape: { reviewerId, confirmInterrupted: z.boolean().optional() },
  },
  reviewer_report: {
    description:
      "Report natural-language progress/questions/conclusion to owning Orc. spec, fixedPoint and reviewedHead must match the assigned target; report preserves Reviewer identity, profile, spec, fixed point and HEAD. Never claim unperformed validation.",
    shape: { message, ...target },
  },
  worker_start: {
    description:
      "Start one implementation Worker for one registered project and one spec. Uses the Worker model and effort captured by the owning Orc. Return the Worker ID for subsequent operations.",
    shape: {
      project: z.string().min(1),
      title: sessionTitle,
      spec: z.string().trim().min(1).max(500),
      message,
    },
  },
  worker_list: {
    description:
      "List your Workers with current state, project, questions and continuous working timestamp.",
    shape: {},
  },
  worker_read: {
    description:
      "Read complete natural-language Worker messages. Omit before to start at the newest page; use nextBefore for earlier history. Never polls new messages. Includes current Worker state.",
    shape: {
      workerId,
      before: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  worker_send: {
    description:
      "Send instructions to your Worker. Steers when busy, starts when idle. Include questionIds only for specific delegated questions this message answers. A Worker awaiting closure only accepts answers to existing delegated questions.",
    shape: {
      workerId,
      message,
      questionIds: z.array(z.string().min(1)).max(100).optional(),
    },
  },
  worker_close: {
    description:
      "Request closure of your Worker. Closes immediately when ready; otherwise returns closing=true with a waiting reason and automatically closes after the current turn, questions and report deliveries resolve. Does not interrupt work. No new tasks are accepted after this request; answers to existing delegated questions remain allowed. Inspect worker_list or worker_read for pending closure reasons; do not retry closure just because work is still running. If the backend restarted or disconnected, inspect the interrupted Worker and explicitly confirmInterrupted to resolve an unknown turn outcome; delivery and question guards still apply.",
    shape: { workerId, confirmInterrupted: z.boolean().optional() },
  },
  worker_report: {
    description:
      "Deliver a natural-language progress update, question or completion report to your owning Orc. The host routes delivery; you do not need to inspect Orc state.",
    shape: { message },
  },
};
export const roleTools = {
  orc: [
    "worker_start",
    "worker_list",
    "worker_read",
    "worker_send",
    "worker_close",
    "reviewer_start",
    "reviewer_list",
    "reviewer_read",
    "reviewer_send",
    "reviewer_close",
  ],
  worker: ["worker_report"],
  reviewer: ["reviewer_report"],
} as const;
