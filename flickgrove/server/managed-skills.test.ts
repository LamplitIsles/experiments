import { expect, test } from "bun:test";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Native discovery and metadata only: no account read/login or model turn.
test("installed native discovers version-owned grove skills across projects without a global-name collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-native-skills-"));
  const home = join(root, "home"),
    codexHome = join(root, "codex");
  const first = join(root, "alpha"),
    second = join(root, "beta");
  await Promise.all([
    mkdir(home),
    mkdir(codexHome),
    mkdir(first),
    mkdir(second),
  ]);
  const globalConfig =
    "[agents]\nenabled = true\n\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\n";
  await writeFile(join(codexHome, "config.toml"), globalConfig);
  const old = join(home, ".agents/skills/code-review");
  await mkdir(old, { recursive: true });
  await writeFile(
    join(old, "SKILL.md"),
    "---\nname: code-review\ndescription: Old global review\n---\nOld skill\n",
  );
  const client = new CodexAppServerClient({
    cwd: first,
    codexPath: "codex",
    clientInfo: {
      name: "grove-probe",
      title: "Grove native probe",
      version: "1",
    },
    capabilities: { experimentalApi: true },
    protocolValidation: "strict",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
    },
  });
  try {
    await client.connect();
    await client.call("skills/extraRoots/set", {
      extraRoots: [fileURLToPath(new URL("../skills", import.meta.url))],
    });
    const response = await client.call("skills/list", {
      cwds: [first, second],
      forceReload: true,
    });
    // Metadata-only native creation accepts developerInstructions/config; never
    // start a turn or copy credentials to establish this supported seam.
    const thread = await client.threadStart({
      cwd: first,
      model: "gpt-6.1-sol",
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: "Test-owned role context",
      config: {
        model_reasoning_effort: "high",
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      },
      historyMode: "paginated",
    });
    expect(thread.model).toBe("gpt-6.1-sol");
    expect(thread.reasoningEffort).toBe("high");
    // Native defers rollout persistence until a turn. Do not invoke a paid turn
    // merely to make this metadata-only fixture resumable.
    await expect(
      client.threadResume({
        threadId: thread.thread.id,
        excludeTurns: true,
        config: {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
        },
        developerInstructions: "Test-owned role context",
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    ).rejects.toThrow("no rollout found");
    await client.call("thread/unsubscribe", { threadId: thread.thread.id });
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      globalConfig,
    );
    for (const entry of response.data) {
      expect(entry.errors).toEqual([]);
      expect(
        entry.skills
          .filter((s) => s.name.startsWith("grove-") && s.enabled)
          .map((s) => s.name)
          .sort(),
      ).toEqual([
        "grove-code-review",
        "grove-domain-modeling",
        "grove-grill-with-docs",
        "grove-grilling",
        "grove-orc-impl",
        "grove-research",
        "grove-review-again",
        "grove-spec-self-review",
        "grove-to-orc-impl",
        "grove-to-spec",
        "grove-to-tickets",
      ]);
      expect(
        entry.skills.some((s) => s.name === "code-review" && s.enabled),
      ).toBe(true);
      expect(
        entry.skills.find((s) => s.name === "grove-code-review")!.path,
      ).toBe(
        fileURLToPath(
          new URL("../skills/grove-code-review/SKILL.md", import.meta.url),
        ),
      );
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
