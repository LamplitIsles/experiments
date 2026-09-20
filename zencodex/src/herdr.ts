import { spawn } from "node:child_process";
import type { Reporter } from "./conversation";

/** Best-effort, intentionally detached Herdr lifecycle projection. */
export function createHerdrReporter(
  env: NodeJS.ProcessEnv = process.env,
  run = spawn,
): Reporter {
  const pane = env.HERDR_ENV === "1" ? env.HERDR_PANE_ID : undefined;
  let sequence = 0;
  const report = (state: "working" | "idle" | "release") => {
    if (!pane) return;
    const args =
      state === "release"
        ? [
            "pane",
            "release-agent",
            "--source",
            "zencodex",
            "--agent",
            "zencodex",
            pane,
          ]
        : [
            "pane",
            "report-agent",
            "--source",
            "zencodex",
            "--agent",
            "zencodex",
            "--state",
            state,
            "--seq",
            String(++sequence),
            pane,
          ];
    try {
      const child = run("herdr", args, { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      /* never influence Codex */
    }
  };
  return {
    working: () => report("working"),
    idle: () => report("idle"),
    release: () => report("release"),
  };
}
