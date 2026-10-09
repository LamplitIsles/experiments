import type { VirtualItem } from "@tanstack/svelte-virtual";

export type TranscriptPosition = {
  scroll: number;
  follow: boolean;
  anchor?: { id: string; offset: number };
  measurements: VirtualItem[];
  headerHeight: number;
  width: number;
  height: number;
  reports: Set<string>;
};
// Device-local, bounded route state; no message copies or preview capabilities.
export const transcriptPositions = new Map<string, TranscriptPosition>();
const activeByHost = new Map<string, Set<string>>();
// Called only for a connected Peer's authoritative snapshot. Keep this guard
// through disconnection so a later timeline teardown cannot revive a closure.
export function retainTranscriptPositions(host: string, active: Set<string>) {
  activeByHost.set(host, new Set(active));
  for (const id of transcriptPositions.keys())
    if (id.startsWith(host + ":") && !active.has(id))
      transcriptPositions.delete(id);
}
export function saveTranscriptPosition(
  id: string,
  position: TranscriptPosition,
) {
  const active = activeByHost.get(id.split(":")[0]);
  if (active && !active.has(id)) return;
  transcriptPositions.delete(id);
  transcriptPositions.set(id, position);
  if (transcriptPositions.size > 12)
    transcriptPositions.delete(transcriptPositions.keys().next().value!);
}
