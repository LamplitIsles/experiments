import { expect, test } from "bun:test";
import { messageTime } from "../src/message-time";
test("message times use local calendar/24-hour clock and omit unavailable metadata", () => {
  const now = new Date(2026, 9, 7, 12);
  const today = new Date(2026, 9, 7, 9, 5);
  expect(messageTime(today.getTime(), now)?.label).toBe("09:05");
  const yesterday = new Date(2026, 9, 6, 23, 59);
  const old = new Date(2025, 9, 6, 23, 59);
  expect(messageTime(yesterday.getTime(), now)?.label).toBe(
    new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
    }).format(yesterday) + " 23:59",
  );
  expect(messageTime(old.getTime(), now)?.label).toContain("2025");
  expect(messageTime(today.getTime(), now)?.datetime).toBe(today.toISOString());
  expect(messageTime(today.getTime(), now)?.title).toBe(
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long",
    }).format(today),
  );
  for (const at of [0, -1, NaN, Infinity, 8.64e15 + 1])
    expect(messageTime(at, now)).toBeNull();
});
