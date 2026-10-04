import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { servePeer } from "./http";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { IMAGE_BYTES, MESSAGE_IMAGE_BYTES, IMAGE_UPLOAD_BYTES } from "./images";

// Uncompressed PNG is deterministic, fully decodable and large without pixel noise.
const image = async () =>
  new File(
    [
      await sharp({
        create: { width: 1024, height: 1360, channels: 3, background: "white" },
      })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    ],
    "large.png",
    { type: "image/png" },
  );

test("production HTTP listener admits legal image bodies and rejects excess", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-upload-limit-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const server = servePeer(app, {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const agent = await service.createOrc("alpha", {
      fast: false,
      orc: { model: "sol", effort: "medium" },
      worker: { model: "sol", effort: "medium" },
    });
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    const url = (operation: string) =>
      `${origin}/api/images?agent=${agent.id}&operation=${operation}`;
    const file = await image();
    expect(file.size).toBeGreaterThan(1024 * 1024);
    expect(file.size).toBeLessThanOrEqual(IMAGE_BYTES);
    expect(file.size * 5).toBeLessThanOrEqual(MESSAGE_IMAGE_BYTES);
    const form = (files: File[], text = "") => {
      const body = new FormData();
      body.set("text", text);
      for (const f of files) body.append("images", f);
      return body;
    };
    const single = await fetch(url("single"), {
      method: "POST",
      headers,
      body: form([file]),
    });
    expect(single.status).toBe(200);
    const refs = (await single.json()).images;
    expect(refs).toHaveLength(1);
    expect(refs[0].width).toBe(1024);
    expect(refs[0].height).toBe(1360);
    const batch = await fetch(url("batch"), {
      method: "POST",
      headers,
      body: form(Array(5).fill(file), "ࠀ".repeat(100_000)),
    });
    expect(batch.status).toBe(200);
    expect((await batch.json()).images).toHaveLength(5);
    const replay = await fetch(url("single"), {
      method: "POST",
      headers,
      body: form([file]),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).images).toEqual(refs);
    const oversized = await fetch(url("excess"), {
      method: "POST",
      headers,
      body: form([
        new File([new Uint8Array(IMAGE_UPLOAD_BYTES + 1)], "excess.png"),
      ]),
    });
    expect(oversized.status).toBe(413);
    const tooLargeImage = await fetch(url("file-limit"), {
      method: "POST",
      headers,
      body: form([new File([new Uint8Array(IMAGE_BYTES + 1)], "excess.png")]),
    });
    expect(tooLargeImage.status).toBe(400);
    expect((await tooLargeImage.json()).error).toContain("5 MiB");
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    await server.stop(true);
    service.dispose();
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
