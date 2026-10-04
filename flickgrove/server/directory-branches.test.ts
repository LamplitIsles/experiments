import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryBranches, readDirectoryBranch } from "./directory-branches";
import { fixtureGit, temporaryGit } from "./branch-testing";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}
function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "grove-branches-")),
  );
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("local Git reads current checkout, unborn, detached and independent worktree; missing paths and cancellation are failures", async () => {
  const root = fixture(),
    repo = join(root, "repo ; $(literal)"),
    tree = join(root, "worktree"),
    plain = join(root, "plain");
  mkdirSync(repo);
  mkdirSync(plain);
  fixtureGit(repo, "init", "--initial-branch", "unborn");
  const signal = new AbortController().signal;
  expect(await readDirectoryBranch(repo, signal)).toBe("unborn");
  fixtureGit(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  fixtureGit(repo, "worktree", "add", "-b", "tree-branch", tree);
  fixtureGit(repo, "switch", "-c", "new-branch");
  fixtureGit(repo, "tag", "new-branch");
  expect(await readDirectoryBranch(repo, signal)).toBe("new-branch");
  expect(await readDirectoryBranch(tree, signal)).toBe("tree-branch");
  fixtureGit(repo, "checkout", "--detach");
  expect(await readDirectoryBranch(repo, signal)).toBe(
    "@" + fixtureGit(repo, "rev-parse", "--short", "HEAD"),
  );
  expect(await readDirectoryBranch(plain, signal)).toBeNull();
  await expect(
    readDirectoryBranch(join(root, "missing"), signal),
  ).rejects.toThrow();
  await expect(
    readDirectoryBranch(repo, AbortSignal.abort()),
  ).rejects.toThrow();
});
test("dedup symlink/shared directories, promptly add, publish only changes, retain failure, clear nonrepo and stop last directory", async () => {
  const root = fixture(),
    repo = temporaryGit(join(root, "repo")),
    alias = join(root, "alias"),
    other = temporaryGit(join(root, "other"));
  symlinkSync(repo, alias);
  const calls = new Map<string, number>();
  let fail = false,
    publishes = 0;
  const poller = new DirectoryBranches(() => publishes++, {
    intervalMs: 25,
    read: async (path, signal) => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      if (fail) throw new Error("controlled timeout/permission failure");
      return readDirectoryBranch(path, signal);
    },
  });
  cleanups.push(() => poller.dispose());
  poller.update([repo, repo, alias]);
  await until(() => poller.value(alias) === "fixture-main");
  expect(calls.size).toBe(1);
  expect(publishes).toBe(1);
  await until(() => (calls.get(repo) ?? 0) >= 3);
  expect(publishes).toBe(1);
  poller.update([repo, alias, other]);
  await until(() => poller.value(other) === "fixture-main");
  expect(publishes).toBe(2);
  fail = true;
  fixtureGit(repo, "switch", "-c", "recovered");
  const before = calls.get(repo)!;
  await until(() => calls.get(repo)! > before);
  expect(poller.value(repo)).toBe("fixture-main");
  expect(publishes).toBe(2);
  fail = false;
  await until(() => poller.value(repo) === "recovered");
  expect(publishes).toBe(3);
  rmSync(join(repo, ".git"), { recursive: true });
  await until(() => poller.value(repo) === undefined);
  expect(publishes).toBe(4);
  poller.update([other]);
  const removed = calls.get(repo);
  await until(() => calls.get(other)! >= 3);
  expect(calls.get(repo)).toBe(removed);
  poller.update([]);
  const count = [...calls.values()].reduce((a, b) => a + b, 0);
  await Bun.sleep(80);
  expect([...calls.values()].reduce((a, b) => a + b, 0)).toBe(count);
});
test("bounded concurrency without overlapping polls; removed/re-added entries and dispose abort and discard late results", async () => {
  const root = fixture(),
    paths = ["a", "b", "c", "d"].map((p) => join(root, p));
  paths.forEach((p) => mkdirSync(p));
  const pending: {
    path: string;
    signal: AbortSignal;
    resolve: (v: string) => void;
  }[] = [];
  let active = 0,
    maximum = 0,
    publishes = 0;
  const poller = new DirectoryBranches(() => publishes++, {
    intervalMs: 10,
    read: async (path, signal) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await new Promise<string>((resolve) =>
          pending.push({ path, signal, resolve }),
        );
      } finally {
        active--;
      }
    },
  });
  cleanups.push(() => poller.dispose());
  poller.update(paths.slice(0, 3));
  await until(() => pending.length === 2);
  poller.update(paths);
  await Bun.sleep(35);
  expect(pending).toHaveLength(2);
  poller.update(paths.slice(1));
  expect(pending[0].signal.aborted).toBe(true);
  poller.update(paths);
  pending[0].resolve("obsolete");
  pending[1].resolve("current");
  await until(() => pending.length === 4);
  expect(poller.value(paths[0])).toBeUndefined();
  pending[2].resolve("current");
  pending[3].resolve("current");
  await until(() => pending.length === 5);
  pending[4].resolve("fresh");
  await until(() => poller.value(paths[0]) === "fresh");
  expect(maximum).toBe(2);
  expect(publishes).toBe(4);
  await until(() => pending.length >= 7);
  poller.dispose();
  expect(pending[5].signal.aborted).toBe(true);
  expect(pending[6].signal.aborted).toBe(true);
  pending[5].resolve("late");
  pending[6].resolve("late");
  await Bun.sleep(35);
  expect(publishes).toBe(4);
  expect(pending).toHaveLength(7);
});

test("polling follows symlink retarget without workspace mutation and retains failed resolution", async () => {
  const root = fixture(),
    left = temporaryGit(join(root, "left"), "left-branch"),
    right = temporaryGit(join(root, "right"), "right-branch"),
    alias = join(root, "alias");
  symlinkSync(left, alias);
  const calls: string[] = [];
  const observed: (string | undefined)[] = [];
  const poller = new DirectoryBranches(
    () => observed.push(poller.value(alias)),
    {
      intervalMs: 20,
      read: async (path, signal) => {
        calls.push(path);
        return readDirectoryBranch(path, signal);
      },
    },
  );
  cleanups.push(() => poller.dispose());
  poller.update([alias]);
  await until(() => poller.value(alias) === "left-branch");
  rmSync(alias);
  symlinkSync(right, alias);
  await until(() => calls.length >= 4);
  expect(poller.value(alias)).toBe("right-branch");
  expect(observed).toContain(undefined);
  const stopped = calls.filter((p) => p === left).length;
  rmSync(alias);
  await until(() => calls.length >= 6);
  expect(poller.value(alias)).toBe("right-branch");
  expect(calls.filter((p) => p === left).length).toBe(stopped);
  symlinkSync(right, alias);
  poller.update([alias, right]);
  expect(poller.shares(alias, right)).toBe(true);
});
