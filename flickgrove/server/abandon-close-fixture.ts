import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Workspace } from "./workspace";
import { FakeRuntime } from "./testing";
import type { RuntimeAgent } from "./runtime";

// Every persisted record and runtime in this fixture belongs to this temporary root.
export async function abandonFixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-abandon-"));
  const runtime = new FakeRuntime();
  const projects = [{ alias: "fixture", name: "Fixture", path: directory }];
  const options = { directory, runtime, projects: async () => projects };
  let app = new Workspace(options);
  runtime.sendOverride = async () => {
    throw new Error("fixture: original admission unknown");
  };
  const target = await app.createOrc("fixture");
  await app.send(target.id, "Original unknown input", "original-unknown");
  const other = await app.createOrc("fixture");
  function stored() {
    const db = new Database(join(directory, "workspace.sqlite"));
    try {
      return JSON.parse(
        (
          db.query("SELECT value FROM workspace WHERE id=1").get() as {
            value: string;
          }
        ).value,
      ) as { agents: RuntimeAgent[]; revision: number };
    } finally {
      db.close();
    }
  }
  function reload(
    edit?: (agent: RuntimeAgent, agents: RuntimeAgent[]) => void,
  ) {
    app.dispose();
    const state = stored();
    edit?.(
      state.agents.find((a) => a.id === target.id)!,
      state.agents,
    );
    const db = new Database(join(directory, "workspace.sqlite"));
    try {
      db.query("UPDATE workspace SET value=? WHERE id=1").run(
        JSON.stringify(state),
      );
    } finally {
      db.close();
    }
    app = new Workspace(options);
    return app;
  }
  return {
    get app() {
      return app;
    },
    runtime,
    target,
    other,
    directory,
    stored,
    reload,
    cleanup() {
      app.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
