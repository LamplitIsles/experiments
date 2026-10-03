import type { GroveClient } from "./chord-client";
import { routeCall } from "./chord-contract";
let client: GroveClient | undefined;
export function setClient(value: GroveClient | undefined) {
  client = value;
}
export const storagePrefix = `flickgrove/${location.origin}`;
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  if (body !== undefined) {
    if (!client) throw new Error("Connection offline. Outcome unknown.");
    const call = routeCall(path, body);
    return client.call<T>(call.member, call.input);
  }
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Could not complete this action");
  return result as T;
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
