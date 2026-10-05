// Reading position is device-local and does not persist preview capabilities.
export const transcriptPositions = new Map<
  string,
  { scroll: number; follow: boolean }
>();
