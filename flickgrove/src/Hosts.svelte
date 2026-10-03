<script lang="ts">
  import { Title } from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
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
  <Title>{m.hosts()}</Title><p class="modal-help">{m.host_help()}</p>
  <div class="host-table" class:many-hosts={hosts.length > 2}><div class="host-table-heading"><span>{m.execution_host()}</span><span>{m.connected_host()}</span></div>
    {#each hosts as host}<div class="host-row"><div><strong>{host.name}</strong><p class="host-address">{host.url}</p></div><div class:host-warning={!host.connected}><span>{host.connected ? m.connected_host() : m.disconnected_host()}</span><small>{host.role === "hub" ? m.hub_local() : m.defaults_status({ status: host.defaults })}</small>{#if !host.connected && host.lastSeen}<small>{m.last_seen({ time: new Date(host.lastSeen).toLocaleTimeString() })}</small>{/if}</div>{#if host.role !== "hub"}<Button variant="ghost" size="sm" aria-label={`${m.edit_host()} ${host.name}`} onclick={() => edit(host)}>{m.edit_host()}</Button>{/if}</div>{/each}
  </div>
  {#if saved}<p class="stop-confirmed" role="status">{m.host_saved()}</p>{/if}
  <footer class="host-footer"><span>{m.host_count({ count: hosts.length })} · {m.session_count({ count: sessionCount })}</span><Button variant="default" size="sm" onclick={() => edit()}>{m.add_host()}</Button></footer>
{:else}
  <Title>{editing ? m.edit_host() : m.add_host()}</Title><p class="modal-help">{m.host_form_help()}</p>
  <form onsubmit={e => { e.preventDefault(); void save(); }} class="host-form">
    <label>{m.host_name()}<Input bind:value={name} required maxlength={120} autocomplete="off" /></label>
    <label>{m.host_url()}<Input type="url" bind:value={url} required placeholder="http://host:4318" autocomplete="off" /></label>
    <label>{editing ? m.host_token_edit() : m.host_token()}<Input type="password" bind:value={credential} required={!editing} autocomplete="new-password" /></label>
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
    <div class="modal-action"><Button type="button" variant="ghost" size="sm" disabled={busy} onclick={() => { credential = ""; editing = null; }}>{m.cancel()}</Button><Button variant="default" size="sm" type="submit" disabled={busy}>{busy ? m.checking_host() : m.check_save()}</Button></div>
  </form>
{/if}
