import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent } from "./runtime";

test("strict native wire preserves Reviewer prompt snapshot and role config on start and restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-reviewer-wire-"));
  const projects = [join(root, "alpha"), join(root, "beta")];
  await Promise.all(projects.map((p) => mkdir(p)));
  await writeFile(
    join(root, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true }),
  );
  const make = () =>
    new CodexRuntime({
      cwd: root,
      origin: () => "http://127.0.0.1:1",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        ...process.env,
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        FAKE_SERVER_ROOT: root,
      },
    });
  let runtime = make();
  const agent = (id: string, index: number): RuntimeAgent => ({
    id,
    role: "reviewer",
    ownerId: "orc",
    token: `token-${id}`,
    project: { alias: id, name: id, path: projects[index] },
    title: id,
    model: "fixture-model",
    effort: "medium",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
    reviewerSnapshot: {
      model: "fixture-model",
      effort: "medium",
      prompt: `axis-${id}`,
    },
    reviewTarget: {
      profile: index === 0 ? "standards" : "spec",
      spec: "#3573",
      fixedPoint: "base",
      reviewedHead: "head",
    },
  });
  const a = agent("standards", 0),
    b = agent("spec", 1);
  try {
    const ah = await runtime.open(a, () => {}),
      bh = await runtime.open(b, () => {});
    expect(ah.threadId).not.toBe(bh.threadId);
    a.threadId = ah.threadId;
    await runtime.close();
    runtime = make();
    const restored = await runtime.open(a, () => {});
    expect(restored.threadId).toBe(a.threadId);
    const requests = (
      await readFile(join(root, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const starts = requests.filter((r) => r.method === "thread/start");
    const resume = requests.find(
      (r) => r.method === "thread/resume" && r.params.developerInstructions,
    );
    expect(starts).toHaveLength(2);
    for (const r of starts) {
      expect(r.params.sandbox).toBe("read-only");
      expect(r.params.config.model_reasoning_effort).toBe("medium");
      expect(r.params.model).toBe("fixture-model");
    }
    expect(resume.params.developerInstructions).toBe(
      starts[0].params.developerInstructions,
    );
    expect(starts[0].params.developerInstructions).not.toBe(
      starts[1].params.developerInstructions,
    );
    expect(resume.params.model).toBeUndefined();
    expect(resume.params.config.model_reasoning_effort).toBeUndefined();
    expect(
      requests.filter((r) => r.method === "skills/extraRoots/set"),
    ).toHaveLength(2);
    expect(requests.some((r) => r.method === "turn/start")).toBe(false);
    await restored.close();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
