import type { Backend } from "../src/contracts";
export type { Backend };
// Codex native thread IDs are UUIDs. Pi uses a distinct, server-owned namespace;
// the browser never supplies a native session path.
export function piThread(id: string) {
  return `pi:${Buffer.from(id).toString("base64url")}`;
}
export function threadIdentity(id: string): { backend: Backend; id: string } {
  return id.startsWith("pi:")
    ? { backend: "pi", id: Buffer.from(id.slice(3), "base64url").toString() }
    : { backend: "codex", id };
}
