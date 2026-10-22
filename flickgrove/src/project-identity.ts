import type { Project } from "./contracts";

export const environmentId = (project: Pick<Project, "environment">) =>
  project.environment?.id ?? "local";
export const projectReference = (project: Project) =>
  project.historyRef ??
  (environmentId(project) === "local"
    ? project.alias
    : `${environmentId(project)}:${project.alias}`);
export function parseProjectReference(reference: string) {
  const index = reference.indexOf(":");
  return index < 0
    ? { environment: "local", alias: reference }
    : {
        environment: reference.slice(0, index),
        alias: reference.slice(index + 1),
      };
}
export const projectDirectoryKey = (project: Project) =>
  JSON.stringify([
    environmentId(project),
    project.environment?.target ?? "",
    project.path,
  ]);
