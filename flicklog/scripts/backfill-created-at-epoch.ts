#!/usr/bin/env bun
import { meiliConnection, unixSeconds, type Env } from "../src/core";

const PAGE_SIZE = 1000;
const index = "flicklog_messages";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type BackfillStats = {
  scanned: number;
  updated: number;
  skipped: number;
};

export async function run(
  env: Env = process.env,
  stdout: Pick<Console, "log"> = console,
  pageSize = PAGE_SIZE,
): Promise<BackfillStats> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new Error("backfill page size must be a positive integer");
  const client = meiliConnection(env);
  const stats: BackfillStats = { scanned: 0, updated: 0, skipped: 0 };
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      fields: "id,createdAt,createdAtEpoch",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await client.request(
      `/indexes/${index}/documents?${query}`,
    );
    const page = (await response.json()) as {
      results?: unknown;
      total?: unknown;
    };
    if (
      !object(page) ||
      !Array.isArray(page.results) ||
      typeof page.total !== "number" ||
      !Number.isSafeInteger(page.total) ||
      page.total < offset
    )
      throw new Error("invalid Meilisearch documents response");
    const updates: Array<{ id: string; createdAtEpoch: number }> = [];
    for (const document of page.results) {
      stats.scanned++;
      if (!object(document) || !string(document.id)) {
        stats.skipped++;
        continue;
      }
      const createdAtEpoch = unixSeconds(document.createdAt);
      if (
        createdAtEpoch === undefined ||
        document.createdAtEpoch === createdAtEpoch
      ) {
        stats.skipped++;
        continue;
      }
      updates.push({ id: document.id, createdAtEpoch });
    }
    if (updates.length) {
      const update = await client.request(
        `/indexes/${index}/documents?primaryKey=id`,
        {
          method: "PUT",
          body: JSON.stringify(updates),
        },
      );
      const task = (await update.json()) as { taskUid?: unknown };
      if (
        typeof task.taskUid !== "number" ||
        !Number.isSafeInteger(task.taskUid)
      )
        throw new Error("invalid Meilisearch update task");
      await client.waitForTask(task.taskUid);
      stats.updated += updates.length;
    }
    offset += page.results.length;
    if (!page.results.length || offset >= page.total) break;
  }
  stdout.log(JSON.stringify(stats));
  return stats;
}

if (import.meta.main)
  run().catch((error) => {
    console.error(
      `flicklog backfill: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
