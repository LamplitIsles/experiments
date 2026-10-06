import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent } from "./runtime";

test("Close waits for native writer release, isolates another thread and catches notification-before-ack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-native-release-"));
  const control = join(directory, ".fake-app-server-control.json");
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://fixture.invalid",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "home"),
      FAKE_SERVER_ROOT: directory,
    },
  });
  const agent = (id: string, role: "orc" | "worker"): RuntimeAgent => ({
    id,
    role,
    token: id,
    project: { alias: id, name: id, path: join(directory, id) },
    title: id,
    model: "fixture-model",
    effort: "low",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  });
  const a = agent("root", "orc"),
    b = agent("worker", "worker");
  const loaded = async (id: string) =>
    JSON.parse(
      await readFile(join(directory, ".fake-app-server-state.json"), "utf8"),
    ).threads[id].loaded;
  try {
    await mkdir(a.project.path);
    await mkdir(b.project.path);
    const ah = await runtime.open(a, () => {}),
      bh = await runtime.open(b, () => {});
    await writeFile(control, JSON.stringify({ releaseDelayMs: 100 }));
    let settled = false;
    const close = ah.close().then(() => {
      settled = true;
    });
    await Bun.sleep(40);
    expect(settled).toBe(false);
    expect(await loaded(ah.threadId)).toBe(true); // External writer still blocked.
    await close;
    expect(await loaded(ah.threadId)).toBe(false);
    expect(await loaded(bh.threadId)).toBe(true);
    await bh.rename("Other thread stays usable");
    await writeFile(control, JSON.stringify({ holdThreadRelease: true }));
    await expect(bh.close()).rejects.toThrow("release unconfirmed");
    expect(await loaded(bh.threadId)).toBe(true);
    await bh.rename("Visible after timeout and retryable");
    await writeFile(control, JSON.stringify({ closeBeforeAck: true }));
    await bh.close();
    expect(await loaded(bh.threadId)).toBe(false);
    await bh.close(); // Idempotent close after authoritative release.
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
