import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import { initializeReviewerConfig, orcPrompt } from "./reviewer-config";

test("Orc captures configurable context for new threads and preserves it on native restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-orc-prompt-"));
  const configPath = join(root, "config.toml");
  await initializeReviewerConfig(configPath);
  const promptPath = join(root, "prompts/orc.md");
  await writeFile(promptPath, "Custom investigation scope A");
  const makeRuntime = () =>
    new CodexRuntime({
      cwd: root,
      origin: () => "http://127.0.0.1:1",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        FAKE_SERVER_ROOT: root,
      },
    });
  let runtime = makeRuntime();
  const makeWorkspace = () =>
    new Workspace({
      directory: root,
      runtime,
      projects: async () => [{ alias: "alpha", name: "Alpha", path: root }],
      orcPrompt: () => orcPrompt(configPath),
    });
  let app = makeWorkspace();
  const requests = async () =>
    (await readFile(join(root, ".fake-app-server-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  try {
    const first = await app.createOrc("alpha");
    const initial = (await requests()).find(
      (r) => r.method === "thread/start" && !r.params.ephemeral,
    ).params.developerInstructions;
    expect(initial).toContain("Custom investigation scope A");
    await writeFile(promptPath, "Custom investigation scope B");
    const second = await app.createOrc("alpha");
    const starts = (await requests()).filter(
      (r) => r.method === "thread/start" && !r.params.ephemeral,
    );
    expect(starts[1].params.developerInstructions).toContain(
      "Custom investigation scope B",
    );
    // The mandatory role/lifecycle context surrounds either arbitrary axis text,
    // without asserting the application prompt's prose.
    expect(initial.replace("Custom investigation scope A", "")).toBe(
      starts[1].params.developerInstructions.replace(
        "Custom investigation scope B",
        "",
      ),
    );
    expect(initial.length).toBeGreaterThan(
      "Custom investigation scope A".length,
    );
    app.dispose();
    await runtime.close();
    runtime = makeRuntime();
    app = makeWorkspace();
    await app.updateSettings(first.id, {
      model: "fixture-model",
      effort: "medium",
    });
    const resumed = (await requests()).filter(
      (r) =>
        r.method === "thread/resume" &&
        r.params.threadId === first.threadId &&
        r.params.developerInstructions,
    );
    expect(resumed.at(-1).params.developerInstructions).toBe(initial);
    expect(app.detail(first.id).threadId).toBe(first.threadId);
    // A prefeature Orc captures once on explicit restoration, without migration.
    await app.closeTree(second.id);
    app.dispose();
    await runtime.close();
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(root, "workspace.sqlite"));
    const row = db.query("SELECT value FROM workspace WHERE id=1").get() as {
      value: string;
    };
    const state = JSON.parse(row.value);
    const legacy = state.agents.find((a: { id: string }) => a.id === second.id);
    delete legacy.orcPromptSnapshot;
    legacy.closed = false;
    db.query("UPDATE workspace SET value=? WHERE id=1").run(
      JSON.stringify(state),
    );
    db.close();
    await writeFile(promptPath, "Legacy captured scope C");
    runtime = makeRuntime();
    app = makeWorkspace();
    await app.updateSettings(first.id, {
      model: "fixture-model",
      effort: "medium",
    });
    const beforeRestore = (await requests()).filter(
      (r) =>
        r.method === "thread/resume" &&
        r.params.threadId === second.threadId &&
        r.params.developerInstructions,
    ).length;
    expect(beforeRestore).toBe(1);
    await app.resumeHistory("alpha", second.threadId!, false);
    const restored = (await requests())
      .filter(
        (r) =>
          r.method === "thread/resume" &&
          r.params.threadId === second.threadId &&
          r.params.developerInstructions,
      )
      .at(-1);
    expect(restored.params.developerInstructions).toContain(
      "Legacy captured scope C",
    );
    await writeFile(promptPath, "Later scope D");
    await app.closeTree(second.id);
    await app.resumeHistory("alpha", second.threadId!, false);
    expect(
      (await requests())
        .filter(
          (r) =>
            r.method === "thread/resume" &&
            r.params.threadId === second.threadId &&
            r.params.developerInstructions,
        )
        .at(-1).params.developerInstructions,
    ).toBe(restored.params.developerInstructions);
    expect((await requests()).some((r) => r.method === "turn/start")).toBe(
      false,
    );
  } finally {
    app.dispose();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
