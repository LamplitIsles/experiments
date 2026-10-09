import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent } from "./runtime";

test("strict native wire disables model-aware collaboration on all role starts and original-thread restores while retaining Grove MCP", async () => {
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
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        FAKE_SERVER_ROOT: root,
      },
    });
  let runtime = make();
  const agent = (id: string, index: number): RuntimeAgent => ({
    id,
    role:
      index === 0
        ? "reviewer"
        : index === 1
          ? "researcher"
          : index === 2
            ? "orc"
            : "worker",
    ownerId: "orc",
    token: `token-${id}`,
    project: { alias: id, name: id, path: projects[index % 2] },
    title: id,
    model: "fixture-model",
    effort: "medium",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
    researchQuestion: index === 1 ? "What is the gate?" : undefined,
    researcherSnapshot:
      index === 1
        ? {
            model: "fixture-model",
            effort: "medium",
            prompt: "Question evidence scope",
          }
        : undefined,
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
    b = agent("research", 1),
    c = agent("orc", 2),
    d = agent("worker", 3);
  try {
    const ah = await runtime.open(a, () => {}),
      bh = await runtime.open(b, () => {});
    expect(ah.threadId).not.toBe(bh.threadId);
    a.threadId = ah.threadId;
    b.threadId = bh.threadId;
    c.threadId = (await runtime.open(c, () => {})).threadId;
    d.threadId = (await runtime.open(d, () => {})).threadId;
    await runtime.close();
    runtime = make();
    const restored = await runtime.open(a, () => {});
    for (const agent of [b, c, d])
      expect((await runtime.open(agent, () => {})).threadId).toBe(
        agent.threadId!,
      );
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
    expect(starts).toHaveLength(4);
    for (const r of starts) {
      expect(r.params.sandbox).toBe(
        r === starts[0] ? "read-only" : "danger-full-access",
      );
      expect(r.params.config.model_reasoning_effort).toBe("medium");
      expect(r.params.model).toBe("fixture-model");
    }
    const resumes = requests.filter(
      (r) => r.method === "thread/resume" && r.params.developerInstructions,
    );
    expect(resumes).toHaveLength(4);
    for (const r of [...starts, ...resumes]) {
      expect(r.params.config).toMatchObject({
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      });
      expect(r.params.config["mcp_servers.flickgrove"]).toMatchObject({
        command: process.execPath,
        env: { FLICKGROVE_ORIGIN: "http://127.0.0.1:1" },
      });
    }
    expect(resumes.map((r) => r.params.threadId).sort()).toEqual(
      [a, b, c, d].map((a) => a.threadId).sort(),
    );
    expect(resumes[1].params.developerInstructions).toBe(
      starts[1].params.developerInstructions,
    );
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
