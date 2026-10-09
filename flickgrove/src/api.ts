import { ReadingCache } from "./reading-cache";
import type { Peers } from "./peers";
import { routeCall } from "./chord-contract";
let client: Peers | undefined;
export function setClient(value: Peers | undefined) {
  client = value;
}
export function peers() {
  if (!client) throw new Error("Connection offline");
  return client;
}
export const storagePrefix = `flickgrove/${location.origin}`;
export const readingCache = new ReadingCache(localStorage, storagePrefix);
export async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!client) throw new Error("Connection offline. Outcome unknown.");
  if (path === "/snapshot") return client.snapshot() as T;
  const call = routeCall(path, body);
  return client.call<T>(call.member, call.input);
}
export function editable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      "input, textarea, select, [contenteditable=true], [role=radio], [role=listbox]",
    )
  );
}
export function elapsed(since: number | undefined, now: number) {
  const seconds = Math.max(0, Math.floor((now - (since ?? now)) / 1000));
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
