import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Read on every capability check and take. Never surface file paths/content. */
export async function readVoiceKey(
  configPath?: string,
): Promise<{ key?: string; reason?: "voice_disabled" | "config_unavailable" }> {
  if (!configPath) return { reason: "voice_disabled" };
  try {
    const config = Bun.TOML.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (config.voice === undefined) return { reason: "voice_disabled" };
    const voice = config.voice as { api_key_file?: unknown } | null;
    if (
      !voice ||
      typeof voice.api_key_file !== "string" ||
      !voice.api_key_file.trim()
    )
      return { reason: "config_unavailable" };
    const file = await open(
      resolve(dirname(configPath), voice.api_key_file),
      "r",
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 || stat.mode & 0o077)
        return { reason: "config_unavailable" };
      const buffer = Buffer.alloc(1025);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024) return { reason: "config_unavailable" };
      const key = new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, bytesRead))
        .trim();
      if (!key || key.length > 512 || /\s|[\x00-\x1f\x7f]/u.test(key))
        return { reason: "config_unavailable" };
      return { key };
    } finally {
      await file.close();
    }
  } catch {
    return { reason: "config_unavailable" };
  }
}
