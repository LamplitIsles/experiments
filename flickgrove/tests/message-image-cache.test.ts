import { expect, test } from "bun:test";
import {
  messageImagePreview,
  retryMessageImagePreview,
} from "../src/message-image-cache";

test("preview requests survive recycling, explicitly retry failures and evict past 32 entries", async () => {
  const key = crypto.randomUUID();
  let reads = 0;
  const load = async () => {
    reads++;
    return new Blob(["anonymous preview"]);
  };
  const first = await messageImagePreview(key, load);
  expect(await messageImagePreview(key, load)).toBe(first);
  expect(reads).toBe(1);
  const failed = key + "/failed";
  await expect(
    messageImagePreview(failed, async () => {
      throw new Error("synthetic outage");
    }),
  ).rejects.toThrow("synthetic outage");
  await expect(messageImagePreview(failed, load)).rejects.toThrow(
    "synthetic outage",
  );
  retryMessageImagePreview(failed);
  expect(await messageImagePreview(failed, load)).toBeInstanceOf(Blob);
  for (let i = 0; i < 32; i++) await messageImagePreview(key + "/" + i, load);
  expect(await messageImagePreview(key, load)).not.toBe(first);
  expect(reads).toBe(35);
});
