import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions } from "./discovery";

test("bounded discovery merges index title/activity and filters exact cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "zencodex-discovery-"));
  try {
    const sessions = join(home, "sessions", "2026");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: "one", thread_name: "Indexed title", updated_at: 1_700_000_000 })}\n`,
    );
    await writeFile(
      join(sessions, "one.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "one", session_id: "one", source: "cli", thread_source: "user", cwd: "/work/project", timestamp: "2020-01-01T00:00:00Z" } })}\nbody`,
    );
    await writeFile(
      join(sessions, "other.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: "/work/other", timestamp: 1_700_000_000_000 } })}\n`,
    );
    await writeFile(join(sessions, "bad.jsonl"), "{".repeat(70_000));
    const found = await discoverSessions("/work/project", home);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "one",
      name: "Indexed title",
      activityMs: 1_700_000_000_000,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
