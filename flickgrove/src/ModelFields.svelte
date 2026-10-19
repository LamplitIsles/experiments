<script lang="ts">
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import type { Backend, Defaults, Model } from "./contracts";
  import * as m from "./paraglide/messages";
  let { value = $bindable(), models, label, disabled = false }: {value: Defaults; models: Model[]; label: string; disabled?: boolean} = $props();
  const backend = $derived(value.backend ?? "codex");
  const choices = $derived(models.filter(model => (model.backend ?? "codex") === backend));
  const selected = $derived(choices.find(model => model.id === value.model && model.provider === value.provider));
  const key = (provider: string | undefined, id: string) => provider ? JSON.stringify([provider, id]) : id;
  function choose(model: Model | undefined, nextBackend = backend) {
    value = {backend: nextBackend, provider: model?.provider, model: model?.id ?? "", effort: model?.defaultEffort ?? ""};
  }
  function changeBackend(next: Backend) {
    const options = models.filter(model => (model.backend ?? "codex") === next);
    choose(options.find(model => model.isDefault) ?? options[0], next);
  }
</script>
<div class="model-fields">
    <label>Backend<NativeSelect class="model-select" aria-label={`${label} backend`} value={backend} {disabled} onchange={event => changeBackend(event.currentTarget.value as Backend)}><option value="codex">Codex</option><option value="pi">Pi</option></NativeSelect></label>
  <label>{m.model()}<NativeSelect class="model-select" aria-label={`${label} model`} value={key(value.provider, value.model)} disabled={disabled || !choices.length} onchange={event => choose(choices.find(model => key(model.provider, model.id) === event.currentTarget.value))}>
    {#if !selected}<option value={key(value.provider, value.model)}>{value.model || "No models available"}</option>{/if}
    {#each choices as model}<option value={key(model.provider, model.id)}>{model.name}</option>{/each}
  </NativeSelect></label>
  <label>{m.effort()}<NativeSelect class="model-select" aria-label={`${label} reasoning effort`} bind:value={value.effort} disabled={disabled || !selected}>
    {#if selected && !selected.efforts.includes(value.effort)}<option value={value.effort}>{value.effort}</option>{/if}
    {#each selected?.efforts ?? [] as effort}<option value={effort}>{effort}</option>{/each}
  </NativeSelect></label>
</div>
{#if !choices.length}<p role="status">{backend === "pi" ? "No Pi models are available. Check this machine’s Pi configuration and credentials, then refresh." : "No Codex models are available. Refresh to try again."}</p>{:else if !selected}<p role="status">{m.session_current_unavailable()}</p>{/if}

<style>
  .model-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
  .model-fields > label:last-child { grid-column: 1 / -1; }
</style>
