import sharp from "sharp";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { createHandler, createUpgrade, servePeer } from "./http";
import { FakeRuntime, fixtureProjects } from "./testing";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture(ownedProject = false) {
  const directory = mkdtempSync(join(tmpdir(), "grove-single-host-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () =>
      ownedProject
        ? fixtureProjects.map((project) => ({ ...project, path: directory }))
        : fixtureProjects,
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

// The TLS terminator preserves Host; Bun sees HTTP and browser GET omits Origin.
test("proxy HTTPS same-origin capability reaches actual business response", async () => {
  const f = fixture();
  const origin = "https://flickgrove.fixture.invalid";
  const server = servePeer(f.app, {
    ...f.options,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.stop(true));
  const response = await fetch(new URL("/api/voice/capability", server.url), {
    headers: {
      Host: new URL(origin).host,
      "Sec-Fetch-Site": "same-origin",
      "X-Grove-Peer": f.service.identity.id,
    },
  });
  const body = await response.json();
  console.log("proxy capability", response.status, JSON.stringify(body));
  expect(response.status).toBe(200);
  expect(body).toEqual({ available: false, reason: "config_unavailable" });
});

test("proxy discriminating admission probes", async () => {
  const f = fixture();
  const origin = "https://flickgrove.fixture.invalid";
  let configured = origin;
  const server = servePeer(f.app, {
    ...f.options,
    origin: () => configured,
    localOrigin: () => server.url.origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.stop(true));
  const headers = {
    Host: new URL(origin).host,
    "Sec-Fetch-Site": "same-origin",
    "X-Grove-Peer": f.service.identity.id,
  };
  const probe = async (label: string, patch = {}) => {
    const response = await fetch(new URL("/api/voice/capability", server.url), {
      headers: { ...headers, ...patch },
    });
    console.log(label, response.status, JSON.stringify(await response.json()));
    return response.status;
  };
  expect(await probe("explicit HTTPS Origin", { Origin: origin })).toBe(200);
  expect(
    await probe("wrong Host", { Origin: origin, Host: "foreign.invalid" }),
  ).toBe(403);
  expect(
    await probe("wrong identity", { Origin: origin, "X-Grove-Peer": "wrong" }),
  ).toBe(403);
  configured = origin.replace("https:", "http:");
  expect(await probe("HTTP configured same Host")).toBe(200);
  expect(await probe("direct local HTTP", { Host: server.url.host })).toBe(200);
});

test("proxy browser admission covers reading, media, preview and hostile evidence", async () => {
  const f = fixture(true);
  const origin = "https://flickgrove.fixture.invalid";
  const agent = await f.service.createOrc("alpha", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
    worker: { model: "sol", effort: "medium" },
  });
  writeFileSync(
    join(f.directory, "report.md"),
    "# Fixture\n\n[Other](other.md)",
  );
  writeFileSync(join(f.directory, "other.md"), "# Other");
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const images = await f.service.uploadImages(agent.id, "fixture-image", "", [
    new File([bytes], "pixel.png", { type: "image/png" }),
  ]);
  const server = servePeer(f.app, {
    ...f.options,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.stop(true));
  const base = {
    Host: new URL(origin).host,
    "Sec-Fetch-Site": "same-origin",
    "X-Grove-Peer": f.service.identity.id,
  };
  const paths = [
    `/api/read/messages?agent=${agent.id}`,
    `/api/images/${images[0].id}/original?agent=${agent.id}`,
    "/api/voice/capability",
    "/api/file-preview",
  ];
  const call = (path: string, headers: Record<string, string>) =>
    fetch(new URL(path, server.url), {
      headers,
      ...(path === "/api/file-preview"
        ? {
            method: "POST",
            body: JSON.stringify({
              agent: agent.id,
              href: join(f.directory, "report.md"),
            }),
          }
        : {}),
    });
  for (const path of paths) {
    const response = await call(path, base);
    expect(response.status).toBe(200);
    if (path === "/api/file-preview") {
      const grant = await response.json();
      expect(grant.url.startsWith(origin + "/preview/")).toBe(true);
      const resource = await fetch(
        new URL(new URL(grant.url).pathname, server.url),
        { headers: { Host: base.Host, Origin: "null" } },
      );
      expect(resource.status).toBe(200);
      expect(resource.headers.get("Content-Security-Policy")).toBe(
        "sandbox allow-scripts",
      );
      const html = await resource.text();
      expect(html).toContain("Other");
      expect(html).not.toContain("http://flickgrove.fixture.invalid");
      const href = /href="([^"]+other.md)"/.exec(html)![1];
      const linked = await fetch(
        new URL(new URL(href, grant.url).pathname, server.url),
        { headers: { Host: base.Host } },
      );
      expect(linked.status).toBe(200);
      expect(await linked.text()).toContain("Other");
    } else if (path.startsWith("/api/images")) {
      const metadata = await sharp(
        Buffer.from(await response.arrayBuffer()),
      ).metadata();
      expect(metadata.width).toBe(1);
      expect(metadata.height).toBe(1);
    } else {
      expect(await response.json()).toBeDefined();
    }
    const hostile: Record<string, string>[] = [
      { ...base, Origin: "https://foreign.invalid" },
      { ...base, Origin: "null" },
      { ...base, Origin: "garbage" },
      { ...base, Origin: "" },
      { ...base, Origin: origin.replace("https:", "http:") },
      { ...base, Origin: origin + "/path" },
      { ...base, Host: "foreign.invalid" },
      { ...base, Host: base.Host + ":444" },
      { ...base, "Sec-Fetch-Site": "cross-site" },
      { ...base, Origin: origin, "Sec-Fetch-Site": "cross-site" },
      { ...base, "Sec-Fetch-Site": "same-site" },
      { ...base, "Sec-Fetch-Site": "none" },
      { Host: base.Host, "X-Grove-Peer": base["X-Grove-Peer"] },
      {
        Host: "foreign.invalid",
        "X-Grove-Peer": base["X-Grove-Peer"],
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Host": base.Host,
        "X-Forwarded-Proto": "https",
        Forwarded: `host=${base.Host};proto=https`,
      },
      {
        Host: base.Host,
        "X-Grove-Peer": base["X-Grove-Peer"],
        "X-Forwarded-Host": base.Host,
        "X-Forwarded-Proto": "https",
      },
      { ...base, "X-Grove-Peer": "wrong" },
    ];
    for (const headers of hostile)
      expect((await call(path, headers)).status).toBe(403);
    expect((await call(path, { ...base, Origin: origin })).status).toBe(200);
  }
  const upgrade = createUpgrade(f.app, { ...f.options, origin: () => origin });
  for (const headers of [
    { ...base },
    { ...base, Origin: "null" },
    { ...base, Origin: "https://foreign.invalid" },
    { ...base, Origin: origin, "Sec-Fetch-Site": "cross-site" },
  ]) {
    const result = upgrade(
      new Request("http://" + base.Host + "/api/socket", { headers }),
      {
        upgrade: () => {
          throw new Error("unexpected upgrade");
        },
      },
    );
    expect((result as Response).status).toBe(403);
  }
  expect(
    upgrade(
      new Request("http://" + base.Host + "/api/socket", {
        headers: { ...base, Origin: origin },
      }),
      { upgrade: () => true },
    ),
  ).toBe(true);
});
