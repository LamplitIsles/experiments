import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Database } from "bun:sqlite";
import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  SqliteStorage,
  CURRENT_SQLITE_SCHEMA_VERSION,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** Serializes the portable SDK database contract, including async transactions. */
export class BunDurableDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonlySnapshot = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly database: Database,
    private readonly deferred = false,
    private readonly checkpointOnClose = false,
  ) {}
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.closed) throw new Error("Durable storage is closed");
      return operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private executor(): SqliteExecutor {
    const db = this.database;
    return {
      async exec(sql) {
        db.exec(sql);
      },
      async run(sql, ...params) {
        db.query(sql).run(...params);
      },
      async get<T extends object>(sql: string, ...params: SqliteValue[]) {
        return (db.query(sql).get(...params) ?? undefined) as T | undefined;
      },
      async all<T extends object>(sql: string, ...params: SqliteValue[]) {
        return db.query(sql).all(...params) as T[];
      },
    };
  }
  exec(sql: string) {
    return this.enqueue(() => this.executor().exec(sql));
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor().run(sql, ...params));
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor().get<T>(sql, ...params));
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.executor().all<T>(sql, ...params));
  }
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.database.exec(
        this.readonlySnapshot
          ? "SAVEPOINT durable_read"
          : this.deferred
            ? "BEGIN"
            : "BEGIN IMMEDIATE",
      );
      let active = true;
      const executor = this.executor();
      const guarded = Object.fromEntries(
        Object.entries(executor).map(([name, operation]) => [
          name,
          (...args: unknown[]) => {
            if (!active) throw new Error("Durable transaction has ended");
            return Reflect.apply(operation, executor, args);
          },
        ]),
      ) as unknown as SqliteExecutor;
      try {
        const result = await callback(guarded);
        this.database.exec(
          this.readonlySnapshot ? "RELEASE durable_read" : "COMMIT",
        );
        return result;
      } catch (error) {
        try {
          this.database.exec(
            this.readonlySnapshot
              ? "ROLLBACK TO durable_read; RELEASE durable_read"
              : "ROLLBACK",
          );
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            "Durable rollback failed",
          );
        }
        throw error;
      } finally {
        active = false;
      }
    });
  }
  beginReadSnapshot() {
    return this.enqueue(() => {
      this.database.exec("BEGIN");
      this.database
        .query("SELECT version FROM native.durable_schema WHERE singleton=1")
        .get();
      this.readonlySnapshot = true;
    });
  }
  close() {
    return (this.closing ??= this.enqueue(async () => {
      try {
        if (this.checkpointOnClose)
          await writerJournalMode(this.database, "delete");
      } finally {
        this.closed = true;
        this.database.close();
      }
    }));
  }
}

/** Yield around journal transitions so a reader on this event loop can release. */
async function writerJournalMode(database: Database, mode: "wal" | "delete") {
  database.exec("PRAGMA busy_timeout=0");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const result = database
        .query(`PRAGMA journal_mode=${mode.toUpperCase()}`)
        .get() as { journal_mode: string };
      if (result.journal_mode !== mode)
        throw new Error("Pi storage journal transition could not finish");
      return;
    } catch (error) {
      if (
        (error as { code?: string }).code !== "SQLITE_BUSY" ||
        Date.now() >= deadline
      )
        throw error;
      await Bun.sleep(5);
    }
  }
}

export async function openPiStorage(path: string) {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON");
    await writerJournalMode(db, "wal");
    db.exec("PRAGMA busy_timeout=5000");
  } catch (error) {
    db.close();
    throw error;
  }
  const facade = new BunDurableDatabase(db, false, true);
  try {
    return await SqliteStorage.open(facade);
  } catch (error) {
    await facade.close();
    throw error;
  }
}

// Build an exact schema reference using the released public initializer, once.
const schemaSql =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };
let releasedSchema: Promise<SchemaRow[]> | undefined;
function expectedSchema() {
  return (releasedSchema ??= (async () => {
    const db = new Database(":memory:");
    const storage = await SqliteStorage.open(new BunDurableDatabase(db));
    try {
      return db.query(schemaSql).all() as SchemaRow[];
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  })());
}

/** Public queries on an attached readonly source, without copying native data.
 * Only the migration-version table lives in memory during SDK initialization.
 * Exact released schema is required; query_only then rejects all writes.
 */
export async function readPiStorage(path: string) {
  const expected = await expectedSchema();
  // A readonly SQLite WAL opener otherwise creates missing sidecars. Normal
  // shutdown leaves a rollback-mode DB; an interrupted writer retains its WAL.
  const header = Buffer.alloc(20),
    descriptor = openSync(path, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (
    header[18] === 2 &&
    (!existsSync(`${path}-wal`) || !existsSync(`${path}-shm`))
  )
    throw new Error(
      "Pi history WAL files are unavailable; inspect the original storage",
    );
  // SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI: URI mode=ro
  // must be interpreted by SQLite for the attached source, not as a filename.
  const db = new Database(":memory:", 0x00000002 | 0x00000004 | 0x00000040);
  const facade = new BunDurableDatabase(db, true);
  try {
    const source = pathToFileURL(path);
    source.searchParams.set("mode", "ro");
    db.query("ATTACH DATABASE ? AS native").run(source.href);
    await facade.beginReadSnapshot();
    const actual = db
      .query(schemaSql.replace("sqlite_master", "native.sqlite_master"))
      .all();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Pi history requires the exact released storage schema");
    const version = db
      .query("SELECT version FROM native.durable_schema WHERE singleton=1")
      .get() as { version: number } | null;
    if (version?.version !== CURRENT_SQLITE_SCHEMA_VERSION)
      throw new Error("Pi history storage schema is outdated or unsupported");
    const metadata = expected.find((row) => row.name === "durable_schema");
    if (!metadata) throw new Error("Pi storage schema metadata is unavailable");
    db.exec(metadata.sql);
    db.query(
      "INSERT INTO main.durable_schema(singleton,version) VALUES(1,?)",
    ).run(version.version);
    const storage = await SqliteStorage.open(facade);
    await facade.exec("PRAGMA query_only=ON");
    return storage;
  } catch (error) {
    await facade.close();
    throw error;
  }
}

/** OS-owned exclusive writer lease. SQLite releases it even after SIGKILL. */
export function acquirePiWriter(path: string) {
  const lease = new Database(`${path}.writer-lock`, {
    create: true,
    strict: true,
  });
  try {
    lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lease.close();
    throw new Error(
      "Pi session already has a writer. Close the other owner before retrying.",
    );
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      lease.exec("ROLLBACK");
    } finally {
      lease.close();
    }
  };
}
