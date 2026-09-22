import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli";
import { connect } from "./app-server";
import type {
  createTerminalRenderer,
  createConversationReader,
} from "./reader";

for (const [id, fails] of [
  ["thread-fake", false],
  ["thread-fake", true],
  ["zencodex:new", true],
] as const)
  test(`direct resume ${id} ${fails ? "fails without fallback" : "opens exactly the requested thread"}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zencodex-cli-"));
    const states: string[] = [];
    let renderedId: string | undefined;
    let destroyed = false;
    const renderer = {
      isDestroyed: false,
      destroy() {
        destroyed = true;
      },
    } as Awaited<ReturnType<typeof createTerminalRenderer>>;
    try {
      if (fails)
        await writeFile(
          join(cwd, ".fake-app-server-control.json"),
          JSON.stringify({
            resumeError: { code: -32600, message: "thread does not exist" },
          }),
        );
      const run = main(["--resume", id], {
        createTerminalRenderer: async () => renderer,
        discoverSessions: async () => {
          throw new Error("direct resume must not scan history");
        },
        pickSession: async () => {
          throw new Error("direct resume must not open picker");
        },
        connect: () =>
          connect(
            cwd,
            fileURLToPath(
              new URL("./fake-app-server-entry.mjs", import.meta.url),
            ),
            { env: { HERDR_ENV: "0", CODEX_HOME: cwd } },
          ),
        createHerdrReporter: () => ({
          idle: () => states.push("idle"),
          working: () => states.push("working"),
          release: () => states.push("release"),
        }),
        createConversationReader: async (options) => {
          renderedId = options.session.id;
          return {
            start() {},
            dispose() {},
            project() {},
            waitForExit: async () => "quit",
          } as unknown as Awaited<ReturnType<typeof createConversationReader>>;
        },
      });
      if (fails) await expect(run).rejects.toThrow(`Cannot resume ${id}`);
      else await run;
      expect(destroyed).toBe(true);
      expect(renderedId).toBe(fails ? undefined : "thread-fake");
      expect(states).toEqual(fails ? [] : ["idle", "release"]);
      const calls = (
        await readFile(join(cwd, ".fake-app-server-requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls
          .filter((r) => r.method === "thread/resume")
          .map((r) => r.params.threadId),
      ).toEqual([id]);
      expect(calls.some((r) => r.method === "thread/start")).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

test("invalid resume arguments fail before creating terminal UI", async () => {
  for (const args of [
    ["--resume"],
    ["--resume", ""],
    ["--resume", "id", "extra"],
    ["--unknown"],
    ["--resume", "bad\nid"],
  ]) {
    await expect(
      main(args, {
        createTerminalRenderer: async () => {
          throw new Error("UI must not start");
        },
      }),
    ).rejects.toThrow("Usage:");
  }
});
