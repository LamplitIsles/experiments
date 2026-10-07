// Message.at is Unix milliseconds; zero denotes missing native metadata.
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
});
const yearDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const full = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
});
export function messageTime(at: number, now = new Date()) {
  if (!Number.isFinite(at) || at <= 0 || at > 8.64e15) return null;
  const date = new Date(at);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const day = date.getFullYear() === now.getFullYear() ? shortDate : yearDate;
  return {
    label: (sameDay ? "" : day.format(date) + " ") + clock.format(date),
    title: full.format(date),
    datetime: date.toISOString(),
  };
}
