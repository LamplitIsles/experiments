/** Shared presentation types retained from the utterlog reader transplant. */
export type NamedSession = {
  id: string;
  name: string;
  cwd: string;
  path: string;
  activityMs: number;
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  phase?: string;
  timestampLabel: string;
  body: string;
  workedMs?: number;
};

export function messageTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "unknown time";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
