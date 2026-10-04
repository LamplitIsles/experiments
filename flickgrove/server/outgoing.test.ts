import { expect, test } from "bun:test";
import { compileModule } from "svelte/compiler";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authoritative delivery replaces an obsolete pending or missing receipt classification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-outgoing-"));
  try {
    const sourcePath = import.meta.dir + "/../src/outgoing.svelte.ts";
    const source = new Bun.Transpiler({ loader: "ts" })
      .transformSync(readFileSync(sourcePath, "utf8"))
      .replace(
        '"./chord-contract"',
        JSON.stringify(import.meta.dir + "/../src/chord-contract.ts"),
      );
    const compiled = compileModule(source, {
      filename: sourcePath,
      generate: "client",
    })
      .js.code.replaceAll(
        'from "zod"',
        `from ${JSON.stringify(import.meta.resolve("zod"))}`,
      )
      .replaceAll(
        '"svelte/internal/client"',
        JSON.stringify(import.meta.resolve("svelte/internal/client")),
      );
    writeFileSync(join(directory, "outgoing.mjs"), compiled);
    writeFileSync(
      join(directory, "check.ts"),
      `
      import { strict as assert } from "node:assert";
      const records = new Map();
      Object.assign(globalThis, {location: {origin: "http://fixture.invalid"}, window: {addEventListener() {}}, localStorage: {
        getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key)
      }});
      const {addOutgoing, acceptReceipt, observeOutgoing, outgoing} = await import("./outgoing.mjs");
      addOutgoing("peer:orc", "draft", "op");
      acceptReceipt("peer:orc", {operationId: "op", state: "pending", turnId: null, error: null});
      const detail = status => ({id: "peer:orc", messages: [], deliveries: [{id: "op", status}]});
      observeOutgoing(detail("uncertain"));
      assert.equal(outgoing.entries[0].status, "uncertain");
      assert.equal(outgoing.entries[0].receiptState, undefined);
      acceptReceipt("peer:orc", {operationId: "op", state: "missing", turnId: null, error: null});
      observeOutgoing(detail("queued"));
      assert.equal(outgoing.entries[0].receiptState, "pending");
      observeOutgoing(detail("sent"));
      assert.equal(outgoing.entries[0].status, "sent");
      assert.equal(outgoing.entries[0].receiptState, undefined);
    `,
    );
    const child = Bun.spawn([process.execPath, join(directory, "check.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
