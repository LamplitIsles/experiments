import type { Project } from "../src/contracts";

// Parse only network remotes with an unambiguous owner/repository pair.
export function remoteOwner(remote: unknown): string | null {
  if (typeof remote !== "string" || !remote || /\s/.test(remote)) return null;
  let path: string;
  try {
    if (/^(https?|ssh|git):\/\//i.test(remote)) {
      const url = new URL(remote);
      if (!url.hostname || url.search || url.hash) return null;
      path = url.pathname;
    } else {
      const scp = /^(?:[^@/:]+@)?[^/:]+:([^:]+)$/.exec(remote);
      if (!scp || /^[a-z]:/i.test(remote) || remote.startsWith("/"))
        return null;
      path = scp[1];
    }
    const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/");
    if (
      parts.length !== 2 ||
      !/^[a-z0-9][a-z0-9_.-]*$/i.test(parts[0]) ||
      !/^[a-z0-9_][a-z0-9_.-]*$/i.test(parts[1]) ||
      parts.some((p) => p === "." || p === "..")
    )
      return null;
    return parts[0].toLowerCase();
  } catch {
    return null;
  }
}

export function projectCatalogue(
  projects: (Project & { remote?: string; archived?: boolean })[],
): Project[] {
  return projects
    .filter((p) => !p.archived)
    .map(({ alias, name, path, remote }) => ({
      alias,
      name: name || alias,
      path,
      owner: remoteOwner(remote),
    }));
}

export async function registeredProjects(): Promise<Project[]> {
  const process = Bun.spawn(["og", "project", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code)
    throw new Error(error.trim() || "Could not load registered projects");
  const response = JSON.parse(text) as {
    projects: (Project & { remote?: string; archived?: boolean })[];
  };
  return projectCatalogue(response.projects);
}
