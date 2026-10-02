<script lang="ts">
  import type { Host, Snapshot } from "./contracts";
  import { api } from "./api";
  import * as m from "./paraglide/messages";
  let { hosts, sessionCount, onadopt }: { hosts: Host[]; sessionCount: number; onadopt: (s: Snapshot) => void } = $props();
  let editing = $state<string | null>(null); let name = $state(""); let url = $state(""); let credential = $state(""); let busy = $state(false); let error = $state(""); let saved = $state(false);
  function edit(host?: Host) { editing = host?.id ?? ""; name = host?.name ?? ""; url = host?.url ?? ""; credential = ""; error = ""; saved = false; }
  async function save() {
    if (busy) return; busy = true; error = "";
    try { onadopt(await api<Snapshot>("/hosts", { ...(editing ? { id: editing } : {}), name, url, credential })); credential = ""; editing = null; saved = true; }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { busy = false; }
  }
</script>
{#if editing === null}
  <h2>{m.hosts()}</h2><p class="modal-help">{m.host_help()}</p>
  <div class="host-table" class:many-hosts={hosts.length > 2}><div class="host-table-heading"><span>{m.execution_host()}</span><span>{m.connected_host()}</span></div>
    {#each hosts as host}<div class="host-row"><div><strong>{host.name}</strong><p class="host-address">{host.url}</p></div><div class:host-warning={!host.connected}><span>{host.connected ? m.connected_host() : m.disconnected_host()}</span><small>{host.role === "hub" ? m.hub_local() : m.defaults_status({ status: host.defaults })}</small>{#if !host.connected && host.lastSeen}<small>{m.last_seen({ time: new Date(host.lastSeen).toLocaleTimeString() })}</small>{/if}</div>{#if host.role !== "hub"}<button class="btn btn-sm" aria-label={`${m.edit_host()} ${host.name}`} onclick={() => edit(host)}>{m.edit_host()}</button>{/if}</div>{/each}
  </div>
  {#if saved}<p class="stop-confirmed" role="status">{m.host_saved()}</p>{/if}
  <footer class="host-footer"><span>{m.host_count({ count: hosts.length })} · {m.session_count({ count: sessionCount })}</span><button class="btn btn-primary btn-sm" onclick={() => edit()}>{m.add_host()}</button></footer>
{:else}
  <h2>{editing ? m.edit_host() : m.add_host()}</h2><p class="modal-help">{m.host_form_help()}</p>
  <form onsubmit={e => { e.preventDefault(); void save(); }} class="host-form">
    <label>{m.host_name()}<input class="input" bind:value={name} required maxlength="120" autocomplete="off" /></label>
    <label>{m.host_url()}<input class="input" type="url" bind:value={url} required placeholder="http://host:4318" autocomplete="off" /></label>
    <label>{editing ? m.host_token_edit() : m.host_token()}<input class="input" type="password" bind:value={credential} required={!editing} autocomplete="new-password" /></label>
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
    <div class="modal-action"><button type="button" class="btn btn-sm" disabled={busy} onclick={() => { credential = ""; editing = null; }}>{m.cancel()}</button><button class="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? m.checking_host() : m.check_save()}</button></div>
  </form>
{/if}
