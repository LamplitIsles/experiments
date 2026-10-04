<script lang="ts">
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { storagePrefix } from "./api";
  import { tick, untrack } from "svelte";
  import type { Answer, Delivery, Question } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agentId, questions, deliveries, connected, onanswer, onlookup, onretry, ondismiss }: { agentId: string; questions: Question[]; deliveries: Delivery[]; connected: boolean; onanswer: (answers: Answer[], operationId: string) => Promise<void>; onlookup: (id: string) => Promise<void>; onretry: (id: string) => Promise<void>; ondismiss:(id:string)=>void } = $props();
  const storageKey = untrack(() => `${storagePrefix}/questions/${agentId}`);
  type Draft = { selected: string; text: string; edited?: boolean };
  let drafts = $state<Record<string, Draft>>(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  let currentId = $state(untrack(() => localStorage.getItem(`${storageKey}/current`) ?? questions.find(q => q.state === "unanswered")?.id));
  let historyOpen = $state(untrack(() => localStorage.getItem(`${storageKey}/history`) === "true"));
  let panel: HTMLElement;
  const batches = $derived(deliveries.filter(d => d.source === "question" && d.status !== "sent"));
  const blocked = $derived(new Set(batches.flatMap(d => d.questionIds)));
  const pending = $derived(questions.filter(q => q.state === "unanswered" && !blocked.has(q.id)));
  const sent = $derived(questions.filter(q => q.state === "answered"));
  function draft(q: Question): Draft { return drafts[q.id] ?? { selected: q.options[0]?.label ?? "", text: "" }; }
  function value(q: Question) { const d = draft(q); return d.text.trim() || d.selected; }
  $effect(() => {
    const saved = localStorage.getItem(`${storageKey}/current`);
    if (saved && questions.some(q => q.id === saved)) currentId = saved;
  });
  $effect(() => {
    const id = currentId;
    if (id) void tick().then(() => panel?.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  });
  function select(id: string) { currentId = id; localStorage.setItem(`${storageKey}/current`, id); }
  function setDraft(q: Question, d: Draft) { select(q.id); drafts[q.id] = d; localStorage.setItem(storageKey, JSON.stringify(drafts)); }
  function submit() {
    if (!connected || !pending.length || pending.some(q => !value(q))) return;
    const frozen = pending.map(q => ({ questionId: q.id, answer: value(q) }));
    void onanswer(frozen, crypto.randomUUID());
  }
</script>
<div class="questions-content" bind:this={panel}>
  {#each batches as batch (batch.id)}
    <section class="answer-batch" aria-label={m.answer_batch()} data-operation-id={batch.id}>
      <p class="batch-status" role="status">{batch.status === "sending" || batch.status === "queued" ? m.sending() : batch.status === "uncertain" ? (batch.receiptState === "missing" ? m.delivery_missing() : batch.receiptState === "pending" ? m.delivery_pending() : m.unknown_delivery()) : batch.error ?? m.load_failure()}</p>
      {#each batch.answers ?? [] as answer}<div class="answered-item"><p>{questions.find(q => q.id === answer.questionId)?.text}</p><span>{answer.answer}</span></div>{/each}
      {#if batch.status === "uncertain"}<p class="question-hint">{m.lookup_help()}</p><Button variant="ghost" size="sm" disabled={!connected} onclick={() => onlookup(batch.id)}>{m.check_delivery()}</Button><Button variant="ghost" size="sm" onclick={()=>ondismiss(batch.id)}>{m.dismiss_delivery()}</Button>
      {:else if batch.status === "failed"}<Button variant="secondary" size="sm" disabled={!connected} onclick={() => onretry(batch.id)}>{m.retry()}</Button>{/if}
    </section>
  {/each}
  {#each pending as q, index (q.id)}
    {@const d = draft(q)}
    <section class="question-card" class:current-question={q.id === currentId} data-question-id={q.id}>
      <div class="question-content">
        <p class="question-position">{m.question_position({ current: index + 1, total: pending.length })}</p>
        <h3>{q.text}</h3>
        <fieldset class="question-options" aria-label={q.text}>
          {#each q.options as option}<label class:chosen={d.selected === option.label && !d.text.trim()}><input type="radio" class="answer-radio" name={`answer-${q.id}`} checked={d.selected === option.label && !d.text.trim()} onchange={() => setDraft(q, { selected: option.label, text: "", edited: true })} /><span>{option.label}</span></label>{/each}
        </fieldset>
        <Textarea aria-label={`${m.your_answer()} · ${q.text}`} placeholder={m.custom_answer()} value={d.text} onfocus={() => select(q.id)} oninput={e => setDraft(q, { ...d, text: e.currentTarget.value })} rows={2} />
      </div>
    </section>
  {/each}
  {#if pending.length}<div class="batch-submit"><Button size="sm" disabled={!connected || pending.some(q => !value(q))} onclick={submit}>{m.send_all_answers()}</Button></div>{/if}
  {#if sent.length}<details class="answered-summary" open={historyOpen} ontoggle={e => { historyOpen = e.currentTarget.open; localStorage.setItem(`${storageKey}/history`, String(historyOpen)); }}><summary>{m.answers_complete({ count: sent.length })}</summary>{#each sent as q}<div class="answered-item"><p>{q.text}</p><span class="sent-answer">{q.answer}</span></div>{/each}</details>{/if}
  {#if !questions.length}<p class="list-empty">{m.questions_empty()}</p>{/if}
</div>
