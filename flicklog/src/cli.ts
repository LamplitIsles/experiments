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
} from "./core";
const exec = promisify(execFile);
const err = (x: unknown) => (x instanceof Error ? x.message : String(x));
function usage() {
  return "Usage: flicklog <setup|search|context> [arguments]\n\nsearch <query> [--all-projects]\ncontext <message-id>\n";
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
export async function run(
  argv = process.argv.slice(2),
  env: Env = process.env,
  cwd = process.cwd(),
  stdout: Pick<Console, "log"> = console,
  stderr: Pick<Console, "error"> = console,
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
    const client = meili(env);
    if (command === "search") {
      const all = args.includes("--all-projects"),
        query = args.filter((x) => x !== "--all-projects").join(" ");
      if (!query) throw new Error("search requires a query");
      await client.configure();
      const sync = await scan(env, (items) => client.add(items));
      stdout.log(
        JSON.stringify({
          sync,
          results: await client.search(query, normalizeCwd(cwd), all),
        }),
      );
      return 0;
    }
    if (command === "context") {
      if (args.length !== 1) throw new Error("context requires one message id");
      const hit = await client.get(args[0]);
      if (!hit) throw new Error("message not found");
      const include =
        env.FLICKLOG_CONTEXT_INCLUDE_TOOLS !== "false" &&
        env.FLICKLOG_CONTEXT_INCLUDE_TOOLS !== "0";
      const text = await readFile(hit.sourcePath, "utf8");
      stdout.log(
        JSON.stringify({
          messageId: hit.id,
          sourcePath: hit.sourcePath,
          sourceRecordIndex: hit.sourceRecordIndex,
          includeTools: include,
          items: extractContext(text, hit.sourceRecordIndex, include),
        }),
      );
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (e) {
    stderr.error(`flicklog: ${err(e)}`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await run();
