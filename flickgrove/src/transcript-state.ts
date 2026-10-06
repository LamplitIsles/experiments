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
export function saveTranscriptPosition(
  id: string,
  position: TranscriptPosition,
) {
  transcriptPositions.delete(id);
  transcriptPositions.set(id, position);
  if (transcriptPositions.size > 12)
    transcriptPositions.delete(transcriptPositions.keys().next().value!);
}
