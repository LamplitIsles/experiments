import { watch } from "node:fs";
import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiRuntime } from "./pi";

test("passive Pi skills without offline mode never install packages or execute commands", async () => {
  if (!process.env.GROVE_SKILLS_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-skills-home-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          GROVE_SKILLS_CHILD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      for (const line of out.split("\n"))
        if (line.startsWith("owned ")) console.log(line);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  expect(process.env.PI_OFFLINE).toBeUndefined();
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo"),
    bin = join(home, "bin"),
    log = join(home, "commands");
  await mkdir(agentDir);
  await mkdir(cwd);
  await mkdir(bin);
  for (const name of ["npm", "git"])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${log}'\nprintf '%s\\n' "$*" >> '${log}'\nexit 37\n`,
      { mode: 0o700 },
    );
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const runtime = new PiRuntime({
    agentDir,
    tool: async () => {
      throw Error("Passive tools");
    },
  });
  const observations = [];
  for (const source of [
    "npm:owned-missing@1.0.0",
    "npm:owned-mismatch@2.0.0",
    "git:https://example.invalid/owned/absent",
  ]) {
    if (source.includes("mismatch")) {
      const pkg = join(agentDir, "npm/node_modules/owned-mismatch");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ name: "owned-mismatch", version: "1.0.0" }),
      );
    }
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [source] }),
    );
    await writeFile(log, "");
    const before = await readdir(agentDir, { recursive: true });
    let error: string | undefined;
    try {
      await runtime.skills(cwd);
    } catch (e) {
      error = String(e);
    }
    observations.push({
      source,
      commands: await readFile(log, "utf8"),
      added: (await readdir(agentDir, { recursive: true })).filter(
        (p) => !before.includes(p),
      ),
      error,
    });
  }
  console.log("owned passive observations", JSON.stringify(observations));
  const skill = async (path: string, name: string) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Owned fixture skill\n---\nRead only.\n`,
    );
  };
  const managed = join(agentDir, "npm/node_modules");
  for (const name of ["owned-good", "@owned/scoped"]) {
    const root = join(managed, name!);
    await skill(
      join(root, "skills/allowed"),
      name!.includes("/") ? "scoped-skill" : "managed-skill",
    );
    await skill(join(root, "skills/hidden"), "hidden-package-skill");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name, version: "1.0.0", pi: { skills: ["skills"] } }),
    );
  }
  const git = join(agentDir, "git/example.invalid/owned/installed");
  await skill(join(git, "skills/git"), "installed-git-skill");
  const local = join(agentDir, "local-package");
  await skill(join(local, "skills/local"), "local-package-skill");
  await skill(join(agentDir, "skills/auto"), "user-auto-skill");
  await skill(join(cwd, ".pi/skills/auto"), "project-auto-skill");
  await skill(join(cwd, ".agents/skills/auto"), "project-agents-skill");
  const projectPackage = join(cwd, ".pi/npm/node_modules/owned-shared");
  await skill(join(projectPackage, "skills/shared"), "project-wins-skill");
  await writeFile(
    join(projectPackage, "package.json"),
    JSON.stringify({ name: "owned-shared", version: "1.0.0" }),
  );
  const userPackage = join(managed, "owned-shared");
  await skill(join(userPackage, "skills/shared"), "user-loses-skill");
  await writeFile(
    join(userPackage, "package.json"),
    JSON.stringify({ name: "owned-shared", version: "1.0.0" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [
        { source: "npm:owned-good@1.0.0", skills: ["skills/allowed"] },
        { source: "npm:@owned/scoped@^1.0.0", skills: ["skills/allowed"] },
        "git:https://example.invalid/owned/installed",
        "./local-package",
        "npm:owned-shared@1.0.0",
        "npm:owned-missing@1.0.0",
        "npm:owned-mismatch@2.0.0",
      ],
    }),
  );
  await writeFile(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({
      packages: ["npm:owned-shared@1.0.0", "npm:owned-project-missing@1.0.0"],
    }),
  );
  await writeFile(log, "");
  const snapshot = async () => {
    const files: [string, string][] = [];
    for (const root of [agentDir, cwd])
      for (const entry of await readdir(root, {
        recursive: true,
        withFileTypes: true,
      }))
        if (entry.isFile()) {
          const path = join(entry.parentPath, entry.name);
          files.push([
            path,
            Buffer.from(await readFile(path)).toString("base64"),
          ]);
        }
    return files.sort((a, b) => a[0].localeCompare(b[0]));
  };
  const before = await snapshot();
  const mutations: string[] = [];
  const watchers = [agentDir, cwd].map((root) =>
    watch(root, { recursive: true }, (event, path) =>
      mutations.push(`${event}:${path}`),
    ),
  );
  let names: string[];
  try {
    names = (await runtime.skills(cwd)).map((s) => s.name);
    await Bun.sleep(20); // Drain filesystem notifications, including transient locks.
  } finally {
    for (const watcher of watchers) watcher.close();
  }
  expect(mutations).toEqual([]);
  for (const name of [
    "managed-skill",
    "scoped-skill",
    "installed-git-skill",
    "local-package-skill",
    "user-auto-skill",
    "project-auto-skill",
    "project-agents-skill",
    "project-wins-skill",
    "grove-research",
  ])
    expect(names).toContain(name);
  expect(names).not.toContain("hidden-package-skill");
  expect(names).not.toContain("user-loses-skill");
  expect(await readFile(log, "utf8")).toBe("");
  expect(await snapshot()).toEqual(before);
  console.log("owned installed skills", JSON.stringify(names));
  await runtime.close();
  expect(
    observations.map((o) => ({
      commands: o.commands,
      added: o.added,
      error: o.error,
    })),
  ).toEqual(
    observations.map(() => ({ commands: "", added: [], error: undefined })),
  );
});
