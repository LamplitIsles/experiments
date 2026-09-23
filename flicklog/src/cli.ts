#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractContext,
  meili,
  normalizeCwd,
  prepareSetup,
  scan,
  type Env,
  type TimeWindow,
} from "./core";
import { hostname } from "node:os";
import { SingleBar, Presets } from "cli-progress";
const exec = promisify(execFile);
const err = (x: unknown) => (x instanceof Error ? x.message : String(x));
function usage() {
  return "Usage: flicklog <setup|ingest|search|get|context> [arguments]\n\ningest\nsearch <query> [--all-projects] [--limit <1-20>] [--since <positive-integer><s|m|h|d|w> | --from <RFC3339> [--until <RFC3339>]]\nget <record-id>\ncontext <record-id> [--include-tools]\n";
}
const durationUnits = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const timestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function durationSeconds(value: string): number {
  const match = /^([1-9]\d*)([smhdw])$/.exec(value);
  if (!match)
    throw new Error(
      "search --since must be a positive integer duration using s, m, h, d, or w",
    );
  const seconds =
    Number(match[1]) * durationUnits[match[2] as keyof typeof durationUnits];
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error(
      "search --since must be a positive integer duration using s, m, h, d, or w",
    );
  return seconds;
}
function timestampSeconds(value: string): number {
  const match = timestamp.exec(value);
  if (!match) throw new Error("search time bounds must be RFC3339 timestamps");
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const zone = match[7];
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const [offsetHours, offsetMinutes] =
    zone === "Z" ? [0, 0] : zone.slice(1).split(":").map(Number);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    throw new Error("search time bounds must be RFC3339 timestamps");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error("search time bounds must be RFC3339 timestamps");
  return Math.floor(milliseconds / 1000);
}
function searchArguments(args: string[]) {
  let all = false;
  let limit = 5;
  let hasLimit = false;
  let since: number | undefined;
  let from: number | undefined;
  let until: number | undefined;
  const timeFlags = new Set<string>();
  const query: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--all-projects") {
      all = true;
      continue;
    }
    if (argument === "--limit") {
      if (index + 1 === args.length || hasLimit)
        throw new Error("search --limit requires one integer from 1 to 20");
      const value = args[++index];
      if (!/^[1-9]\d*$/.test(value))
        throw new Error("search --limit must be an integer from 1 to 20");
      limit = Number(value);
      if (limit > 20)
        throw new Error("search --limit must be an integer from 1 to 20");
      hasLimit = true;
      continue;
    }
    if (
      argument === "--since" ||
      argument === "--from" ||
      argument === "--until"
    ) {
      if (timeFlags.has(argument))
        throw new Error(`search ${argument} may only be provided once`);
      timeFlags.add(argument);
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`search ${argument} requires a value`);
      if (argument === "--since") since = durationSeconds(value);
      else if (argument === "--from") from = timestampSeconds(value);
      else until = timestampSeconds(value);
      continue;
    }
    if (argument.startsWith("--"))
      throw new Error(`unknown search option: ${argument}`);
    query.push(argument);
  }
  if (!query.length) throw new Error("search requires a query");
  if (since !== undefined && (from !== undefined || until !== undefined))
    throw new Error("search --since cannot be combined with --from or --until");
  if (until !== undefined && from === undefined)
    throw new Error("search --until requires --from");
  if (from !== undefined && until !== undefined && from >= until)
    throw new Error("search --from must be earlier than --until");
  const now = Math.floor(Date.now() / 1000);
  const timeWindow: TimeWindow | undefined =
    since === undefined
      ? from === undefined
        ? undefined
        : { from, ...(until === undefined ? {} : { until }) }
      : { from: now - since, until: now };
  return { all, limit, query: query.join(" "), timeWindow };
}
async function binary() {
  for (const p of [
    "/opt/homebrew/bin/meilisearch",
    "/usr/local/bin/meilisearch",
  ]) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  throw new Error("cannot find Homebrew meilisearch executable");
}
type Terminal = NodeJS.WritableStream & { isTTY?: boolean };
async function ingest(
  env: Env,
  client: ReturnType<typeof meili>,
  terminal: Terminal,
) {
  await client.configure();
  let progress: SingleBar | undefined;
  let indexed = 0;
  let completed = false;
  try {
    const sync = await scan(env, (items) => client.add(items), {
      plan(pending) {
        if (!pending || !terminal.isTTY) return;
        progress = new SingleBar(
          {
            format:
              "Ingesting Codex sessions |{bar}| {value}/{total} logs | {indexed} records {status}",
            stream: terminal,
            clearOnComplete: false,
            hideCursor: true,
          },
          Presets.shades_classic,
        );
        progress.start(pending, 0, { indexed, status: "" });
      },
      source(count) {
        indexed += count;
        progress?.increment({ indexed, status: "" });
      },
    });
    completed = true;
    return sync;
  } finally {
    if (progress?.isActive) {
      if (completed) progress.update({ indexed, status: "complete" });
      progress.stop();
    }
  }
}
export async function run(
  argv = process.argv.slice(2),
  env: Env = process.env,
  cwd = process.cwd(),
  stdout: Pick<Console, "log"> = console,
  stderr: Pick<Console, "error"> = console,
  terminal: Terminal = process.stderr,
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (command === "--help" || command === "-h" || !command) {
      stdout.log(usage());
      return 0;
    }
    if (command === "setup") {
      if (env.FLICKLOG_MEILI_URL) {
        stdout.log(
          JSON.stringify({ managed: false, url: env.FLICKLOG_MEILI_URL }),
        );
        return 0;
      }
      if (process.platform !== "darwin")
        throw new Error("local setup is supported on macOS only");
      const p = await prepareSetup(env, await binary());
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("cannot determine launchctl user");
      await exec("launchctl", ["bootout", `gui/${uid}`, p.plist]).catch(
        () => undefined,
      );
      await exec("launchctl", ["bootstrap", `gui/${uid}`, p.plist]);
      let healthy = false;
      for (let n = 0; n < 50; n++) {
        try {
          const r = await fetch(`http://127.0.0.1:${p.port}/health`);
          if (r.ok) {
            healthy = true;
            break;
          }
        } catch {}
        await Bun.sleep(100);
      }
      if (!healthy)
        throw new Error("FlickLog Meilisearch did not become healthy");
      await meili({
        ...env,
        FLICKLOG_MEILI_URL: `http://127.0.0.1:${p.port}`,
        FLICKLOG_MEILI_KEY: await readFile(p.key, "utf8"),
      }).configure();
      stdout.log(
        JSON.stringify({
          managed: true,
          url: `http://127.0.0.1:${p.port}`,
          plist: p.plist,
        }),
      );
      return 0;
    }
    if (command === "ingest") {
      if (args.length) throw new Error("ingest does not accept arguments");
      const client = meili(env);
      stdout.log(JSON.stringify(await ingest(env, client, terminal)));
      return 0;
    }
    if (command === "search") {
      const { all, limit, query, timeWindow } = searchArguments(args);
      const client = meili(env);
      const sync = await ingest(env, client, terminal);
      stdout.log(
        JSON.stringify({
          sync,
          results: await client.search(
            query,
            normalizeCwd(cwd),
            all,
            limit,
            timeWindow,
          ),
        }),
      );
      return 0;
    }
    if (command === "context") {
      const include = args.includes("--include-tools");
      const ids = args.filter((arg) => arg !== "--include-tools");
      if (ids.length !== 1)
        throw new Error(
          "context requires one record id and optional --include-tools",
        );
      const client = meili(env);
      const hit = await client.get(ids[0]);
      if (!hit) throw new Error("message not found");
      if (hit.deviceId !== hostname()) throw new Error("message not found");
      const text = await readFile(hit.sourcePath, "utf8");
      const context = extractContext(text, hit.sourceRecordIndex, include);
      stdout.log(
        JSON.stringify({
          messageId: hit.id,
          targetSourceRecordIndex: hit.sourceRecordIndex,
          includeTools: include,
          truncated: context.truncated,
          items: context.items,
        }),
      );
      return 0;
    }
    if (command === "get") {
      if (args.length !== 1) throw new Error("get requires one record id");
      const client = meili(env);
      const hit = await client.get(args[0]);
      if (!hit || hit.deviceId !== hostname())
        throw new Error("record not found");
      const {
        sourceId: _sourceId,
        sourcePath: _sourcePath,
        sourceRecordIndex: _sourceRecordIndex,
        deviceId: _deviceId,
        agent: _agent,
        ...record
      } = hit;
      stdout.log(JSON.stringify(record));
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (e) {
    stderr.error(`flicklog: ${err(e)}`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await run();
