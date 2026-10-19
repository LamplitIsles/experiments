<script lang="ts" module>
  export const modelKey = (provider:string|undefined,id:string) => provider ? JSON.stringify([provider,id]) : id;
</script>
<script lang="ts">
  import {choiceLayer} from "./choice-layer.svelte";
  import { tick } from "svelte";
  import { ChevronDown } from "@lucide/svelte";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Model } from "./contracts";
  let { value, choices, label, fallback, disabled=false, loading=false, onchange }: {
    value:string; choices:Model[]; label:string; fallback:string;
    disabled?:boolean; loading?:boolean; onchange:(value:string)=>void;
  }=$props();
  let open=$state(false), query=$state("");
  let trigger=$state<HTMLButtonElement|null>(null);
  const selected=$derived(choices.find(choice=>modelKey(choice.provider,choice.id)===value));
  const listId=$props.id();
  choiceLayer(listId,()=>open,()=>open=false);
  $effect(()=>{if(open)query="";});
  $effect(()=>{if(disabled||!choices.length)open=false;});
  function choose(next:string){
    if(disabled||!choices.some(choice=>modelKey(choice.provider,choice.id)===next))return;
    onchange(next);open=false;
    void tick().then(()=>{if(trigger?.isConnected)trigger.focus({preventScroll:true});});
  }
</script>
<Popover.Root bind:open>
  <Popover.Trigger bind:ref={trigger}>
    {#snippet child({props})}
      <Button {...props} data-choice-trigger tabindex={0} variant="outline" class="w-full min-w-0 justify-between font-normal text-foreground" role="combobox" aria-label={label} aria-expanded={open} aria-controls={open?listId:undefined} aria-haspopup="listbox" aria-busy={loading} disabled={disabled || !choices.length} title={selected?.name ?? fallback} onkeydown={event=>{if(event.key==="ArrowDown"&&!disabled&&choices.length){event.preventDefault();open=true;}}}>
        <span class="min-w-0 truncate">{loading&&!choices.length ? "Loading models…" : selected?.name ?? fallback}</span><ChevronDown class="size-4 shrink-0 text-muted-foreground" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content data-choice-layer class="w-(--bits-popover-anchor-width) min-w-56 max-w-[calc(100vw-2rem)] gap-0 p-0" align="start" onEscapeKeydown={event=>event.stopPropagation()}>
    <Command.Root value={value} label={`Search ${label.toLowerCase()}`}>
      <Command.Input aria-controls={listId} aria-label={`Search ${label.toLowerCase()}`} placeholder="Search models…" bind:value={query} />
      <Command.List id={listId} aria-label={`${label} choices`} style="max-height: min(18rem, calc(var(--bits-popover-content-available-height) - 3rem))">
        <Command.Empty>No models found.</Command.Empty>
        <Command.Group>
          {#each choices as model (modelKey(model.provider,model.id))}
            <Command.Item value={modelKey(model.provider,model.id)} keywords={[model.name,model.provider ?? "",model.id]} data-checked={value===modelKey(model.provider,model.id)} onSelect={()=>choose(modelKey(model.provider,model.id))}>
              <div class="min-w-0 flex-1"><span class="block [overflow-wrap:anywhere]">{model.name}</span><span class="block break-all text-xs text-muted-foreground">{model.provider ? model.provider+"/" : ""}{model.id}</span></div>
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
