<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { reading } from "./api";
  import { navigation, setSurface, back, removeOutlineDrawer } from "./navigation.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import type { UserMessageAnchor } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agent, revision, connected, open = $bindable(false), current, onselect, oncancel, onclose }: {
    agent:string; revision:string; connected:boolean; open?:boolean; current?:string;
    onselect:(operation:string)=>Promise<boolean|undefined>; oncancel:()=>void; onclose:()=>void;
  } = $props();
  const identity=untrack(()=>agent);
  let items=$state<UserMessageAnchor[]>([]), error=$state(""), loading=$state(false), locating=$state<string>(), locationError=$state("");
  let narrow=$state(matchMedia("(max-width: 1100px)").matches);
  let list:HTMLElement|undefined;
  let sheet=$state<HTMLDivElement|null>(null);
  let controller:AbortController|undefined, active=true;
  let fetched="";
  let selection=0, pendingSelection:{operation:string;version:number}|undefined;
  let retryOperation=$state<string>();
  let wasDrawer=false;
  const sheetOpen=$derived(open && narrow && navigation.surfaces.includes("outline"));
  function itemKey(event:KeyboardEvent) {
    if(["Enter"," ","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)) event.stopPropagation();
  }
  async function refresh() {
    if(!connected || loading) return;
    controller?.abort(); controller=new AbortController(); loading=true; error="";
    const requested=revision;
    try { const result=await reading<UserMessageAnchor[]>(`/outline?${new URLSearchParams({agent:identity})}`,identity,controller.signal); if(active) {items=result;fetched=requested;} }
    catch(e) {if(active && (e as Error).name!=="AbortError") error=(e as Error).message;}
    finally {if(active) loading=false;}
  }
  $effect(()=>{if(!connected) fetched="";});
  $effect(()=>{if(open && connected && fetched!==revision && !loading && !error) untrack(()=>void refresh());});
  $effect(()=>{
    const shown=open, mobile=narrow, drawer=navigation.surfaces.includes("outline");
    untrack(()=>{
      if(!mobile) {wasDrawer=false; removeOutlineDrawer(); return;}
      if(wasDrawer && !drawer) {wasDrawer=false;open=false;return;}
      if(shown && !drawer && !navigation.surfaces.length) {wasDrawer=true;setSurface("outline",true);}
    });
  });
  let revealed=false;
  $effect(()=>{
    if(!open) {revealed=false; return;}
    if(list && items.length && !revealed && (current || locationError)) {
      revealed=true;
      const selector=locationError && retryOperation ? `[data-operation="${CSS.escape(retryOperation)}"]` : `[aria-current="location"]`;
      untrack(()=>void tick().then(()=>list?.querySelector<HTMLElement>(selector)?.scrollIntoView({block:"nearest"})));
    }
  });
  async function select(operation:string) {
    const version=++selection; oncancel(); retryOperation=operation; locationError=""; locating=operation;
    if(narrow && sheetOpen) {pendingSelection={operation,version}; await back(); return;}
    await locate(operation,version);
  }
  async function locate(operation:string, version=selection) {
    if(!active || version!==selection) return;
    try { await onselect(operation); }
    catch(e) {if(active && version===selection && (e as Error).name!=="AbortError") {locationError=(e as Error).message;if(narrow && !navigation.surfaces.length) open=true;}}
    finally {if(active && version===selection) locating=undefined;}
  }
  function revealInSheet() {
    const failed=locationError && retryOperation ? list?.querySelector<HTMLButtonElement>(`[data-operation="${CSS.escape(retryOperation)}"]`) : undefined;
    const current=failed ?? list?.querySelector<HTMLButtonElement>(`[aria-current="location"]`);
    const target=current ?? sheet?.querySelector<HTMLButtonElement>("button");
    target?.focus({preventScroll:true});
    (failed?.parentElement ?? current)?.scrollIntoView({block:"nearest"});
  }
  function closed(value:boolean) {
    if(value) { void tick().then(revealInSheet); return; }
    if(!pendingSelection) return;
    const pending=pendingSelection;pendingSelection=undefined;
    // Bits reports completion after the Sheet has actually left the layout.
    void tick().then(()=>{if(active) void locate(pending.operation,pending.version);});
  }
  onMount(()=>{
    const media=matchMedia("(max-width: 1100px)");
    const resize=()=>narrow=media.matches;
    const escape=(e:KeyboardEvent)=>{
      if(e.key!=="Escape" || e.isComposing || !open || narrow || navigation.surfaces.length) return;
      e.preventDefault();e.stopImmediatePropagation();open=false;onclose();
    };
    media.addEventListener("change",resize);window.addEventListener("keydown",escape,true);
    return ()=>{active=false;selection++;controller?.abort();oncancel();media.removeEventListener("change",resize);window.removeEventListener("keydown",escape,true);removeOutlineDrawer();};
  });
</script>
{#snippet contents()}
  <nav class="message-outline" aria-label={m.message_outline()} bind:this={list}>
    {#if error}<div class="outline-feedback"><p class="inline-error" role="alert">{error}</p><Button variant="ghost" size="sm" disabled={!connected || loading} onkeydown={itemKey} onclick={refresh}>{m.retry()}</Button></div>{/if}
    {#if !items.length}<p class="outline-feedback" role="status">{loading ? m.loading() : !connected ? m.outline_offline() : !error ? m.outline_empty() : ""}</p>{/if}
    {#each items as item (item.operation)}
      <div>
        <button onkeydown={itemKey} class="outline-item" data-operation={item.operation} aria-current={current===item.operation ? "location" : undefined} aria-busy={locating===item.operation} onclick={()=>select(item.operation)}><span>{item.summary.trim() || m.outline_images()}</span></button>
        {#if locating===item.operation}<p class="outline-feedback" role="status">{m.outline_loading()}</p>{/if}
        {#if locationError && retryOperation===item.operation}<div class="outline-feedback"><p class="inline-error" role="alert">{locationError}</p><Button variant="ghost" size="sm" onkeydown={itemKey} onclick={()=>select(item.operation)}>{m.retry()}</Button></div>{/if}
      </div>
    {/each}
  </nav>
{/snippet}
{#if narrow}
  <Sheet.Root open={sheetOpen} onOpenChange={value=>{if(!value && sheetOpen) void back();}} onOpenChangeComplete={closed}>
    <Sheet.Content bind:ref={sheet} side="right" class="message-outline-sheet" onOpenAutoFocus={e=>{e.preventDefault();void tick().then(revealInSheet);}} onEscapeKeydown={e=>{e.preventDefault();e.stopPropagation();void back();}} onCloseAutoFocus={e=>{e.preventDefault();onclose();}}>
      <Sheet.Title class="sr-only">{m.message_outline()}</Sheet.Title>
      <Sheet.Description class="sr-only">{m.message_outline()}</Sheet.Description>
      {@render contents()}
    </Sheet.Content>
  </Sheet.Root>
{:else if open}<aside class="outline-rail">{@render contents()}</aside>{/if}
<style>
  .outline-rail { width:280px; flex:none; min-height:0; border-left:1px solid var(--border); padding:12px 8px; display:flex; }
  .message-outline { overflow-y:auto; overflow-x:hidden; min-height:0; width:100%; font-size:13px; line-height:1.45; }
  .outline-item { width:100%; text-align:left; padding:8px 12px; border-left:2px solid transparent; color:var(--muted-foreground); border-radius:0 4px 4px 0; }
  .outline-item:hover { background:var(--accent);color:var(--accent-foreground); }
  .outline-item[aria-current] { border-color:var(--primary);color:var(--foreground);background:var(--accent); }
  .outline-item span { display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-line; }
  .outline-feedback { margin:6px 12px; font-size:12px; color:var(--muted-foreground); overflow-wrap:anywhere; }
  :global(.message-outline-sheet) { padding:52px 8px 12px; width:min(320px,85vw)!important;gap:0; }
</style>
