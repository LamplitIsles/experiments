<script lang="ts">
  import {choiceLayer} from "./choice-layer.svelte";
  let open=$state(false);
  const id=$props.id();
  choiceLayer(id,()=>open,()=>open=false);
  import * as Select from "$lib/components/ui/select/index.js";
  let { value, items, label, disabled = false, onchange }: {
    value: string; items: {value:string;label:string}[]; label:string;
    disabled?:boolean; onchange:(value:string)=>void;
  } = $props();
  $effect(()=>{if(disabled)open=false;});
</script>
<Select.Root bind:open type="single" {value} {items} {disabled} onValueChange={onchange}>
  <Select.Trigger aria-label={label} class="w-full min-w-0 text-foreground" title={items.find(item=>item.value===value)?.label ?? value}>
    <Select.Value placeholder="Choose…" />
  </Select.Trigger>
  <Select.Content class="min-w-(--bits-select-anchor-width) max-w-[calc(100vw-2rem)] p-1" onEscapeKeydown={event=>event.stopPropagation()}>
    {#each items as item (item.value)}<Select.Item value={item.value} label={item.label} />{/each}
  </Select.Content>
</Select.Root>
