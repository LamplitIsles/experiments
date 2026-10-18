import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspace-store";
import { sessions } from "./schema";
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
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    try {
      return {
        agents: store.db
          .select({ id: sessions.id })
          .from(sessions)
          .all()
          .map((row) => store.byId(row.id)!),
        revision: 0,
      };
    } finally {
      store.close();
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
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    try {
      for (const agent of state.agents) store.track(agent, true);
      store.flush();
    } finally {
      store.close();
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
