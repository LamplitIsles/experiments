import type { Project } from "../src/contracts";

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
    projects: (Project & { archived?: boolean })[];
  };
  return response.projects
    .filter((p) => !p.archived)
    .map(({ alias, name, path }) => ({ alias, name: name || alias, path }));
}
