<script lang="ts">
  import { submissionResult } from "./outgoing.svelte";
  import { ChevronLeft, ChevronRight, Check } from "@lucide/svelte";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { storagePrefix, readingCache } from "./api";
  import { tick, untrack } from "svelte";
  import type { Answer, Delivery, Question } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agentId, questions, deliveries = [], connected = false, recovering = false, readonly = false, selectedItem, onanswer, onretry }: { agentId: string; questions: Question[]; deliveries?: Delivery[]; connected?: boolean; recovering?: boolean; readonly?: boolean; selectedItem?: string; onanswer?: (answers: Answer[], operationId: string, text?: string) => Promise<void>; onretry?: (id: string) => Promise<void>; } = $props();
  const storageKey = untrack(() => `${storagePrefix}/questions/${agentId}`);
  type Draft = { selected: string; text: string };
  let drafts = $state<Record<string, Draft>>(untrack(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; }
  }));
  let currentId = $state<string | undefined>(untrack(() => readonly ? undefined : localStorage.getItem(`${storageKey}/current`) ?? undefined));
  let submitting = $state(false), composing = false, feedback = $state("");
  let panel: HTMLDivElement;
  const pending = $derived(questions.filter(q => readonly || q.state !== "answered"));
  const anchor = $derived(pending.find(q => q.id === currentId) ?? pending.find(q => q.itemId === selectedItem) ?? pending[0]);
  const batch = $derived(readonly ? pending : pending.filter(q => q.itemId === anchor?.itemId).sort((a,b) => a.index-b.index));
  const current = $derived(batch.find(q => q.id === currentId) ?? batch[0]);
  const index = $derived(batch.findIndex(q => q.id === current?.id));
  const operation = $derived(batch.find(q => q.answerOperation)?.answerOperation);
  const operations = $derived(deliveries.filter(d => d.source === "question" && submissionResult(d) !== "accepted" && d.questionIds.some(id => batch.some(q => q.id === id))));
  const frozen = $derived<Delivery | undefined>(readonly ? undefined : operations.find(d => submissionResult(d) === "pending") ?? operations.at(-1) ?? (operation ? {...operation,source:"question" as const,questionIds:batch.map(q => q.id),text:"",at:0} : undefined));
  const locked = $derived(readonly || submitting || !!frozen);
  function draft(q: Question): Draft {
    const saved = drafts[q.id];
    if (saved && typeof saved.selected === "string" && typeof saved.text === "string") return saved;
    const first = q.options[0]?.label ?? "";
    return { selected: /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i.test(first) ? first : "", text: "" };
  }
  function value(q: Question) { const d = draft(q); return d.text.trim() || d.selected; }
  let renderedId: string | undefined;
  $effect(() => {
    const id = current?.id;
    if (id !== renderedId) { renderedId = id; void tick().then(() => { const scroll = panel?.querySelector('.question-scroll'); if (scroll) scroll.scrollTop = 0; }); }
  });
  let requested: string | undefined;
  $effect(() => {
    const item = selectedItem;
    if (item && item !== requested) { requested = item; currentId = untrack(() => questions.find(q => q.itemId === item)?.id); }
  });
  function select(id: string) { currentId = id; if (!readonly) readingCache.writeDevice(`${storageKey}/current`, id); }
  function move(offset: number) { const next = batch[index+offset]; if (next) { feedback = ""; select(next.id); } }
  function setDraft(q: Question, d: Draft) { if (locked) return; feedback = ""; select(q.id); drafts[q.id] = d; readingCache.writeDevice(storageKey, JSON.stringify(drafts)); }
  async function missing(q: Question) { select(q.id); feedback = "Answer this question before sending the batch."; await tick(); panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }
  async function submit() {
    if (!connected || locked || recovering || !batch.length || composing || !onanswer) return;
    const unfilled = batch.find(q => !value(q));
    if (unfilled) { await missing(unfilled); return; }
    const answers = batch.map(q => ({questionId:q.id,answer:value(q)}));
    const text = batch.map(q => `Question: ${q.text}\nAnswer: ${value(q)}`).join("\n\n");
    submitting = true; feedback = "";
    try { await onanswer(answers, crypto.randomUUID(), text); }
    catch(e) { feedback = (e as Error).message; }
    finally { submitting = false; }
  }
  function optionKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || e.keyCode === 229 || composing) return;
    e.preventDefault(); e.stopPropagation(); void submit();
  }
  function answerKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || e.keyCode === 229 || composing) return;
    e.preventDefault(); e.stopPropagation();
    if (!current || locked) return;
    if (!value(current)) { void missing(current); return; }
    if (index < batch.length-1) { move(1); void tick().then(() => panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus()); }
    else void submit();
  }
</script>
<div class="questions-content" role="group" aria-label="Question navigation" bind:this={panel}>
  <div class="question-scroll">
    {#if frozen}<section class="answer-batch" aria-label={m.answer_batch()} data-operation-id={frozen.id}><p class="batch-status" role="status">{submissionResult(frozen) === "pending" ? m.sending() : frozen.error ?? m.load_failure()}</p>{#each frozen.answers ?? [] as answer}<div class="answered-item"><p>{questions.find(q => q.id === answer.questionId)?.text}</p><span>{answer.answer}</span></div>{/each}{#if submissionResult(frozen) === "rejected"}<Button tabindex={0} variant="secondary" size="sm" disabled={!connected || submitting} onclick={async () => { submitting = true; try { await onretry?.(frozen.id); } finally { submitting = false; } }}>{m.retry()}</Button>{/if}</section>
    {:else if current}
      {@const q = current}
      {@const d = draft(q)}
      <section class="question-card" data-question-id={q.id}>
        <div class="question-content">
          {#if q.title !== "Question"}<p class="question-position">{q.title}</p>{/if}<h3>{q.text}</h3>
          <div class="question-options" role="group" aria-label={q.text}>
            {#each q.options as option, i}
              {#if readonly}<div class="question-option" class:chosen={q.answer === option.label}><span class="option-number">{i+1}</span><span>{option.label}{#if option.description}<small>{option.description}</small>{/if}</span>{#if q.answer === option.label}<Check size={16} />{/if}</div>
              {:else}<button class="question-option" class:chosen={d.selected === option.label && !d.text.trim()} aria-pressed={d.selected === option.label && !d.text.trim()} disabled={locked} onkeydown={optionKey} onclick={() => { setDraft(q, {selected:option.label,text:""}); if (index < batch.length-1) move(1); }}><span class="option-number">{i+1}</span><span>{option.label}{#if option.description}<small>{option.description}</small>{/if}</span>{#if d.selected === option.label && !d.text.trim()}<Check size={16} />{/if}</button>{/if}
            {/each}
          </div>
          {#if readonly}<div class="recorded-answer"><small>Your answer</small><p>{q.answer ?? "Answer unavailable"}</p></div>
          {:else}<Textarea aria-label={`${m.your_answer()} · ${q.text}`} placeholder={m.custom_answer()} value={d.text} disabled={locked} onfocus={() => select(q.id)} oninput={e => setDraft(q, {...d,text:e.currentTarget.value})} onkeydown={answerKey} oncompositionstart={() => composing = true} oncompositionend={() => composing = false} rows={3} />{/if}
        </div>
      </section>
    {/if}
    {#if feedback}<p class="inline-error" role="status">{feedback}</p>{/if}
  </div>
  {#if batch.length}<div class="question-footer"><div class="question-arrows"><Button tabindex={0} variant="ghost" size="icon-sm" aria-label="Previous question" disabled={index<=0 || !!frozen} onclick={() => move(-1)}><ChevronLeft /></Button><span>{m.question_position({current:index+1,total:batch.length})}</span><Button tabindex={0} variant="ghost" size="icon-sm" aria-label="Next question" disabled={index>=batch.length-1 || !!frozen} onclick={() => move(1)}><ChevronRight /></Button></div>{#if !readonly && !frozen}<Button tabindex={0} size="sm" disabled={!connected || locked || recovering} onclick={() => { if (index<batch.length-1) { if (current && !value(current)) void missing(current); else move(1); } else void submit(); }}>{index<batch.length-1 ? "Next" : m.send_all_answers()}</Button>{/if}</div>{/if}
</div>
