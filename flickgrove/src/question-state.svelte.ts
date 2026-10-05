import { navigation } from "./navigation.svelte";
import { storagePrefix } from "./api";
import type { Agent } from "./contracts";

// Device-local state survives detail remounts and authoritative reconnects.
export const questionPanels = $state<Record<string, boolean>>(
  JSON.parse(localStorage.getItem(`${storagePrefix}/question-panels`) ?? "{}"),
);
export function setQuestionPanel(id: string, open: boolean) {
  questionPanels[id] = open;
  localStorage.setItem(
    `${storagePrefix}/question-panels`,
    JSON.stringify(questionPanels),
  );
}
export function observeQuestions(agents: Agent[], selectedId: string | null) {
  if (navigation.surfaces.includes("file-preview")) return;
  for (const agent of agents) {
    const key = `${storagePrefix}/questions/${agent.id}`;
    const seen: string[] = JSON.parse(
      localStorage.getItem(`${key}/seen`) ?? "[]",
    );
    const fresh = agent.questions.filter(
      (q) => q.state === "unanswered" && !seen.includes(q.id),
    );
    // Arrival is not viewing: background sessions retain unseen IDs until selected.
    if (agent.id !== selectedId) continue;
    localStorage.setItem(
      `${key}/seen`,
      JSON.stringify([
        ...new Set([...seen, ...agent.questions.map((q) => q.id)]),
      ]),
    );
    if (!fresh.length) continue;
    const current = agent.questions.find(
      (q) => q.id === localStorage.getItem(`${key}/current`),
    );
    const drafts = JSON.parse(localStorage.getItem(key) ?? "{}");
    const draft = current && drafts[current.id];
    if (
      !current ||
      current.state === "answered" ||
      !(draft?.text?.trim() || draft?.edited)
    )
      localStorage.setItem(`${key}/current`, fresh[0].id);
    if (agent.id === selectedId) setQuestionPanel(agent.id, true);
  }
}
