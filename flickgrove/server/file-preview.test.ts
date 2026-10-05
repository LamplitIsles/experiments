import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { FakeRuntime } from "./testing";
import { createHandler, createUpgrade } from "./http";
import { filePreview, PREVIEW_BYTES, PREVIEW_TTL } from "./file-preview";
import { localFile } from "../src/local-file";
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grove-preview-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const reports = join(cwd, "reports");
  await mkdir(reports, { recursive: true });
  await writeFile(join(reports, "图 表 (1).png"), "test-owned PNG bytes");
  await writeFile(
    join(reports, "page.html"),
    "<h1>Report</h1><script>document.title='interactive'</script>",
  );
  await writeFile(
    join(reports, "note.md"),
    "# Notes\n\n<script>window.unsafe=true</script>\n\n![Plot](图%20表%20(1).png)\n\n[unsafe](javascript:alert(1))",
  );
  await writeFile(join(cwd, "private.json"), "{}");
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: join(root, "state"),
    runtime,
    projects: async () => [{ alias: "test", name: "Test", path: cwd }],
    branches: { read: async () => null },
  });
  cleanup.push(() => app.dispose());
  const agent = await app.createOrc("test", {
    fast: false,
    orc: { model: "sol", effort: "medium" },
    worker: { model: "sol", effort: "medium" },
  });
  let origin = "";
  const service = new HostService(app, {
    directory: join(root, "peer"),
    origin: () => origin,
  });
  cleanup.push(() => service.dispose());
  const handler = createHandler(app, { service, origin: () => origin });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  origin = server.url.origin;
  cleanup.push(() => server.stop(true));
  const id = `${service.identity.id}:${agent.id}`;
  const headers = {
    Origin: origin,
    "X-Grove-Peer": service.identity.id,
    "Content-Type": "application/json",
  };
  const create = (href: string, patch = {}, head = {}) =>
    fetch(origin + "/api/file-preview", {
      method: "POST",
      headers: { ...headers, ...head },
      body: JSON.stringify({ agent: id, href, ...patch }),
    });
  return {
    root,
    cwd,
    reports,
    service,
    app,
    runtime,
    origin,
    id,
    headers,
    create,
  };
}
test("link classification preserves path characters, decodes once and leaves web/mail/anchors alone", () => {
  for (const href of [
    "https://example.com/a.png",
    "http://127.0.0.1:123/a.html",
    "mailto:a@b",
    "#a",
    "//remote/a.md",
    "file://remote/a.md",
    "javascript:alert(1)",
    "notes.pdf",
  ])
    expect(localFile(href)).toBeNull();
  expect(localFile("file:///tmp/%E5%9B%BE%20(1).png?x=1#plot")).toEqual({
    path: "/tmp/图 (1).png",
    fragment: "#plot",
    kind: "image",
  });
  expect(localFile("./a%2520b.md")?.path).toBe("./a%20b.md");
});
test("real HTTP creates only origin/auth/identity-bound grants and serves bounded resources without credentials", async () => {
  const f = await fixture();
  expect(
    (await f.create("reports/page.html", {}, { Origin: "null" })).status,
  ).toBe(403);
  expect(
    (await f.create("reports/page.html", {}, { Origin: "https://other.test" }))
      .status,
  ).toBe(401);
  expect(
    (await f.create("reports/page.html", {}, { "X-Grove-Peer": "wrong" }))
      .status,
  ).toBe(403);
  expect(
    (await f.create("reports/page.html", { agent: "other:agent" })).status,
  ).toBe(400);
  const response = await f.create(
    "reports/page.html",
    {},
    {
      Origin: "https://other.test",
      Authorization: `Bearer ${f.service.credential}`,
    },
  );
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.url).not.toContain(f.cwd);
  expect(value.url).not.toContain(f.service.credential);
  const resource = await fetch(value.url, { headers: { Origin: "null" } });
  expect(resource.status).toBe(200);
  expect(await resource.text()).toContain("interactive");
  for (const [key, expected] of Object.entries({
    "content-security-policy": "sandbox allow-scripts",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  }))
    expect(resource.headers.get(key)).toBe(expected);
  expect((await fetch(value.url, { method: "POST" })).status).toBe(405);
  expect(
    (await fetch(f.origin + "/api/identity", { headers: { Origin: "null" } }))
      .status,
  ).toBe(403);
  const denied = createUpgrade(f.app, {
    service: f.service,
    origin: () => f.origin,
  })(new Request(f.origin + "/api/socket", { headers: { Origin: "null" } }), {
    upgrade: () => {
      throw new Error("Must not upgrade");
    },
  });
  expect((denied as Response).status).toBe(401);
});
test("canonical cwd/root, traversal, symlinks, special files, supported types and per-file limits", async () => {
  const f = await fixture();
  await writeFile(join(f.reports, "a.css"), "body{}");
  await mkdir(join(f.reports, "sub"));
  await writeFile(join(f.reports, "sub", "nested.md"), "![Nested](plot.png)");
  await writeFile(join(f.reports, "sub", "plot.png"), "nested image");
  await writeFile(join(f.reports, "sub", "data.json"), '{"n":2}');
  await symlink(join(f.cwd, "private.json"), join(f.reports, "escape.json"));
  await symlink(f.reports, join(f.reports, "loop"));
  await writeFile(join(f.reports, "unsupported.txt"), "no");
  expect(spawnSync("mkfifo", [join(f.reports, "pipe.png")]).status).toBe(0);
  expect((await f.create("reports/pipe.png")).ok).toBe(false);
  await writeFile(
    join(f.reports, "huge.png"),
    new Uint8Array(PREVIEW_BYTES + 1),
  );
  for (const href of [
    "../outside.png",
    "reports/%2e%2e/private.md",
    "/tmp/no.png",
    "reports",
    "reports/unsupported.txt",
    "reports/huge.png",
  ])
    expect((await f.create(href)).ok).toBe(false);
  const { url } = await (await f.create("reports/page.html")).json();
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  expect((await fetch(base + "sub/data.json")).status).toBe(200);
  expect(await (await fetch(base + "sub/nested.md")).text()).toContain(
    base + "sub/plot.png",
  );
  for (const path of [
    "%2e%2e%2fprivate.json",
    "%252e%252e%252fprivate.json",
    "escape.json",
    "sub",
    "unsupported.txt",
    "huge.png",
  ])
    expect((await fetch(base + path)).ok).toBe(false);
  await rm(join(f.reports, "page.html"));
  await symlink(join(f.cwd, "private.json"), join(f.reports, "page.html"));
  expect((await fetch(url)).ok).toBe(false);
});
test("expiry, restart, other Peer, closed Worker and Markdown escaped rendering", async () => {
  const f = await fixture();
  const other = await fixture();
  let clock = 100;
  const preview = filePreview(f.service, () => clock);
  const create = () =>
    preview(
      new Request(f.origin + "/api/file-preview", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ agent: f.id, href: "reports/note.md" }),
      }),
      [f.origin],
    );
  const { url } = await (await create())!.json();
  const resource = await preview(new Request(url), [f.origin]);
  const html = await resource!.text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>window.unsafe");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("/preview/");
  expect((await fetch(url.replace(f.origin, other.origin))).status).toBe(410);
  expect(
    (await filePreview(f.service)(new Request(url), [f.origin]))!.status,
  ).toBe(410);
  clock += PREVIEW_TTL;
  expect((await preview(new Request(url), [f.origin]))!.status).toBe(410);
  const owner = f.runtime.agents.get(f.id.split(":")[1])!;
  const worker = (await f.app.tool(owner.token, "worker_start", {
    title: "Reporter",
    spec: "Read",
    message: "Read",
    project: "test",
  })) as { id: string };
  f.runtime.emit(worker.id, {
    type: "completed",
    turnId: f.app.detail(worker.id).turnId!,
    status: "completed",
  });
  await f.app.tool(owner.token, "worker_close", { workerId: worker.id });
  expect(
    (
      await f.create("reports/page.html", {
        agent: `${f.service.identity.id}:${worker.id}`,
      })
    ).ok,
  ).toBe(true);
});
test("bounded grants, preflight, stream intake and replaced resource roots", async () => {
  const f = await fixture();
  const request = (method: string, headers: Record<string, string>) =>
    fetch(f.origin + "/api/file-preview", { method, headers });
  const allowed = await request("OPTIONS", {
    Origin: "https://browser.test",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type,x-grove-peer",
  });
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
  expect(
    (
      await request("OPTIONS", {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("OPTIONS", {
        Origin: "https://browser.test",
        "Access-Control-Request-Method": "PUT",
      })
    ).status,
  ).toBe(405);
  const big = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(9000)));
      controller.close();
    },
  });
  expect(
    (
      await fetch(f.origin + "/api/file-preview", {
        method: "POST",
        headers: f.headers,
        body: big,
      })
    ).status,
  ).toBe(413);
  const prepared = await f.create("reports/page.html");
  expect(prepared.status).toBe(200);
  const { url } = await prepared.json();
  for (let i = 0; i < 256; i++)
    expect((await f.create("reports/page.html")).ok).toBe(true);
  expect((await fetch(url)).status).toBe(410);
  const { url: recent } = await (await f.create("reports/page.html")).json();
  await rm(f.reports, { recursive: true });
  await symlink(f.cwd, f.reports);
  expect((await fetch(recent)).ok).toBe(false);
});
