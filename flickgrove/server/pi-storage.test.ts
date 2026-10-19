import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { BunDurableDatabase, readPiStorage } from "./pi-storage";

test("portable Bun database serializes async transactions and preserves rollback before queued work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-storage-")),
    path = join(directory, "owned.sqlite");
  const database = new BunDurableDatabase(new Database(path));
  try {
    await database.exec("CREATE TABLE owned (id INTEGER PRIMARY KEY)");
    let release!: () => void, entered!: () => void, expired!: SqliteExecutor;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    const first = database.transaction(async (tx) => {
      expired = tx;
      await tx.run("INSERT INTO owned VALUES (?)", 1);
      entered();
      await gate;
      throw new Error("owned rollback");
    });
    await started;
    const second = database.transaction(async (tx) => {
      await tx.run("INSERT INTO owned VALUES (?)", 2);
    });
    release();
    await expect(first).rejects.toThrow("owned rollback");
    await second;
    expect(await database.all("SELECT id FROM owned")).toEqual([{ id: 2 }]);
    expect(() => expired.get("SELECT id FROM owned")).toThrow(
      "transaction has ended",
    );
    await database.close();
    await database.close();
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only native storage refuses missing files without creating storage or locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-missing-storage-"));
  try {
    await expect(
      readPiStorage(join(directory, "missing.sqlite")),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readonly public adapter refuses outdated schema and writes, preserving source files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-readonly-storage-"));
  const path = join(directory, "owned.sqlite");
  const { openPiStorage } = await import("./pi-storage");
  const { BACKGROUND_CONTEXT: ctx } =
    await import("@earendil-works/chord/context");
  let observer: ReturnType<typeof watch> | undefined;
  let reader: Awaited<ReturnType<typeof readPiStorage>> | undefined;
  try {
    const writer = await openPiStorage(path);
    await writer.close(ctx);
    const before = await Bun.file(path).arrayBuffer();
    const files = await readdir(directory);
    const mutations: string[] = [];
    observer = watch(directory, (_event, name) => mutations.push(String(name)));
    reader = await readPiStorage(path);
    expect(await readdir(directory)).toEqual(files);
    // A legitimate public write reaches SQLite and fails, rather than being ignored.
    await expect(reader.commit([], ctx)).rejects.toThrow("readonly");
    await reader.close(ctx);
    expect(await Bun.file(path).arrayBuffer()).toEqual(before);
    expect(await readdir(directory)).toEqual(files);
    await Bun.sleep(20);
    observer.close();
    expect(mutations).toEqual([]);
    const database = new Database(path);
    database.exec("UPDATE durable_schema SET version=0");
    database.close();
    const outdated = await Bun.file(path).arrayBuffer();
    await expect(readPiStorage(path)).rejects.toThrow("outdated");
    expect(await Bun.file(path).arrayBuffer()).toEqual(outdated);
    const changed = new Database(path);
    changed.exec(
      "UPDATE durable_schema SET version=1; CREATE TABLE unexpected(id INTEGER)",
    );
    changed.close();
    await expect(readPiStorage(path)).rejects.toThrow("exact released");
  } finally {
    observer?.close();
    await reader?.close(ctx);
    await rm(directory, { recursive: true, force: true });
  }
});

test("live WAL history is readonly and writer release waits asynchronously for its snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-live-wal-")),
    path = join(directory, "own.sqlite");
  const { openPiStorage } = await import("./pi-storage");
  const { BACKGROUND_CONTEXT: ctx } =
    await import("@earendil-works/chord/context");
  const writer = await openPiStorage(path);
  let reader: Awaited<ReturnType<typeof readPiStorage>> | undefined;
  const mutations: string[] = [];
  const observer = watch(directory, (_event, name) =>
    mutations.push(String(name)),
  );
  try {
    const files = await readdir(directory);
    reader = await readPiStorage(path);
    expect(await readdir(directory)).toEqual(files);
    await Bun.sleep(20);
    observer.close();
    expect(mutations).toEqual([]);
    let settled = false;
    const closing = writer.close(ctx).then(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false);
    await reader.close(ctx);
    reader = undefined;
    await closing;
    expect(await readdir(directory)).toEqual(["own.sqlite"]);
    const cold = await readPiStorage(path);
    expect(await readdir(directory)).toEqual(["own.sqlite"]);
    await cold.close(ctx);
    expect(await readdir(directory)).toEqual(["own.sqlite"]);
  } finally {
    observer.close();
    await reader?.close(ctx);
    await writer.close(ctx);
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing WAL sidecars are rejected without even transient readonly file mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-missing-wal-")),
    path = join(directory, "own.sqlite");
  const { openPiStorage } = await import("./pi-storage");
  const { BACKGROUND_CONTEXT: ctx } =
    await import("@earendil-works/chord/context");
  const writer = await openPiStorage(path);
  await writer.close(ctx);
  const native = new Database(path);
  native.exec("PRAGMA journal_mode=WAL");
  native.close();
  expect(await readdir(directory)).toEqual(["own.sqlite"]);
  const mutations: string[] = [];
  const observer = watch(directory, (_event, name) =>
    mutations.push(String(name)),
  );
  try {
    await expect(readPiStorage(path)).rejects.toThrow(
      "WAL files are unavailable",
    );
    expect(await readdir(directory)).toEqual(["own.sqlite"]);
    await Bun.sleep(20);
    expect(mutations).toEqual([]);
  } finally {
    observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("writer journal transition failure rejects release instead of reporting success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-failed-checkpoint-")),
    path = join(directory, "own.sqlite");
  const { openPiStorage } = await import("./pi-storage");
  const { BACKGROUND_CONTEXT: ctx } =
    await import("@earendil-works/chord/context");
  const writer = await openPiStorage(path),
    query = Database.prototype.query;
  const fault = spyOn(Database.prototype, "query").mockImplementation(function (
    this: Database,
    sql: string,
  ) {
    if (sql === "PRAGMA journal_mode=DELETE")
      throw new Error("owned checkpoint failure");
    return query.call(this, sql);
  } as typeof query);
  try {
    await expect(writer.close(ctx)).rejects.toThrow("owned checkpoint failure");
  } finally {
    fault.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorized writer startup yields to a cold reader before enabling WAL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-reader-startup-")),
    path = join(directory, "own.sqlite");
  const { openPiStorage } = await import("./pi-storage");
  const { BACKGROUND_CONTEXT: ctx } =
    await import("@earendil-works/chord/context");
  await (await openPiStorage(path)).close(ctx);
  const reader = await readPiStorage(path);
  let writer: Awaited<ReturnType<typeof openPiStorage>> | undefined;
  const starting = openPiStorage(path).then((value) => {
    writer = value;
    return value;
  });
  try {
    await Bun.sleep(30);
    expect(writer).toBeUndefined();
    await reader.close(ctx);
    await starting;
  } finally {
    await reader.close(ctx);
    await (await starting).close(ctx);
    await rm(directory, { recursive: true, force: true });
  }
});
