import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import type { Reporter } from "./conversation";

/** Match the installed shell hook, not arbitrary commands mentioning its name. */
export function isHerdrSessionHook(hook: {
  eventName: string;
  handlerType: string;
  command?: string;
}): boolean {
  if (
    hook.eventName !== "sessionStart" ||
    hook.handlerType !== "command" ||
    !hook.command
  )
    return false;
  const match =
    /^(?:bash|sh|\/(?:usr\/)?bin\/(?:bash|sh))\s+(?:'([^']+)'|"([^"$`]+)"|([^\s'"\\;$`|&<>]+))\s+session\s*$/.exec(
      hook.command.trim(),
    );
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  return (
    !!path && isAbsolute(path) && basename(path) === "herdr-agent-state.sh"
  );
}

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
      const child = run("herdr", args, {
        env,
        stdio: "ignore",
        detached: true,
      });
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
