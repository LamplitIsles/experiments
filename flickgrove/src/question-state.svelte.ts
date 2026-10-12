import type { Agent } from "./contracts";

// Disclosure belongs to this visit. Answer drafts remain in the existing
// Peer-qualified question store; returning always expands pending work.
export const questionPanels = $state<Record<string, boolean>>({});
export function setQuestionPanel(id: string, open: boolean) {
  questionPanels[id] = open;
}
let selected: string | null = null;
let items = new Set<string>();
export function observeQuestions(
  agents: Agent[],
  selectedId: string | null,
  entering = false,
) {
  for (const id of Object.keys(questionPanels))
    if (!agents.some((a) => a.id === id)) delete questionPanels[id];
  const agent = agents.find((a) => a.id === selectedId);
  const enteringVisit = entering || selected !== selectedId;
  if (enteringVisit) {
    selected = selectedId;
    items = new Set();
  }
  if (!agent) return;
  const pending = agent.questions.filter((q) => q.state === "unanswered");
  const next = new Set(pending.map((q) => q.itemId));
  if (
    (enteringVisit && (agent.unansweredCount ?? pending.length) > 0) ||
    [...next].some((id) => !items.has(id))
  )
    setQuestionPanel(agent.id, true);
  items = next;
}
