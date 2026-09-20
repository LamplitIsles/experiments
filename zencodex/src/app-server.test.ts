import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./app-server";

test("published client connects to the test-owned CFL stdio fake", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-client-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  try {
    const client = await connect(cwd, fake);
    expect(await client.sessions()).toEqual([]);
    await client.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
