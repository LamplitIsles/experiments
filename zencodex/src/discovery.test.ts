import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions, latestTokenUsage } from "./discovery";

test("indexed discovery filters cwd, archived and child sessions without rollout reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "zencodex-discovery-"));
  try {
    const sqlite = join(home, "state");
    await mkdir(sqlite);
    await writeFile(join(home, "config.toml"), 'sqlite_home = "state"');
    const db = new Database(join(sqlite, "state_5.sqlite"));
    db.run(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT,
      rollout_path TEXT, updated_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT)`);
    const insert = db.query(
      "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "one",
      "Indexed title",
      "Old title",
      "/work/project",
      "/not-read/one",
      1700000000000,
      0,
      "cli",
      "user",
    );
    insert.run(
      "vscode",
      null,
      "",
      "/work/project",
      "/not-read/two",
      1800000000000,
      0,
      "vscode",
      null,
    );
    insert.run(
      "child",
      null,
      "Child",
      "/work/project",
      "",
      1900000000000,
      0,
      "cli",
      "subagent",
    );
    insert.run(
      "archived",
      null,
      "Archived",
      "/work/project",
      "",
      1900000000000,
      1,
      "cli",
      "user",
    );
    insert.run(
      "other",
      null,
      "Other",
      "/work/project-other",
      "",
      1900000000000,
      0,
      "cli",
      "user",
    );
    db.close();
    const found = await discoverSessions("/work/project", home, undefined, {
      CODEX_SQLITE_HOME: "/must-not-be-used",
    });
    expect(found).toHaveLength(2);
    expect(found.find((session) => session.id === "one")).toMatchObject({
      id: "one",
      name: "Indexed title",
      activityMs: 1_700_000_000_000,
    });
    expect(found.find((session) => session.id === "vscode")).toMatchObject({
      id: "vscode",
      name: "Untitled session",
    });
    expect(found.map((session) => session.id)).toEqual(["vscode", "one"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("selected rollout seeds the pre-notification meter from native last token usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "zencodex-tokens-"));
  const rollout = join(root, "thread.jsonl");
  try {
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 1_000 },
              last_token_usage: { total_tokens: 10 },
              model_context_window: 100,
            },
          },
        }),
        "not json",
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 8_000 },
              last_token_usage: { total_tokens: 40 },
              model_context_window: 400,
            },
          },
        }),
        '{"type":"event_msg",',
      ].join("\n"),
    );
    expect(await latestTokenUsage(rollout)).toEqual({
      totalTokens: 40,
      modelContextWindow: 400,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing state database permits a new session without creating or scanning files", async () => {
  const home = await mkdtemp(join(tmpdir(), "zencodex-no-index-"));
  try {
    expect(
      await discoverSessions("/work/project", home, undefined, {}),
    ).toEqual([]);
    expect(await readdir(home)).toEqual([]);
    await writeFile(join(home, "state_5.sqlite"), "corrupt");
    await expect(
      discoverSessions("/work/project", home, undefined, {}),
    ).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
