import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openPiStorage } from "./pi-storage";
import { PiMetadata } from "./pi-documents";
import { PiRuntime } from "./pi";

test("cold history list reads metadata pages and selected history reads a bounded page without database copies", async () => {
  if (!process.env.GROVE_HISTORY_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-history-"));
    const child = Bun.spawn(
      [process.execPath, "test", import.meta.path, "--timeout", "30000"],
      {
        env: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          GROVE_HISTORY_CHILD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      console.log(out);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(process.env.HOME!, "repo"),
    directory = join(agentDir, "grove-durable");
  await mkdir(directory, { recursive: true });
  await mkdir(cwd);
  const ids: string[] = [];
  let totalBytes = 0,
    bigBytes = 0;
  for (let i = 0; i < 12; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const path = join(directory, `${id}.sqlite`),
      storage = await openPiStorage(path),
      session = createSession(storage);
    try {
      await storage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        ctx,
      );
      await session.commit(async (tx) => {
        const metadata = await tx.doc(PiMetadata);
        Object.assign(metadata, {
          id,
          agentId: id,
          role: "orc",
          ownerId: id,
          cwd,
          title: `owned ${i}`,
        });
        await tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind: "grove.input",
          model: [{ role: "user", content: "first preview", timestamp: 0 }],
        });
        for (let j = 0; j < (i === 0 ? 1024 : 40); j++)
          await tx.appendEntry(ROOT_CONVERSATION_ID, {
            kind: "grove.input",
            model: [
              { role: "user", content: "x".repeat(65536), timestamp: j + 1 },
            ],
          });
      }, ctx);
    } finally {
      await session.close(ctx);
    }
    const size = (await stat(path)).size;
    totalBytes += size;
    if (i === 0) bigBytes = size;
  }
  const runtime = new PiRuntime({ agentDir, tool: async () => ({}) });
  const copies = spyOn(Database.prototype, "serialize");
  const io = async () =>
    Object.fromEntries(
      (await readFile("/proc/self/io", "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split(":");
          return [key, Number(value)];
        }),
    );
  try {
    const before = await io(),
      listed = await runtime.history(cwd),
      afterList = await io();
    expect(listed.sessions).toHaveLength(12);
    const selected = await runtime.historyMessages(ids[0]!),
      afterSelected = await io();
    expect(selected.messages).toHaveLength(100);
    const listBytes = afterList.rchar! - before.rchar!,
      selectedBytes = afterSelected.rchar! - afterList.rchar!;
    const measurements = {
      databases: 12,
      totalBytes,
      bigBytes,
      list: {
        readCalls: afterList.syscr! - before.syscr!,
        readBytes: listBytes,
      },
      selected: {
        readCalls: afterSelected.syscr! - afterList.syscr!,
        readBytes: selectedBytes,
      },
      wholeDatabaseCopies: copies.mock.calls.length,
    };
    console.log(JSON.stringify(measurements));
    expect(copies).not.toHaveBeenCalled();
    expect(listBytes).toBeLessThan(totalBytes / 8);
    expect(selectedBytes).toBeLessThan(bigBytes / 3);
  } finally {
    copies.mockRestore();
  }
}, 40000);
