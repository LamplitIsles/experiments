import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { PiRuntime } from "./pi";
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
async function fixture(settings: object, codemode = false) {
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
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
                      name: "codemode",
                      arguments: JSON.stringify({
                        code: 'text(await tools.bash({command:"printf owned > official-codemode-proof"}));',
                      }),
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
  app = new Workspace({
    directory: join(home, "workspace"),
    runtime,
    projects: async () => [{ alias: "owned", name: "Owned", path: cwd }],
  });
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
    app,
    runtime,
    bodies,
    cwd,
    agentDir,
    create,
    idle,
    async close() {
      app.dispose();
      await runtime.close();
      upstream.stop(true);
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
