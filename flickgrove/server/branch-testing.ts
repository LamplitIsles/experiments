// Test-owned Git only: never consult installed user config or mutate live repos.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
export function fixtureGit(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function temporaryGit(path: string, branch = "fixture-main") {
  mkdirSync(path, { recursive: true });
  fixtureGit(path, "init", "--initial-branch", branch);
  fixtureGit(
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  return path;
}
