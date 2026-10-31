import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  Cursor,
  Storage,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import type { Delivery } from "../src/contracts";

// A saved generation or verified placed input anchors recovery. Record IDs are
// allocated in increasing order by the installed SQLite store; ID order bounds
// the scan but never substitutes for a completion time.
export async function recoveredPiActivity(
  storage: Pick<Storage, "task" | "scanTasks" | "submission" | "entry">,
  conversation: ConversationId,
  turnId: string,
  deliveries: Delivery[],
): Promise<number | undefined> {
  const id = Number(turnId);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== turnId) return;
  const original = await storage.task(id as TaskId, BACKGROUND_CONTEXT);
  const generation = (task: typeof original) =>
    !!task &&
    task.conversationId === conversation &&
    task.kind === "pi.generation" &&
    task.owner === undefined &&
    !task.background &&
    typeof task.startedAt === "number" &&
    Number.isFinite(task.startedAt);
  const terminalTime = (task: typeof original) =>
    generation(task) &&
    task?.state.status === "terminal" &&
    typeof task.endedAt === "number" &&
    Number.isFinite(task.endedAt)
      ? task.endedAt
      : undefined;
  let latest: number | undefined;
  if (original) {
    if (original.id !== id || !generation(original)) return;
  } else {
    const submission = await storage.submission(
      id as SubmissionId,
      BACKGROUND_CONTEXT,
    );
    if (
      !submission ||
      submission.id !== id ||
      submission.conversationId !== conversation ||
      submission.type !== "input" ||
      !submission.requestId ||
      (submission.status !== "done" && submission.status !== "unanswered") ||
      submission.entry === undefined ||
      !deliveries.some(
        (d) =>
          d.id === submission.requestId &&
          d.turnId === turnId &&
          d.status !== "failed",
      )
    )
      return;
    const input = (
      await storage.entry(conversation, submission.entry, BACKGROUND_CONTEXT)
    )?.entry;
    if (
      input?.id !== submission.entry ||
      input.conversationId !== conversation ||
      input.kind !== "grove.input" ||
      !input.data ||
      typeof input.data !== "object" ||
      Array.isArray(input.data) ||
      input.data.operation !== submission.requestId
    )
      return;
    // A steered input can be placed by a generation older than its submission.
    // That generation is directly identified by the entry, not by ID order.
    if (input.byTaskId) {
      const task = await storage.task(input.byTaskId, BACKGROUND_CONTEXT);
      if (task?.id === input.byTaskId) latest = terminalTime(task);
    }
    if (submission.status === "done") {
      const answer = (
        await storage.entry(conversation, submission.answer, BACKGROUND_CONTEXT)
      )?.entry;
      if (
        answer?.id === submission.answer &&
        answer.conversationId === conversation &&
        answer.kind === "pi.assistant" &&
        answer.byTaskId
      ) {
        const task = await storage.task(answer.byTaskId, BACKGROUND_CONTEXT);
        const time =
          task?.id === answer.byTaskId ? terminalTime(task) : undefined;
        if (
          time !== undefined &&
          task?.state.status === "terminal" &&
          task.state.outcome.status === "completed"
        ) {
          const result = task.state.outcome.result;
          if (
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            result.entryId === answer.id
          )
            latest = Math.max(latest ?? time, time);
        }
      }
    }
  }
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanTasks(
      {
        conversationId: conversation,
        kind: "pi.generation",
        status: "terminal",
        order: "descending",
      },
      100,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const task of page.items) {
      if (task.id < id) return latest;
      const time = terminalTime(task);
      if (time !== undefined) latest = Math.max(latest ?? time, time);
    }
    cursor = page.next;
  } while (cursor);
  return latest;
}
