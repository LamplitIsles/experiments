import { statSync } from "node:fs";

// Paths may differ by casing or symlinks on the execution host. Never fold case:
// on a case-sensitive filesystem that could admit a different project.
export function sameDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return (
      a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino
    );
  } catch {
    return false;
  }
}
