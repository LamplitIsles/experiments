import { expect, test } from "bun:test";
import type { Project } from "../src/contracts";
import {
  mergeProjectCatalogue,
  projectReference,
} from "../src/project-identity";

const local: Project = {
  alias: "same",
  name: "Current",
  path: "/owned/checkout",
};
const remote: Project = {
  ...local,
  environment: { id: "mac", name: "Mac", target: "original" },
};
const saved = (project: Project, id = "old"): Project => ({
  ...project,
  name: "Saved",
  historyRef: `@saved:${id}`,
});

test("current registration wins for identical local and remote saved identities", () => {
  const boundLocal = {
    ...local,
    environment: { id: "local", name: "This machine", target: "local" },
  };
  for (const [live, history] of [
    [local, boundLocal],
    [boundLocal, local],
    [remote, remote],
  ]) {
    const result = mergeProjectCatalogue([live], [saved(history)]);
    expect(result).toEqual([live]);
    expect(result[0]).toBe(live);
    expect(projectReference(result[0])).toBe(
      live === remote ? "mac:same" : "same",
    );
  }
});

test("different aliases, paths, environments and captured targets retain saved references", () => {
  const histories = [
    { ...remote, alias: "other" },
    { ...remote, path: "/owned/other" },
    { ...remote, environment: { ...remote.environment!, id: "other" } },
    {
      ...remote,
      environment: { ...remote.environment!, target: "replacement" },
    },
    local,
  ].map((project, index) => saved(project, String(index)));
  expect(mergeProjectCatalogue([remote], histories)).toEqual([
    remote,
    ...histories,
  ]);
  const unusualLocal = saved({
    ...local,
    environment: { id: "local", name: "Other", target: "different" },
  });
  expect(mergeProjectCatalogue([local], [unusualLocal])).toEqual([
    local,
    unusualLocal,
  ]);
});

test("unavailable or empty current catalogue retains all saved history", () => {
  const history = [saved(local), saved(remote, "remote")];
  expect(mergeProjectCatalogue([], history)).toEqual(history);
  expect(mergeProjectCatalogue([local], [])).toEqual([local]);
});
