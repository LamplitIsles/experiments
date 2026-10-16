import sharp from "sharp";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { createHandler, createUpgrade } from "./http";
import { FakeRuntime, fixtureProjects } from "./testing";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-single-host-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  const origin = "http://127.0.0.1:4321";
  writeFileSync(
    join(directory, "hosts.json"),
    JSON.stringify({
      id: "existing-instance",
      credential: "former-test-token",
    }),
  );
  const service = new HostService(app, { directory, origin: () => origin });
  const options = {
    service,
    origin: () => origin,
    voice: { configPath: join(directory, "config.toml") },
  };
  cleanups.push(() => {
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, app, runtime, service, origin, options };
}
test("same-origin socket ignores a stale legacy browser credential", () => {
  const f = fixture();
  let upgraded = false;
  const result = createUpgrade(f.app, f.options)(
    new Request(f.origin + "/api/socket", {
      headers: {
        Origin: f.origin,
        "Sec-WebSocket-Protocol": "grove.v1, grove-auth.stale",
      },
    }),
    {
      upgrade: () => {
        upgraded = true;
        return true;
      },
    },
  );
  expect(result).toBe(true);
  expect(upgraded).toBe(true);
});
test("same-origin reading, media and voice ignore stale bearer credentials", async () => {
  const f = fixture();
  const handler = createHandler(f.app, f.options);
  const agent = await f.service.createOrc("alpha", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
    worker: { model: "sol", effort: "medium" },
  });
  const bytes = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const images = await f.service.uploadImages(agent.id, "image-operation", "", [
    new File([bytes], "pixel.png", { type: "image/png" }),
  ]);
  for (const path of [
    `/api/read/messages?agent=${agent.id}`,
    `/api/images/${images[0].id}/original?agent=${agent.id}`,
    "/api/voice/capability",
  ]) {
    const response = await handler(
      new Request(f.origin + path, {
        headers: {
          Origin: f.origin,
          Authorization: "Bearer stale",
          "X-Grove-Peer": f.service.identity.id,
        },
      }),
    );
    expect(response.status).toBe(200);
    if (!path.startsWith("/api/images"))
      expect(await response.text()).not.toContain(
        "Peer authorization required",
      );
  }
});
test("foreign origins cannot use former peer credentials on socket or HTTP", async () => {
  const f = fixture();
  const handler = createHandler(f.app, f.options);
  const headers = {
    Origin: "https://foreign.invalid",
    "Sec-Fetch-Site": "same-origin",
    Authorization: `Bearer former-test-token`,
    "X-Grove-Peer": f.service.identity.id,
    "Sec-WebSocket-Protocol": `grove.v1, grove-auth.former-test-token`,
  };
  const result = createUpgrade(f.app, f.options)(
    new Request(f.origin + "/api/socket", { headers }),
    {
      upgrade: () => {
        throw new Error("foreign upgrade");
      },
    },
  );
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(403);
  for (const path of [
    "/api/read/unknown",
    "/api/images/unknown/missing",
    "/api/voice/capability",
    "/api/file-preview",
  ])
    expect(
      (await handler(new Request(f.origin + path, { headers }))).status,
    ).toBe(403);
});

test("existing instance identity and local MCP authorization survive peer deletion", async () => {
  const f = fixture();
  expect(f.service.identity.id).toBe("existing-instance");
  expect(readFileSync(join(f.directory, "hosts.json"), "utf8")).toBe(
    JSON.stringify({
      id: "existing-instance",
      credential: "former-test-token",
    }),
  );
  const handler = createHandler(f.app, f.options);
  expect((await handler(new Request(f.origin + "/api/mcp/info"))).status).toBe(
    401,
  );
  expect(
    (
      await handler(
        new Request(f.origin + "/api/mcp/info", {
          headers: { Authorization: "Bearer former-test-token" },
        }),
      )
    ).status,
  ).not.toBe(200);
  const agent = await f.app.createOrc("alpha");
  const token = f.runtime.agents.get(agent.id)!.token;
  expect(
    (
      await handler(
        new Request(f.origin + "/api/mcp/info", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      )
    ).status,
  ).toBe(200);
});
