import type { Agent, Message } from "./contracts";

// The boundary belongs to Grove's messages, not to the native pagination cursor.
export function splitMessages(
  detail: Pick<Agent, "historyBoundaryId"> & { messages: Message[] },
) {
  const index = detail.historyBoundaryId
    ? detail.messages.findIndex((m) => m.id === detail.historyBoundaryId)
    : -1;
  if (detail.historyBoundaryId && index < 0)
    throw new Error("Historical message boundary is missing");
  return {
    historical: detail.messages.slice(0, index + 1),
    live: detail.messages.slice(index + 1),
  };
}
