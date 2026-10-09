import { navigation } from "./navigation.svelte";
import { storagePrefix, readingCache } from "./api";
import type { Agent } from "./contracts";

// Device-local state survives detail remounts and authoritative reconnects.
export const questionPanels = $state<Record<string, boolean>>(
  (() => {
    try {
      return JSON.parse(
        localStorage.getItem(`${storagePrefix}/question-panels`) ?? "{}",
      );
    } catch {
      return {};
    }
  })(),
);
export function setQuestionPanel(id: string, open: boolean) {
  questionPanels[id] = open;
  try {
    readingCache.writeDevice(
      `${storagePrefix}/question-panels`,
      JSON.stringify(questionPanels),
    );
  } catch {
    /* Viewing state remains usable in memory. */
  }
}
const seenQuestions = new Map<string, string[]>();
export function observeQuestions(agents: Agent[], selectedId: string | null) {
  if (navigation.surfaces.includes("file-preview")) return;
  for (const agent of agents) {
    const key = `${storagePrefix}/questions/${agent.id}`;
    // Arrival is not viewing: background sessions retain unseen IDs until selected.
    if (agent.id !== selectedId) continue;
    let seen = seenQuestions.get(agent.id);
    if (!seen) {
      try {
        seen = JSON.parse(localStorage.getItem(`${key}/seen`) ?? "[]");
      } catch {
        /* Optional viewing state. */
      }
    }
    seen ??= [];
    const fresh = agent.questions.filter(
      (q) => q.state === "unanswered" && !seen.includes(q.id),
    );
    const next = [...new Set([...seen, ...agent.questions.map((q) => q.id)])];
    seenQuestions.set(agent.id, next);
    if (fresh.length) setQuestionPanel(agent.id, true);
    try {
      readingCache.writeDevice(`${key}/seen`, JSON.stringify(next));
    } catch {
      /* Never interrupt snapshot or receipt processing for viewing state. */
    }
    if (!fresh.length) continue;
    try {
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
        readingCache.writeDevice(`${key}/current`, fresh[0].id);
    } catch {
      /* Current-question selection is optional; drafts are untouched. */
    }
  }
}
