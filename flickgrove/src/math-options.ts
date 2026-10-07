import type { KatexOptions } from "katex";

export const mathOptions = {
  trust: false,
  throwOnError: true,
  maxSize: 20,
} satisfies KatexOptions;
