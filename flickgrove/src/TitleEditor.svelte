<script lang="ts">
  import { tick } from "svelte";
  import { Check, Pencil, X } from "@lucide/svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as m from "./paraglide/messages";
  let { title, editable, onrename }: { title: string; editable: boolean; onrename: (title: string) => Promise<string | undefined> } = $props();
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let error = $state("");
  let input = $state<HTMLInputElement | null>(null);
  async function edit() {
    draft = title; error = ""; editing = true;
    await tick(); input?.focus(); input?.select();
  }
  async function save() {
    if (saving || !editable || !draft.trim()) return;
    saving = true;
    try { error = await onrename(draft.trim()) ?? ""; if (!error) editing = false; }
    finally { saving = false; }
  }
</script>

{#if editing}
  <div class="title-edit"><form class="title-editor" onsubmit={event => { event.preventDefault(); void save(); }}>
    <Input bind:ref={input} bind:value={draft} aria-label={m.session_title()} maxlength={120} readonly={saving || !editable} onkeydown={event => {
      if (event.key === "Enter" && event.isComposing) event.preventDefault();
    }} />
    <Button type="submit" variant="ghost" size="icon-sm" aria-label={m.save_title()} disabled={!editable || !draft.trim()} aria-disabled={saving}><Check /></Button>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={m.cancel()} data-title-cancel disabled={saving} onclick={() => editing = false}><X /></Button>
  </form>{#if error}<p class="title-error" role="alert">{error}</p>{/if}</div>
{:else}
  <h1 aria-label={title}>{#if editable}<button class="editable-title" tabindex="-1" aria-label={m.edit_title()} onclick={edit}><span>{title}</span><Pencil aria-hidden="true" /></button>{:else}{title}{/if}</h1>
{/if}
