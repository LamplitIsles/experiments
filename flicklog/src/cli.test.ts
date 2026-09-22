import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
  let configureRequests = 0;
  const searches: any[] = [];
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/indexes/flicklog_messages")
        return Response.json({ uid: "flicklog_messages" });
      if (path.endsWith("/settings")) {
        configureRequests++;
        return Response.json({ taskUid: 1 });
      }
      if (path === "/tasks/1") return Response.json({ status: "succeeded" });
      if (path.endsWith("/search")) {
        searches.push(await request.json());
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
      }
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
  expect(searches[0]).toMatchObject({
    limit: 5,
    filter: [`deviceId = ${JSON.stringify(hostname())}`, 'cwd = "/project"'],
    sort: ["createdAt:desc"],
  });
  expect(output[0]).toContain("<mark>matched</mark>");
  expect(output[0]).not.toContain("FULL SECRET CONTENT");
  output.length = 0;
  expect(
    await run(
      ["search", "matched", "--limit", "12"],
      env,
      "/project",
      sink,
      err,
    ),
  ).toBe(0);
  expect(searches.map((search) => search.limit)).toEqual([5, 12]);
  const originalNow = Date.now;
  Date.now = () => 1768046400000;
  try {
    expect(
      await run(
        ["search", "matched", "--since", "2d"],
        env,
        "/project",
        sink,
        err,
      ),
    ).toBe(0);
    expect(searches[2].filter).toEqual([
      `deviceId = ${JSON.stringify(hostname())}`,
      'cwd = "/project"',
      "createdAtEpoch >= 1767873600",
      "createdAtEpoch < 1768046400",
    ]);
    expect(
      await run(
        ["search", "matched", "--from", "2026-01-05T00:00:00Z"],
        env,
        "/project",
        sink,
        err,
      ),
    ).toBe(0);
    expect(searches[3].filter).toEqual([
      `deviceId = ${JSON.stringify(hostname())}`,
      'cwd = "/project"',
      "createdAtEpoch >= 1767571200",
    ]);
    expect(
      await run(
        [
          "search",
          "matched",
          "--from",
          "2026-01-05T00:00:00Z",
          "--until",
          "2026-01-06T00:00:00Z",
          "--all-projects",
        ],
        env,
        "/project",
        sink,
        err,
      ),
    ).toBe(0);
    expect(searches[4].filter).toEqual([
      `deviceId = ${JSON.stringify(hostname())}`,
      "createdAtEpoch >= 1767571200",
      "createdAtEpoch < 1767657600",
    ]);
  } finally {
    Date.now = originalNow;
  }
  const beforeInvalid = { configureRequests, searches: searches.length };
  for (const value of [undefined, "nope", "0", "-1", "21"]) {
    const args =
      value === undefined
        ? ["search", "matched", "--limit"]
        : ["search", "matched", "--limit", value];
    expect(await run(args, env, "/project", sink, err)).toBe(1);
  }
  for (const args of [
    ["search", "matched", "--since", "2d", "--from", "2026-01-05T00:00:00Z"],
    ["search", "matched", "--since", "2d", "--until", "2026-01-06T00:00:00Z"],
    ["search", "matched", "--until", "2026-01-06T00:00:00Z"],
    [
      "search",
      "matched",
      "--from",
      "2026-01-06T00:00:00Z",
      "--until",
      "2026-01-05T00:00:00Z",
    ],
    ["search", "matched", "--from", "not-a-timestamp"],
    ["search", "matched", "--from", "2026-01-05T00:00:00"],
    ["search", "matched", "--since", "0d"],
    ["search", "matched", "--since", "-1d"],
    ["search", "matched", "--since", "2x"],
    ["search", "matched", "--since", "2d", "--since", "1d"],
    [
      "search",
      "matched",
      "--from",
      "2026-01-05T00:00:00Z",
      "--from",
      "2026-01-06T00:00:00Z",
    ],
    [
      "search",
      "matched",
      "--from",
      "2026-01-05T00:00:00Z",
      "--until",
      "2026-01-06T00:00:00Z",
      "--until",
      "2026-01-07T00:00:00Z",
    ],
  ])
    expect(await run(args, env, "/project", sink, err)).toBe(1);
  expect(configureRequests).toBe(beforeInvalid.configureRequests);
  expect(searches).toHaveLength(beforeInvalid.searches);
  output.length = 0;
  expect(await run(["get", "own"], env, "/project", sink, err)).toBe(0);
  expect(output[0]).toContain("FULL SECRET CONTENT");
  expect(output[0]).not.toContain("sourcePath");
  output.length = 0;
  expect(await run(["get", "foreign"], env, "/project", sink, err)).toBe(1);
  expect(errors.at(-1)).not.toContain("FOREIGN SECRET");
});

test("ingest shares search sync and confines TTY progress to stderr", async () => {
  root = await mkdtemp(join(tmpdir(), "flicklog-cli-"));
  const home = join(root, "codex");
  await mkdir(join(home, "sessions", "2026"), { recursive: true });
  await writeFile(
    join(home, "sessions", "2026", "s1.jsonl"),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "s1",
        session_id: "s1",
        cwd: "/project",
        source: "cli",
        thread_source: "user",
        timestamp: "2026-01-01T00:00:00Z",
      },
    })}\n`,
  );
  let documents = 0;
  let failDocuments = false;
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/indexes/flicklog_messages")
        return Response.json({ uid: "flicklog_messages" });
      if (path.endsWith("/settings")) return Response.json({ taskUid: 1 });
      if (path.endsWith("/documents")) {
        documents++;
        return failDocuments
          ? new Response("publish failed", { status: 500 })
          : Response.json({ taskUid: 1 });
      }
      if (path === "/tasks/1") return Response.json({ status: "succeeded" });
      if (path.endsWith("/search")) {
        return Response.json({ estimatedTotalHits: 0, hits: [] });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const env = {
    FLICKLOG_MEILI_URL: `http://127.0.0.1:${server.port}`,
    FLICKLOG_MEILI_KEY: "test",
    CODEX_HOME: home,
    FLICKLOG_STATE_DIR: join(root, "state"),
  };
  const output: string[] = [];
  const terminal = new PassThrough() as PassThrough & { isTTY: boolean };
  terminal.isTTY = true;
  let progress = "";
  terminal.on("data", (chunk) => (progress += chunk));
  const sink = { log: (value: string) => output.push(value) };
  const errors: string[] = [];
  const error = { error: (value: string) => errors.push(value) };
  expect(await run(["ingest"], env, "/project", sink, error, terminal)).toBe(0);
  expect(JSON.parse(output[0])).toEqual({ indexed: 0, sources: 1 });
  expect(progress).toContain("Ingesting Codex sessions");
  expect(progress).toContain("complete");
  expect(errors).toEqual([]);
  output.length = 0;
  progress = "";
  expect(
    await run(["search", "anything"], env, "/project", sink, error, terminal),
  ).toBe(0);
  expect(JSON.parse(output[0]).sync).toEqual({ indexed: 0, sources: 1 });
  expect(progress).toBe("");
  expect(documents).toBe(0);
  await writeFile(
    join(home, "sessions", "2026", "s1.jsonl"),
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "msg",
        role: "user",
        content: [{ type: "input_text", text: "pending" }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    })}\n`,
    { flag: "a" },
  );
  failDocuments = true;
  progress = "";
  const terminalErrors = {
    error: (value: string) => terminal.write(`${value}\n`),
  };
  expect(
    await run(["ingest"], env, "/project", sink, terminalErrors, terminal),
  ).toBe(1);
  expect(progress).toContain("Ingesting Codex sessions");
  expect(progress).toContain("\nflicklog: Meilisearch 500: publish failed\n");
  failDocuments = false;
  terminal.isTTY = false;
  output.length = 0;
  progress = "";
  expect(await run(["ingest"], env, "/project", sink, error, terminal)).toBe(0);
  expect(JSON.parse(output[0])).toEqual({ indexed: 1, sources: 1 });
  expect(progress).toBe("");
});
