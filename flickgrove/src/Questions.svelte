<script lang="ts">
  import { submissionResult } from "./outgoing.svelte";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { storagePrefix } from "./api";
  import { tick, untrack } from "svelte";
  import type { Answer, Delivery, Question } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agentId, questions, deliveries, connected, onanswer, onretry }: { agentId: string; questions: Question[]; deliveries: Delivery[]; connected: boolean; onanswer: (answers: Answer[], operationId: string) => Promise<void>; onretry: (id: string) => Promise<void>; } = $props();
  const storageKey = untrack(() => `${storagePrefix}/questions/${agentId}`);
  type Draft = { selected: string; text: string; edited?: boolean };
  let drafts = $state<Record<string, Draft>>(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  let currentId = $state(untrack(() => localStorage.getItem(`${storageKey}/current`) ?? questions.find(q => q.state === "unanswered")?.id));
  let submitting=$state(false); let composing=false; let feedback=$state("");
  let panel: HTMLElement;
  const batches = $derived(deliveries.filter(d => d.source === "question" && submissionResult(d) !== "accepted"));
  const blocked = $derived(new Set(batches.flatMap(d => d.questionIds)));
  const pending = $derived(questions.filter(q => q.state === "unanswered" && !blocked.has(q.id)));
  const sent = $derived(questions.filter(q => q.state === "answered"));
  function draft(q: Question): Draft { return drafts[q.id] ?? { selected: q.options[0]?.label ?? "", text: "" }; }
  function value(q: Question) { const d = draft(q); return d.text.trim() || d.selected; }
  $effect(() => {
    const saved = localStorage.getItem(`${storageKey}/current`);
    if (saved && questions.some(q => q.id === saved)) currentId = saved;
  });
  const current = $derived(pending.find(q=>q.id===currentId) ?? pending[0]);
  const index = $derived(pending.findIndex(q=>q.id===current?.id));
  let renderedId:string|undefined;
  $effect(()=>{const id=current?.id;if(id!==renderedId){renderedId=id;void tick().then(()=>{const scroll=panel?.querySelector('.question-scroll');if(scroll)scroll.scrollTop=0;});}});
  function move(offset:number) { const next=pending[index+offset];if(next)select(next.id); }
  function keydown(e:KeyboardEvent) {
    if(composing || e.isComposing || e.keyCode===229 || e.altKey || e.ctrlKey || e.metaKey)return;
    if(e.key==='Enter' && e.target instanceof HTMLElement && e.target.closest('button,a'))return;
    if(e.key==='Enter' && !e.shiftKey) { e.preventDefault();e.stopPropagation();void submit();return; }
    const editing=e.target instanceof HTMLElement && e.target.closest('textarea,input:not([type=radio]),select,[contenteditable=true]');
    if(!editing && (e.key==='ArrowLeft' || e.key==='ArrowRight')) {e.preventDefault();e.stopPropagation();move(e.key==='ArrowLeft' ? -1 : 1);}
  }
  function select(id: string) { currentId = id; localStorage.setItem(`${storageKey}/current`, id); }
  function setDraft(q: Question, d: Draft) { select(q.id); drafts[q.id] = d; localStorage.setItem(storageKey, JSON.stringify(drafts)); }
  async function submit() {
    if (!connected || submitting || !pending.length || composing) return;
    const missing=pending.find(q=>!value(q));
    if(missing){ select(missing.id);feedback="Answer this question before sending the batch.";await tick();panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus();return; }
    const frozen=pending.map(q=>({questionId:q.id,answer:value(q)}));
    submitting=true;feedback="";
    try{await onanswer(frozen,crypto.randomUUID());}finally{submitting=false;}
  }
</script>
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="questions-content" role="group" aria-label={"Question navigation"} tabindex="0" bind:this={panel} onkeydown={keydown} oncompositionstart={()=>composing=true} oncompositionend={()=>composing=false}>
  <div class="question-scroll">
  {#each batches as batch (batch.id)}
    <section class="answer-batch" aria-label={m.answer_batch()} data-operation-id={batch.id}>
      <p class="batch-status" role="status">{submissionResult(batch) === "pending" ? m.sending() : batch.error ?? m.load_failure()}</p>
      {#each batch.answers ?? [] as answer}<div class="answered-item"><p>{questions.find(q => q.id === answer.questionId)?.text}</p><span>{answer.answer}</span></div>{/each}
      {#if submissionResult(batch) === "rejected"}<Button variant="secondary" size="sm" disabled={!connected} onclick={() => onretry(batch.id)}>{m.retry()}</Button>{/if}
    </section>
  {/each}
  {#if current}
    {@const q=current}
    {@const d = draft(q)}
    <section class="question-card" class:current-question={q.id === current.id} data-question-id={q.id}>
      <div class="question-content">
        <p class="question-position">{m.question_position({ current: index + 1, total: pending.length })}</p>
        <h3>{q.text}</h3>
        <fieldset class="question-options" aria-label={q.text}>
          {#each q.options as option}<label class:chosen={d.selected === option.label && !d.text.trim()}><input type="radio" class="answer-radio" name={`answer-${q.id}`} checked={d.selected === option.label && !d.text.trim()} onchange={() => setDraft(q, { selected: option.label, text: "", edited: true })} /><span>{option.label}{#if option.description}<small>{option.description}</small>{/if}</span></label>{/each}
        </fieldset>
        <Textarea aria-label={`${m.your_answer()} · ${q.text}`} placeholder={m.custom_answer()} value={d.text} onfocus={() => select(q.id)} oninput={e => setDraft(q, { ...d, text: e.currentTarget.value })} rows={5} />
      </div>
    </section>
  {/if}
  {#if feedback}<p role="status">{feedback}</p>{/if}
  {#if sent.length}<section class="answered-summary" aria-label="Answered questions">{#each sent as q}<div class="answered-item"><p>{q.text}</p><span class="sent-answer">{q.answer}</span></div>{/each}</section>{/if}
  {#if !questions.length}<p class="list-empty">{m.questions_empty()}</p>{/if}
  </div>
  {#if pending.length}<div class="question-footer"><div class="question-arrows"><Button variant="ghost" size="icon-sm" aria-label={"Previous question"} disabled={index<=0} onclick={()=>move(-1)}><ChevronLeft /></Button><span>{m.question_position({current:index+1,total:pending.length})}</span><Button variant="ghost" size="icon-sm" aria-label={"Next question"} disabled={index>=pending.length-1} onclick={()=>move(1)}><ChevronRight /></Button></div><Button size="sm" disabled={!connected || submitting} onclick={submit}>{m.send_all_answers()}</Button></div><p class="question-hint">← → Change question · Enter Send all · Shift+Enter New line</p>{/if}
</div>
