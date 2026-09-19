import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli";

let server: ReturnType<typeof Bun.serve> | undefined;
let root: string | undefined;
afterEach(async () => {
  server?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

test("CLI keeps search bounded and only get expands an own-device record", async () => {
  root = await mkdtemp(join(tmpdir(), "flicklog-cli-"));
  const own = {
    id: "own",
    kind: "message",
    agent: "codex",
    deviceId: hostname(),
    sessionId: "s",
    cwd: "/project",
    role: "user",
    content: "FULL SECRET CONTENT",
    sourcePath: "/not-read",
    sourceRecordIndex: 1,
  };
  const foreign = {
    ...own,
    id: "foreign",
    deviceId: "other-device",
    content: "FOREIGN SECRET",
  };
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/indexes/flicklog_messages")
        return Response.json({ uid: "flicklog_messages" });
      if (path.endsWith("/settings")) return Response.json({ taskUid: 1 });
      if (path === "/tasks/1") return Response.json({ status: "succeeded" });
      if (path.endsWith("/search"))
        return Response.json({
          estimatedTotalHits: 1,
          hits: [
            {
              id: own.id,
              kind: own.kind,
              sessionId: own.sessionId,
              cwd: own.cwd,
              role: own.role,
              _formatted: { content: "…<mark>matched</mark> snippet…" },
            },
          ],
        });
      if (path.endsWith("/documents/own")) return Response.json(own);
      if (path.endsWith("/documents/foreign")) return Response.json(foreign);
      return new Response("missing", { status: 404 });
    },
  });
  const env = {
    FLICKLOG_MEILI_URL: `http://127.0.0.1:${server.port}`,
    FLICKLOG_MEILI_KEY: "test",
    CODEX_HOME: join(root, "codex"),
    FLICKLOG_STATE_DIR: join(root, "state"),
  };
  const output: string[] = [],
    errors: string[] = [];
  const sink = { log: (value: string) => output.push(value) };
  const err = { error: (value: string) => errors.push(value) };
  expect(await run(["search", "matched"], env, "/project", sink, err)).toBe(0);
  expect(output[0]).toContain("<mark>matched</mark>");
  expect(output[0]).not.toContain("FULL SECRET CONTENT");
  output.length = 0;
  expect(await run(["get", "own"], env, "/project", sink, err)).toBe(0);
  expect(output[0]).toContain("FULL SECRET CONTENT");
  expect(output[0]).not.toContain("sourcePath");
  output.length = 0;
  expect(await run(["get", "foreign"], env, "/project", sink, err)).toBe(1);
  expect(errors.at(-1)).not.toContain("FOREIGN SECRET");
});
