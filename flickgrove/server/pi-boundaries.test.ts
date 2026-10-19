import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { PiRuntime } from "./pi";
import { acquirePiWriter } from "./pi-storage";
import { Workspace } from "./workspace";

async function isolated(name: string, run: () => Promise<void>) {
  if (process.env.GROVE_BOUNDARY_CHILD) return run();
  const home = await mkdtemp(join(tmpdir(), "grove-pi-boundary-"));
  try {
    const child = Bun.spawn(
      [process.execPath, "test", import.meta.path, "-t", name],
      {
        env: {
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          GROVE_BOUNDARY_CHILD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
}
async function fixture(
  settings: object,
  codemode: boolean | "read" = false,
  resize?: { maxWidth: number; maxHeight: number; maxBytes: number },
) {
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  process.chdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  await writeFile(join(agentDir, "auth.json"), "{}");
  const bodies: {
    messages: { role: string; content: unknown }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      const plan = codemode && bodies.length === 1;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(
          plan
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "owned-call",
                    type: "function",
                    function: {
                      name: codemode === "read" ? "read" : "codemode",
                      arguments: JSON.stringify(
                        codemode === "read"
                          ? { path: "owned-large.png" }
                          : {
                              code: 'text(await tools.bash({command:"printf owned > official-codemode-proof"}));',
                            },
                      ),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Done" },
          null,
        ) +
          chunk({}, plan ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "owned-key",
          models: [
            {
              id: "vision",
              name: "Vision",
              reasoning: false,
              input: ["text", "image"],
              inputLimits: resize ? { images: { resize } } : undefined,
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  let app: Workspace;
  const runtime = new PiRuntime({
    agentDir,
    tool: (token, name, args) => app.tool(token, name, args),
  });
  const workspaceOptions = {
    directory: join(home, "workspace"),
    runtime,
    projects: async () => [{ alias: "owned", name: "Owned", path: cwd }],
  };
  app = new Workspace(workspaceOptions);
  const defaults = {
    backend: "pi" as const,
    provider: "fixture",
    model: "vision",
    effort: "off",
  };
  const create = () =>
    app.createOrc("owned", { fast: false, orc: defaults, worker: defaults });
  const idle = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      if (app.detail(id).state !== "working") return;
      await Bun.sleep(5);
    }
    throw Error("Fixture did not settle");
  };
  return {
    get app() {
      return app;
    },
    async restart() {
      app.dispose();
      await runtime.close();
      app = new Workspace(workspaceOptions);
    },
    runtime,
    bodies,
    cwd,
    agentDir,
    create,
    idle,
    async close() {
      app.dispose();
      try {
        await runtime.close();
      } finally {
        upstream.stop(true);
      }
    },
  };
}

test("Pi blocked images reject before admission and preserve Grove attachments", () =>
  isolated("Pi blocked images", async () => {
    const f = await fixture({ images: { blockImages: true } });
    try {
      const root = await f.create();
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 4, background: "red" },
      })
        .png()
        .toBuffer();
      const observations = [];
      // A first submission and an already-used handle must enforce the same setting.
      for (const op of ["initial-image", "existing-image"]) {
        if (op === "existing-image") {
          await f.app.send(root.id, "Owned text", "text");
          await f.idle(root.id);
        }
        const refs = await f.app.images.upload(root.id, op, "caption", [
          new File([bytes], "owned.png", { type: "image/png" }),
        ]);
        const before = f.bodies.length;
        await f.app.send(root.id, "caption", op, refs);
        await f.idle(root.id);
        const delivery = f.app
          .detail(root.id)
          .deliveries.find((d) => d.id === op)!;
        observations.push({
          operation: op,
          status: delivery.status,
          addedRequests: f.bodies.length - before,
          payload: JSON.stringify(
            f.bodies
              .slice(before)
              .map((body) =>
                body.messages.filter((message) => message.role === "user"),
              ),
          ),
          images: delivery.images?.length,
        });
        expect(delivery.error).toContain("Image reading is disabled");
        expect(JSON.stringify(delivery.images)).toBe(JSON.stringify(refs));
        expect(
          await f.app.images.read(root.id, refs[0]!.id, false),
        ).toBeTruthy();
      }
      console.log("owned image observations", JSON.stringify(observations));
      expect(
        observations.map(({ status, addedRequests, images }) => ({
          status,
          addedRequests,
          images,
        })),
      ).toEqual([
        { status: "failed", addedRequests: 0, images: 1 },
        { status: "failed", addedRequests: 0, images: 1 },
      ]);
      expect(
        JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"))
          .images.blockImages,
      ).toBe(true);
    } finally {
      await f.close();
    }
  }));

test("Pi official codemode executes without MCP activating deferred tools", () =>
  isolated("Pi official codemode", async () => {
    const f = await fixture({}, true);
    try {
      const root = await f.create();
      await f.app.send(root.id, "Execute owned codemode", "code");
      await f.idle(root.id);
      console.log(
        "owned no-MCP declared tools",
        JSON.stringify(f.bodies[0]?.tools?.map((t) => t.function.name)),
      );
      expect(
        await readFile(join(f.cwd, "official-codemode-proof"), "utf8"),
      ).toBe("owned");
      expect(
        f.bodies[0]?.tools?.some((t) => t.function.name === "codemode"),
      ).toBe(true);
      expect(
        f.bodies[0]?.tools?.some((t) => t.function.name === "tool_search"),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }));

test("Pi native acceptance survives a failed Grove confirmation transaction without replay", () =>
  isolated("Pi native acceptance", async () => {
    const f = await fixture({});
    const db = new Database(
      join(process.env.HOME!, "workspace/workspace.sqlite"),
    );
    try {
      const root = await f.create();
      db.exec(
        "CREATE TRIGGER fail_pi_confirmation BEFORE UPDATE ON deliveries WHEN new.status='sent' BEGIN SELECT RAISE(ABORT,'owned Pi confirmation failure'); END",
      );
      await expect(
        f.app.send(root.id, "Accepted across databases", "cross-database"),
      ).rejects.toThrow("owned Pi confirmation failure");
      expect(() => f.app.lookup(root.id, "cross-database")).toThrow();
      expect(() => f.app.detail(root.id)).toThrow();
      expect(
        db
          .query("SELECT status FROM deliveries WHERE operation_id=?")
          .get("cross-database"),
      ).toEqual({ status: "sending" });
      db.exec("DROP TRIGGER fail_pi_confirmation");
      await f.restart();
      for (let i = 0; i < 1000; i++) {
        if (f.app.lookup(root.id, "cross-database")?.state === "accepted")
          break;
        await Bun.sleep(5);
      }
      expect(f.app.lookup(root.id, "cross-database")?.state).toBe("accepted");
      await f.idle(root.id);
      const history = await f.runtime.historyMessages(
        f.app.detail(root.id).threadId!,
      );
      expect(
        history.messages.filter((m) => m.clientId === "cross-database"),
      ).toHaveLength(1);
      expect(f.app.detail(root.id).state).toBe("idle");
    } finally {
      db.close();
      await f.close();
    }
  }));

test("Pi checkpoint failure cannot confirm business Close", () =>
  isolated("Pi checkpoint failure", async () => {
    const f = await fixture({});
    let fault: ReturnType<typeof spyOn> | undefined;
    try {
      const root = await f.create();
      await f.app.send(root.id, "settle owned work", "checkpoint-work");
      await f.idle(root.id);
      const query = Database.prototype.query;
      fault = spyOn(Database.prototype, "query").mockImplementation(function (
        this: Database,
        sql: string,
      ) {
        if (sql === "PRAGMA journal_mode=DELETE")
          throw new Error("owned checkpoint failure");
        return query.call(this, sql);
      } as typeof query);
      await expect(f.app.closeTree(root.id)).rejects.toThrow(
        "Native thread release failed",
      );
      expect(f.app.detail(root.id).closed).toBe(false);
      const release = acquirePiWriter(
        join(f.agentDir, "grove-durable", `${root.threadId}.sqlite`),
      );
      await release();
    } finally {
      fault?.mockRestore();
      // A failed native release remains failed; disposal still closes the fake upstream.
      await f
        .close()
        .catch((error) =>
          expect(String(error)).toContain("Pi resources could not be released"),
        );
    }
  }));

for (const mode of ["read", "submit"] as const)
  test(`Pi official image preparation ${mode} obeys model dimensions`, () =>
    isolated(`Pi official image preparation ${mode}`, async () => {
      const f = await fixture(
        {},
        mode === "read" ? "read" : false,
        mode === "submit"
          ? { maxWidth: 640, maxHeight: 480, maxBytes: 1024 * 1024 }
          : undefined,
      );
      try {
        const bytes = await sharp({
          create: { width: 3000, height: 2000, channels: 4, background: "red" },
        })
          .png()
          .toBuffer();
        expect(bytes.length).toBeLessThan(1024 * 1024);
        await writeFile(join(f.cwd, "owned-large.png"), bytes);
        const root = await f.create();
        const refs =
          mode === "submit"
            ? await f.app.images.upload(
                root.id,
                "image-prep",
                "Original image",
                [new File([bytes], "owned-large.png", { type: "image/png" })],
              )
            : undefined;
        await f.app.send(root.id, "Original image", "image-prep", refs);
        await f.idle(root.id);
        const images = f.bodies
          .flatMap((body) =>
            body.messages.flatMap((message) =>
              Array.isArray(message.content) ? message.content : [],
            ),
          )
          .filter((part: any) => part.type === "image_url") as {
          image_url: { url: string };
        }[];
        const sizes = await Promise.all(
          images.map(async (image) => {
            const data = Buffer.from(
              image.image_url.url.split(",")[1]!,
              "base64",
            );
            const meta = await sharp(data).metadata();
            return {
              width: meta.width,
              height: meta.height,
              bytes: data.length,
            };
          }),
        );
        console.log(
          "owned image preparation",
          JSON.stringify({
            mode,
            originalBytes: bytes.length,
            sizes,
            toolResults: f.bodies.flatMap((body) =>
              body.messages
                .filter((m) => m.role === "tool")
                .map((m) => String(m.content).slice(0, 500)),
            ),
          }),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.width).toBeLessThanOrEqual(
            mode === "submit" ? 640 : 2000,
          );
          expect(size.height).toBeLessThanOrEqual(
            mode === "submit" ? 480 : 2000,
          );
        }
        if (refs) {
          expect(
            (
              await sharp(
                f.app.images.read(root.id, refs[0]!.id, false)!.bytes,
              ).metadata()
            ).width,
          ).toBe(3000);
          const modelPath = join(f.agentDir, "models.json");
          const config = JSON.parse(await readFile(modelPath, "utf8"));
          config.providers.fixture.models[0].inputLimits.images.resize.maxBytes = 1;
          await writeFile(modelPath, JSON.stringify(config));
          const tiny = await sharp({
            create: { width: 2, height: 2, channels: 4, background: "red" },
          })
            .png()
            .toBuffer();
          const rejected = await f.app.images.upload(
            root.id,
            "cannot-prepare",
            "Reject the whole input",
            [
              new File([tiny], "first.png", { type: "image/png" }),
              new File([tiny], "second.png", { type: "image/png" }),
            ],
          );
          const before = f.bodies.length;
          await f.app.send(
            root.id,
            "Reject the whole input",
            "cannot-prepare",
            rejected,
          );
          const delivery = f.app
            .detail(root.id)
            .deliveries.find((d) => d.id === "cannot-prepare")!;
          expect(delivery).toMatchObject({
            status: "failed",
            images: rejected,
            error: "Image could not be prepared for the selected Pi model",
          });
          expect(f.bodies.length).toBe(before);
          for (const image of rejected)
            expect(f.app.images.read(root.id, image.id, false)).toBeTruthy();
        }
      } finally {
        await f.close();
      }
    }));
