import { api, storagePrefix, readingCache } from "./api";
import type { WeeklyUsage } from "./contracts";
export const weeklyCache = $state<Record<string, WeeklyUsage | null>>({});
const requests = new Map<string, Promise<WeeklyUsage>>();
export function weeklyKey(hostId?: string) {
  return hostId ?? "entry";
}
export function loadWeekly(hostId?: string) {
  const key = weeklyKey(hostId);
  if (key in weeklyCache) return;
  const stored = localStorage.getItem(`${storagePrefix}/weekly/${key}`);
  let value: WeeklyUsage | null = null;
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as WeeklyUsage;
      if (validWeekly(parsed, hostId)) value = parsed;
    } catch {
      /* An unreadable cache has no usable quota. */
    }
  }
  weeklyCache[key] = value;
}
function validWeekly(value: WeeklyUsage, hostId?: string) {
  return (
    value.hostId === hostId &&
    typeof value.remaining === "number" &&
    Number.isFinite(value.remaining) &&
    Number.isFinite(value.fetchedAt)
  );
}
export function acceptWeekly(hostId: string | undefined, value?: WeeklyUsage) {
  const key = weeklyKey(hostId);
  if (value && validWeekly(value, hostId)) {
    weeklyCache[key] = value;
    readingCache.writeDevice(
      `${storagePrefix}/weekly/${key}`,
      JSON.stringify(value),
    );
  } else {
    loadWeekly(hostId);
  }
}
export function requestWeekly(hostId?: string): Promise<WeeklyUsage> {
  const key = weeklyKey(hostId);
  const existing = requests.get(key);
  if (existing) return existing;
  const request = api<WeeklyUsage>("/weekly");
  requests.set(key, request);
  void request
    .finally(() => {
      requests.delete(key);
    })
    .catch(() => {});
  return request;
}
