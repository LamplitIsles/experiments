<script lang="ts">
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { storagePrefix } from "./api";
  import { untrack } from "svelte";
  import type { Delivery, Question } from "./contracts";
  import { editable } from "./api";
  import * as m from "./paraglide/messages";
  let { agentId, questions, deliveries, connected, onanswer }: { agentId: string; questions: Question[]; deliveries: Delivery[]; connected: boolean; onanswer: (id: string, answer: string) => Promise<boolean> } = $props();
  const storageKey = untrack(() => `${storagePrefix}/questions/${agentId}`);
  type Draft = { selected: string; text: string };
  let drafts = $state<Record<string, Draft>>(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  let currentId = $state(untrack(() => localStorage.getItem(`${storageKey}/current`) ?? questions.find(q => q.state === "unanswered")?.id ?? questions[0]?.id));
  let overview = $state(false); let submitting = $state(false); let feedback = $state("");
  const current = $derived(questions.find(q => q.id === currentId) ?? questions[0]);
  const index = $derived(questions.findIndex(q => q.id === current?.id));
  const sent = $derived(questions.filter(q => q.state === "answered").length);
  const allSent = $derived(sent === questions.length);
  const draft = $derived(drafts[current?.id] ?? { selected: current?.options[0]?.label ?? "", text: "" });
  const delivery = $derived(deliveries.find(d => d.id === `answer:${current?.id}`));
  function setDraft(value: Draft) { drafts[current.id] = value; localStorage.setItem(storageKey, JSON.stringify(drafts)); }
  function select(id: string) { currentId = id; overview = false; feedback = ""; localStorage.setItem(`${storageKey}/current`, id); }
  function move(offset: number) { const q = questions[index + offset]; if (q) select(q.id); }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || editable(event.target) || overview) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowLeft" ? -1 : 1); }
  }
  async function submit() {
    const value = draft.text.trim() || draft.selected;
    if (!value || submitting || !connected) return;
    submitting = true;
    try {
      if (await onanswer(current.id, value)) {
        feedback = m.answer_sent();
        const next = questions.slice(index + 1).find(q => q.state === "unanswered") ?? questions.find(q => q.id !== current.id && q.state === "unanswered");
        if (next) { currentId = next.id; localStorage.setItem(`${storageKey}/current`, next.id); }
      }
    } finally { submitting = false; }
  }
</script>

{#if allSent}
  <details class="answered-summary"><summary>{m.answers_complete({ count: questions.length })}</summary>
    {#each questions as q}<div class="answered-item"><p>{q.text}</p><span>{q.answer}</span></div>{/each}
  </details>
{:else}
  <section class="question-card">
    <div class="question-top"><span>{m.question_progress({ sent, total: questions.length, pending: questions.length - sent })}</span><Button variant="ghost" size="sm" onclick={() => overview = !overview}>{overview ? m.back_to_question() : m.all_questions()}</Button></div>
    {#if overview}
      <div class="question-overview">
        {#each questions as q, i}
          <button class:selected={q.id === current.id} onclick={() => select(q.id)}><span class="question-number">{i + 1}</span><span class="truncate">{q.text}</span><span class:sent={q.state === "answered"} class:draft={!!drafts[q.id] && q.state !== "answered"}>{q.state === "answered" ? m.sent() : drafts[q.id] ? m.draft() : m.unanswered()}</span></button>
        {/each}
      </div>
    {:else}
      <div class="question-content">
        <p class="question-position">{m.question_position({ current: index + 1, total: questions.length })}</p>
        <h3>{current.text}</h3>
        {#if current.state === "answered"}<p class="sent-answer">{current.answer}</p>
        {:else}
          <fieldset class="question-options" aria-label={current.text}>
            {#each current.options as option}
              <label class:chosen={draft.selected === option.label && !draft.text.trim()}><input type="radio" class="answer-radio" name={`answer-${current.id}`} checked={draft.selected === option.label && !draft.text.trim()} onchange={() => setDraft({ selected: option.label, text: "" })} disabled={submitting} /><span>{option.label}</span></label>
            {/each}
          </fieldset>
          <Textarea aria-label={m.your_answer()} placeholder={m.custom_answer()} value={draft.text} oninput={e => setDraft({ ...draft, text: e.currentTarget.value })} disabled={submitting} rows={2}></Textarea>
        {/if}
        {#if delivery?.error}<p class="inline-error" role="alert">{delivery.status === "uncertain" ? m.unknown_delivery() : delivery.error}</p>{/if}
      </div>
      <!-- Focusable navigation group owns contextual arrow handling. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="question-footer" role="group" aria-label={m.question_navigation()} tabindex="0" onkeydown={keydown}>
        <div class="question-arrows"><Button variant="ghost" size="icon-sm" aria-label={m.previous_question()} disabled={index === 0} onclick={() => move(-1)}><ChevronLeft /></Button><Button variant="ghost" size="icon-sm" aria-label={m.next_question()} disabled={index === questions.length - 1} onclick={() => move(1)}><ChevronRight /></Button></div>
        <Button variant="default" size="sm" onclick={submit} disabled={!connected || submitting || current.state === "answered" || delivery?.status === "uncertain" || !(draft.text.trim() || draft.selected)}>{submitting ? m.sending() : current.state === "answered" ? m.answer_sent() : m.send_answer()}</Button>
      </div>
      <div class="question-hint">{m.question_keyboard()}</div>
    {/if}
  </section>
  {#if feedback}<p class="answer-feedback" role="status">{feedback}</p>{/if}
{/if}
