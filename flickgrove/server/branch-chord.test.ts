import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { FakeRuntime } from "./testing";
import { fixtureGit, temporaryGit } from "./branch-testing";
import { readDirectoryBranch } from "./directory-branches";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket } from "./chord-socket";
import { socketWithHeaders } from "./socket-testing";
import { openGrove } from "../src/chord-client";
import type { View } from "../src/chord-contract";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}
function peer(root: string, name: string) {
  const repo = temporaryGit(join(root, name, "repo"));
  const same = temporaryGit(join(root, name, "same-branch"));
  const alias = join(root, name, "symlink");
  symlinkSync(repo, alias);
  const tree = join(root, name, "tree");
  fixtureGit(repo, "worktree", "add", "-b", "worktree-branch", tree);
  const projects = [repo, alias, same, tree].map((path, i) => ({
    alias: ["alpha", "alias", "same", "tree"][i],
    name: "Alpha",
    path,
  }));
  const runtime = new FakeRuntime();
  let fail = false;
  const reads = new Map<string, number>();
  const directory = join(root, name, "state");
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => projects,
    branches: {
      intervalMs: 30,
      read: async (path, signal) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        if (fail) throw new Error("controlled permission failure");
        return readDirectoryBranch(path, signal);
      },
    },
  });
  let origin = "";
  const service = new HostService(app, {
    directory,
    name,
    origin: () => origin,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch(req, server) {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, server);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => {
    service.dispose();
    server.stop(true);
    app.dispose();
  });
  return {
    app,
    runtime,
    repo,
    tree,
    reads,
    directory,
    service,
    set fail(value: boolean) {
      fail = value;
    },
    async client(changed: (view: View) => void) {
      const client = await openGrove(
        socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
          Origin: origin,
        }),
        changed,
        () => {},
      );
      cleanups.push(() => client.close());
      return client;
    },
  };
}
test("execution Peer branch updates traverse real Chord, isolate same-name peers and preserve selections/messages through failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grove-branch-chord-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const left = peer(root, "Left"),
    right = peer(root, "Right");
  const a = await left.app.createOrc("alpha"),
    shared = await left.app.createOrc("alias"),
    b = await right.app.createOrc("alpha");
  const aid = qualify(left.service.identity.id, a.id),
    bid = qualify(right.service.identity.id, b.id);
  let l: View | undefined, r: View | undefined;
  const lc = await left.client((v) => (l = v)),
    rc = await right.client((v) => (r = v));
  await lc.call("select", { ids: [aid] });
  await rc.call("select", { ids: [bid] });
  await until(
    () =>
      l?.details[aid]?.directoryBranch === "fixture-main" &&
      r?.details[bid]?.directoryBranch === "fixture-main",
  );
  expect(left.reads.size).toBe(1);
  const revision = l!.snapshot.revision;
  await Bun.sleep(120);
  expect(l!.snapshot.revision).toBe(revision);
  fixtureGit(left.repo, "switch", "-c", "left-only");
  await until(
    () =>
      l?.snapshot.agents.every((a) => a.directoryBranch === "left-only") ===
      true,
  );
  expect(l!.details[aid].directoryBranch).toBe("left-only");
  expect(r!.details[bid].directoryBranch).toBe("fixture-main");
  expect(Object.keys(l!.details)).toEqual([aid]);
  expect(Object.keys(r!.details)).toEqual([bid]);
  expect(left.app.detail(shared.id).directoryBranch).toBe("left-only");
  left.fail = true;
  fixtureGit(left.repo, "switch", "-c", "after-failure");
  const reads = left.reads.get(left.repo)!;
  await until(() => left.reads.get(left.repo)! > reads);
  expect(l!.details[aid].directoryBranch).toBe("left-only");
  await lc.call("send", {
    id: aid,
    text: "business still available",
    operationId: "send-once",
  });
  expect(
    left.runtime.inputs.filter((i) => i.text === "business still available"),
  ).toHaveLength(1);
  left.fail = false;
  await until(() => l?.details[aid]?.directoryBranch === "after-failure");
  expect(Object.keys(l!.details)).toEqual([aid]);
  const token = left.runtime.agents.get(a.id)!.token;
  await left.app.tool(token, "worker_start", {
    project: "alias",
    title: "Shared",
    spec: "fixture",
    message: "work",
  });
  await left.app.tool(token, "worker_start", {
    project: "same",
    title: "Different directory same branch",
    spec: "fixture",
    message: "work",
  });
  await left.app.tool(token, "worker_start", {
    project: "tree",
    title: "Worktree",
    spec: "fixture",
    message: "work",
  });
  await until(
    () =>
      l?.snapshot.agents.find((a) => a.title === "Worktree")
        ?.directoryBranch === "worktree-branch",
  );
  expect(
    l!.snapshot.agents.find((a) => a.title === "Shared")!.directoryBranch,
  ).toBeUndefined();
  expect(
    l!.snapshot.agents.find(
      (a) => a.title === "Different directory same branch",
    )!.directoryBranch,
  ).toBe("fixture-main");
  fixtureGit(left.repo, "switch", "fixture-main");
  await until(() => l?.details[aid]?.directoryBranch === "fixture-main");
  expect(
    l!.snapshot.agents.find(
      (a) => a.title === "Different directory same branch",
    )!.directoryBranch,
  ).toBe("fixture-main");
  const db = new Database(join(left.directory, "workspace.sqlite"), {
    readonly: true,
  });
  const stored = db.query("SELECT value FROM workspace WHERE id=1").get() as {
    value: string;
  };
  db.close();
  expect(
    JSON.parse(stored.value).agents.every(
      (a: object) => !("directoryBranch" in a),
    ),
  ).toBe(true);
  const closed = await right.app.createOrc("tree");
  await until(
    () => right.app.detail(closed.id).directoryBranch === "worktree-branch",
  );
  await right.app.closeTree(closed.id);
  const stopped = right.reads.get(right.tree);
  await Bun.sleep(100);
  expect(right.reads.get(right.tree)).toBe(stopped);
  fixtureGit(left.repo, "checkout", "--detach");
  await until(() => l?.details[aid]?.directoryBranch?.startsWith("@") === true);
  rmSync(join(left.repo, ".git"), { recursive: true });
  await until(() => l?.details[aid]?.directoryBranch === undefined);
  expect(r!.details[bid].directoryBranch).toBe("fixture-main");
});
