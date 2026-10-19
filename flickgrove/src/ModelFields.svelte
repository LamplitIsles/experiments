<script lang="ts">
  import ChoiceSelect from "./ChoiceSelect.svelte";
  import ModelPicker, {modelKey as key} from "./ModelPicker.svelte";
  import type { Backend, Defaults, Model } from "./contracts";
  import * as m from "./paraglide/messages";
  let { value = $bindable(), models, label, disabled = false, loading = false }: {value: Defaults; models: Model[]; label: string; disabled?: boolean; loading?: boolean} = $props();
  const backend = $derived(value.backend ?? "codex");
  const choices = $derived(models.filter(model => (model.backend ?? "codex") === backend));
  const selected = $derived(choices.find(model => model.id === value.model && model.provider === value.provider));
  function choose(model: Model | undefined, nextBackend = backend) {
    value = {backend: nextBackend, provider: model?.provider, model: model?.id ?? "", effort: model?.defaultEffort ?? ""};
  }
  function changeBackend(next: Backend) {
    const options = models.filter(model => (model.backend ?? "codex") === next);
    choose(options.find(model => model.isDefault) ?? options[0], next);
  }
</script>
<div class="model-fields">
  <label>Backend<ChoiceSelect label={`${label} backend`} value={backend} items={[{value:"codex",label:"Codex"},{value:"pi",label:"Pi"}]} {disabled} onchange={next=>changeBackend(next as Backend)} /></label>
  <label>{m.model()}<ModelPicker label={`${label} model`} value={key(value.provider,value.model)} {choices} fallback={value.model ? `${value.model} (${m.session_unavailable()})` : "No models available"} {disabled} {loading} onchange={next=>choose(choices.find(model=>key(model.provider,model.id)===next))} /></label>
  <label>{m.effort()}<ChoiceSelect label={`${label} reasoning effort`} value={value.effort} items={[...(selected&&!selected.efforts.includes(value.effort)?[value.effort]:[]),...(selected?.efforts??[])].map(effort=>({value:effort,label:effort}))} disabled={disabled||!selected} onchange={effort=>value.effort=effort} /></label>
</div>
{#if loading&&!choices.length}<p role="status">{m.loading()}</p>{:else if !choices.length}<p role="status">{backend === "pi" ? "No Pi models are available. Check this machine’s Pi configuration and credentials, then refresh." : "No Codex models are available. Refresh to try again."}</p>{:else if !selected}<p role="status">{m.session_current_unavailable()}</p>{/if}

<style>
  .model-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
  .model-fields > label:last-child { grid-column: 1 / -1; }
</style>
