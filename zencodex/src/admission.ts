import { AppServerInvalidRequestError } from "@jaminzhou/codex-app-server-client";

export function resumeAdmission(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof AppServerInvalidRequestError &&
    error.code === -32600 &&
    /active writer|already open|writer.*active/i.test(error.rpcMessage)
    ? "This session is already open in another Codex client."
    : `Could not open this session: ${message.replace(/\s+/g, " ").slice(0, 140)}`;
}
