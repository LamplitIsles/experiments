import { spawn } from "node:child_process";
import type { Reporter } from "./conversation";

/** Best-effort, intentionally detached Herdr lifecycle projection. */
export function createHerdrReporter(
  env: NodeJS.ProcessEnv = process.env,
  run = spawn,
  warn: (message: string) => void = () => {},
): Reporter {
  const pane = env.HERDR_ENV === "1" ? env.HERDR_PANE_ID : undefined;
  let sequence = Date.now() * 1000;
  const report = (
    state: "working" | "idle" | "blocked" | "release",
    message?: string,
  ) => {
    if (!pane) return;
    const args =
      state === "release"
        ? [
            "pane",
            "release-agent",
            pane,
            "--source",
            "zencodex",
            "--agent",
            "zencodex",
            "--seq",
            String(++sequence),
          ]
        : [
            "pane",
            "report-agent",
            pane,
            "--source",
            "zencodex",
            "--agent",
            "zencodex",
            "--state",
            state,
            "--seq",
            String(++sequence),
            ...(message ? ["--message", message] : []),
          ];
    try {
      const child = run("herdr", args, { stdio: "ignore", detached: true });
      child.on("error", () =>
        warn("Herdr reporting failed: unable to launch herdr"),
      );
      child.on("exit", (code, signal) => {
        if (code !== 0)
          warn(
            `Herdr reporting failed (${signal ?? code}); check Herdr server and pane configuration`,
          );
      });
      child.unref();
    } catch {
      warn("Herdr reporting failed: unable to launch herdr");
    }
  };
  return {
    working: () => report("working"),
    idle: () => report("idle"),
    release: () => report("release"),
    blocked: (message) => report("blocked", message),
  };
}
