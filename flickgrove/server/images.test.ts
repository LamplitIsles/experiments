import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ImageStore, PREVIEW_BYTES } from "./images";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { callRoute } from "./socket-testing";
import { groveWebsocket } from "./chord-socket";
import { createHandler, createUpgrade } from "./http";
import { DeliveryRejected } from "./runtime";
import { invoke } from "./chord-methods";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "grove-images-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const png = async () =>
  new File(
    [
      await sharp({
        create: {
          width: 1600,
          height: 900,
          channels: 4,
          background: { r: 50, g: 100, b: 150, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    ],
    "screen.png",
    { type: "image/png" },
  );
const defaults = {
  fast: false,
  orc: { model: "sol", effort: "medium" },
  worker: { model: "sol", effort: "medium" },
};
test("HTTP upload and real Chord preserve a multiline caption exactly", async () => {
  const directory = temp();
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const handler = createHandler(app, { service, origin: () => origin });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const upgraded = createUpgrade(app, { service, origin: () => origin })(
        req,
        server,
      );
      return upgraded === true ? undefined : (upgraded ?? handler(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const a = await service.createOrc("alpha", defaults);
    const other = await service.createOrc("alpha", defaults);
    const headers = { Origin: origin, "X-Grove-Peer": service.identity.id };
    const file = await png();
    for (const [index, text] of [
      "",
      "caption",
      "a\nb",
      "a\r\nb",
      '中文\n"caption"\\\tend',
      "a\r\u0000\ud800b",
    ].entries()) {
      const operationId = `caption-${index}`;
      const form = new FormData();
      form.set("text", JSON.stringify(text));
      form.append("images", file);
      form.append(
        "images",
        new File([await file.arrayBuffer()], "second.png", {
          type: "image/png",
        }),
      );
      const upload = await fetch(
        `${origin}/api/images?agent=${a.id}&operation=${operationId}`,
        {
          method: "POST",
          headers,
          body: form,
        },
      );
      expect(upload.status).toBe(200);
      const refs = (await upload.json()).images;
      const input = { text, operationId, images: refs };
      for (const [id, changed] of [
        [other.id, input],
        [`wrong:${a.id}`, input],
        [a.id, { ...input, operationId: `${operationId}-wrong` }],
        [a.id, { ...input, text: `${text} changed` }],
        [a.id, { ...input, images: [...refs].reverse() }],
        [a.id, { ...input, images: [{ ...refs[0], width: 1 }, refs[1]] }],
        [
          a.id,
          { ...input, images: [{ ...refs[0], id: "0".repeat(64) }, refs[1]] },
        ],
      ] as const) {
        const refused = await callRoute(
          origin,
          `/api/agents/${id}/messages`,
          changed,
        );
        expect(refused.status).toBe(400);
        expect((await refused.json()).error).toContain(
          id.startsWith("wrong:")
            ? "another Peer"
            : "Images do not belong to this conversation and operation",
        );
        expect(runtime.inputs).toHaveLength(index);
      }
      const manifest = JSON.parse(
        readFileSync(join(app.images.directory, "index.json"), "utf8"),
      );
      expect(
        manifest.find((u: { operation: string }) => u.operation === operationId)
          .text,
      ).toBe(text);
      for (let duplicate = 0; duplicate < 2; duplicate++) {
        const sent = await callRoute(
          origin,
          `/api/agents/${a.id}/messages`,
          input,
        );
        const result = await sent.json();
        expect(result).not.toHaveProperty("error");
        expect(sent.status).toBe(200);
      }
      expect(runtime.inputs).toHaveLength(index + 1);
      expect(runtime.inputs[index].text).toBe(text);
      expect(runtime.inputs[index].images).toHaveLength(2);
      expect(service.lookup(a.id, operationId)?.state).toBe("accepted");
      const changed = await callRoute(origin, `/api/agents/${a.id}/messages`, {
        ...input,
        text: `${text} changed`,
      });
      expect(changed.status).toBe(400);
      expect((await changed.json()).error).toContain("different content");
    }
    for (const encoded of ["not-json", "null", "42", "{}", "[]"]) {
      const form = new FormData();
      form.set("text", encoded);
      form.append("images", file);
      const refused = await fetch(
        `${origin}/api/images?agent=${a.id}&operation=invalid`,
        {
          method: "POST",
          headers,
          body: form,
        },
      );
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe("Invalid message text");
    }
    expect(runtime.inputs).toHaveLength(6);
  } finally {
    server.stop(true);
    app.dispose();
  }
});
test("lossless full dimensions/RGBA and alpha; smaller only, separate bounded preview; persisted ownership and orphan cleanup", async () => {
  const directory = temp();
  let store = new ImageStore(directory);
  const file = await png();
  const refs = await store.upload("a", "op", "details", [file]);
  const image = refs[0];
  expect(image.width).toBe(1600);
  expect(image.height).toBe(900);
  expect(image.bytes).toBeLessThanOrEqual(file.size);
  const media = store.read("a", image.id, false)!;
  expect(await sharp(media.bytes).ensureAlpha().raw().toBuffer()).toEqual(
    await sharp(await file.arrayBuffer())
      .ensureAlpha()
      .raw()
      .toBuffer(),
  );
  const preview = store.read("a", image.id, true)!;
  expect(preview.bytes.length).toBeLessThanOrEqual(PREVIEW_BYTES);
  expect((await sharp(preview.bytes).metadata()).width).toBeLessThanOrEqual(
    480,
  );
  expect(() => store.read("b", image.id, false)).toThrow("conversation");
  expect(() => store.read("a", "../index.json", false)).toThrow("reference");
  expect(() => store.validate("a", "op", "different", refs)).toThrow(
    "operation",
  );
  expect(await store.upload("a", "op", "details", [file])).toEqual(refs);
  await expect(store.upload("a", "op", "different", [file])).rejects.toThrow(
    "different content",
  );
  store.commit("a", "op", "details", refs);
  const orphan = await store.upload("a", "orphan", "", [file]);
  store = new ImageStore(directory);
  store.cleanup(Date.now() + 2 * 86400000);
  expect(store.read("a", image.id, false)).not.toBeNull();
  expect(() => store.read("a", orphan[0].id, false)).toThrow();
  unlinkSync(join(directory, image.id));
  expect(store.read("a", image.id, false)).toBeNull();
});
test("actual decoder rejects spoofed type, animation, bad data, pixel and byte/count limits", async () => {
  const store = new ImageStore(temp());
  const file = await png();
  await expect(
    store.upload("a", "six", "", Array(6).fill(file)),
  ).rejects.toThrow("5 images");
  await expect(
    store.upload("a", "large", "", [
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png"),
    ]),
  ).rejects.toThrow("5 MiB");
  await expect(
    store.upload(
      "a",
      "total",
      "",
      Array(5).fill(new File([new Uint8Array(5 * 1024 * 1024)], "big.png")),
    ),
  ).rejects.toThrow("20 MiB");
  await expect(
    store.upload("a", "bad", "", [
      new File(["not png"], "bad.png", { type: "image/png" }),
    ]),
  ).rejects.toThrow("damaged");
  const svg = new File(
    ['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'],
    "fake.png",
    { type: "image/png" },
  );
  await expect(store.upload("a", "svg", "", [svg])).rejects.toThrow("PNG");
  const enormous = await sharp({
    create: { width: 7000, height: 6000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await expect(
    store.upload("a", "pixels", "", [new File([enormous], "pixels.png")]),
  ).rejects.toThrow("40 megapixels");
  const gif = await sharp(
    Buffer.from([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0,
      255, 0, 0, 255,
    ]),
    { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } },
  )
    .gif({ delay: [100, 100] })
    .toBuffer();
  await expect(
    store.upload("a", "animated", "", [new File([gif], "animated.gif")]),
  ).rejects.toThrow("non-animated");
  const tiny = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const tinyRef = await store.upload("a", "tiny", "", [
    new File([tiny], "tiny.png"),
  ]);
  expect(tinyRef[0].bytes).toBeLessThanOrEqual(tiny.length);
});
test("direct cross-origin authorized HTTP upload/read/preflight on real socket and stable Chord refs start/steer once", async () => {
  const directory = temp();
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const handler = createHandler(app, { service, origin: () => origin });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const upgraded = createUpgrade(app, { service, origin: () => origin })(
        req,
        server,
      );
      return upgraded === true ? undefined : (upgraded ?? handler(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const a = await service.createOrc("alpha", defaults);
    const other = await service.createOrc("alpha", defaults);
    const headers = {
      Origin: "http://remote.invalid",
      Authorization: `Bearer ${service.credential}`,
      "X-Grove-Peer": service.identity.id,
    };
    const preflight = await fetch(origin + "/api/images", {
      method: "OPTIONS",
      headers: {
        Origin: headers.Origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,x-grove-peer",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      headers.Origin,
    );
    expect(
      preflight.headers.get("Access-Control-Allow-Credentials"),
    ).toBeNull();
    const file = await png();
    const form = new FormData();
    form.set("text", JSON.stringify(""));
    form.append("images", file);
    const upload = await fetch(
      `${origin}/api/images?agent=${a.id}&operation=one`,
      { method: "POST", headers, body: form },
    );
    expect(upload.status).toBe(200);
    const refs = (await upload.json()).images;
    expect(runtime.inputs.length).toBe(0);
    const url = `${origin}/api/images/${refs[0].id}/original?agent=${a.id}`;
    expect(
      (
        await fetch(url, {
          headers: {
            Origin: headers.Origin,
            "X-Grove-Peer": service.identity.id,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          headers: { ...headers, Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(url, { headers: { ...headers, "X-Grove-Peer": "wrong" } }))
        .status,
    ).toBe(403);
    expect((await fetch(url.replace(a.id, other.id), { headers })).status).toBe(
      400,
    );
    expect(
      (await fetch(url, { headers: { ...headers, Origin: "null" } })).status,
    ).toBe(403);
    const original = await fetch(url, { headers });
    expect(original.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(original.headers.get("Content-Type")).toBe(refs[0].mediaType);
    expect(
      (
        await callRoute(origin, `/api/agents/${a.id}/messages`, {
          text: "",
          operationId: "one",
          images: refs,
        })
      ).status,
    ).toBe(200);
    expect(runtime.inputs.length).toBe(1);
    expect(runtime.inputs[0].text).toBe("");
    expect(readFileSync(runtime.inputs[0].images![0])).toEqual(
      Buffer.from(await original.arrayBuffer()),
    );
    expect(
      (
        await callRoute(origin, `/api/agents/${a.id}/messages`, {
          text: "",
          operationId: "one",
          images: refs,
        })
      ).status,
    ).toBe(200);
    service.lookup(a.id, "one");
    expect(runtime.inputs.length).toBe(1);
    await expect(
      invoke(service, "send", {
        id: a.id,
        text: "changed",
        operationId: "one",
        images: refs,
      }),
    ).rejects.toThrow("different content");
    await expect(
      invoke(service, "send", {
        id: `other:${a.id}`,
        text: "",
        operationId: "one",
        images: refs,
      }),
    ).rejects.toThrow("another Peer");
    const next = await service.uploadImages(a.id, "two", "steer", [file]);
    expect(
      (
        await callRoute(origin, `/api/agents/${a.id}/messages`, {
          text: "steer",
          operationId: "two",
          images: next,
        })
      ).status,
    ).toBe(200);
    expect(runtime.inputs[1].turnId).toBe(runtime.inputs[0].turnId ?? "turn-1");
    expect(runtime.inputs[1].images).toHaveLength(1);
    expect(
      (await service.detail(a.id)).messages.filter((m) => m.images?.length),
    ).toHaveLength(2);
  } finally {
    server.stop(true);
    app.dispose();
  }
});
test("native rejection/unknown retains complete immutable media; lookup never replays; accepted media survives cleanup", async () => {
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: temp(),
    runtime,
    projects: async () => fixtureProjects,
  });
  try {
    const a = await app.createOrc("alpha", defaults);
    const refs = await app.images.upload(a.id, "op", "caption", [await png()]);
    runtime.sendOverride = async () => {
      throw new DeliveryRejected("Rejected");
    };
    const rejected = await app.send(a.id, "caption", "op", refs);
    expect(rejected.deliveries[0].images).toEqual(refs);
    expect(app.lookup(a.id, "op")?.state).toBe("rejected");
    runtime.sendOverride = async () => {
      throw new Error("Unknown");
    };
    const uncertain = await app.images.upload(a.id, "unknown", "", [
      await png(),
    ]);
    await app.send(a.id, "", "unknown", uncertain);
    expect(app.lookup(a.id, "unknown")).toBeNull();
    await app.send(a.id, "", "unknown", uncertain);
    expect(runtime.inputs.length).toBe(2);
    app.images.cleanup(Date.now() + 2 * 86400000);
    expect(app.images.read(a.id, refs[0].id, false)).not.toBeNull();
  } finally {
    app.dispose();
  }
});
