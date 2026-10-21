import { expect, test } from "bun:test";
import { projectCatalogue, remoteOwner } from "./projects";

test("network remote owner ignores host and case, rejecting ambiguous/local paths", () => {
  for (const remote of [
    "https://github.com/GuionAI/repo.git",
    "https://user:secret@forge.example:8086/guionai/repo",
    "ssh://git@forge.example:2222/GuionAI/repo.git",
    "git@github.com:GUIONAI/repo.git",
    "forge.example:GuionAI/repo",
  ])
    expect(remoteOwner(remote)).toBe("guionai");
  expect(remoteOwner("https://github.com/Personal/repo")).toBe("personal");
  for (const remote of [
    undefined,
    "",
    "/owner/repo",
    "../owner/repo",
    "file:///owner/repo",
    "C:/owner/repo",
    "https://host/owner",
    "https://host/a/b/c",
    "ssh://host//repo",
    "https://host/../repo",
    "https://host/a/b?token=secret",
  ])
    expect(remoteOwner(remote)).toBeNull();
});

test("catalogue projects only derived owners and preserves project identity", () => {
  const projected = projectCatalogue([
    {
      alias: "one",
      name: "",
      path: "/fixture/one",
      remote: "https://user:secret@github.com/GuionAI/one",
    },
    {
      alias: "two",
      name: "Two",
      path: "/fixture/two",
      remote: "git@forge.example:guionai/two",
    },
    { alias: "local", name: "Local", path: "/fixture/local" },
    { alias: "archived", name: "Old", path: "/fixture/old", archived: true },
  ]);
  expect(projected).toEqual([
    { alias: "one", name: "one", path: "/fixture/one", owner: "guionai" },
    { alias: "two", name: "Two", path: "/fixture/two", owner: "guionai" },
    { alias: "local", name: "Local", path: "/fixture/local", owner: null },
  ]);
  expect(JSON.stringify(projected)).not.toContain("secret");
  expect(JSON.stringify(projected)).not.toContain("remote");
});
