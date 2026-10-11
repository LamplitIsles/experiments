import { z } from "zod";

export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_DURATION_MS = 300_000;
export const MAX_VOICE_PCM_BYTES = 9_600_000;
export const MAX_VOICE_FRAME_BYTES = 16 * 1024;
export const MAX_VOICE_QUEUE_BYTES = 256 * 1024;
export const MAX_VOICE_EVENT_BYTES = 128 * 1024;
export const VOICE_TRANSCRIPT_MAX_CHARS = 20_000;
export const voiceErrorCodes = [
  "voice_disabled",
  "config_unavailable",
  "upstream_error",
  "timeout",
  "cancelled",
  "invalid_audio",
  "transcript_invalid",
] as const;
export type VoiceErrorCode = (typeof voiceErrorCodes)[number];
export const voiceCapability = z.strictObject({
  available: z.boolean(),
  reason: z.enum(["voice_disabled", "config_unavailable"]).optional(),
});
const control = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("finish") }),
  z.strictObject({ type: z.literal("cancel") }),
]);
const event = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), peerId: z.string().min(1) }),
  z.strictObject({
    type: z.literal("result"),
    text: z
      .string()
      .refine(
        (text) =>
          !!text.trim() &&
          Array.from(text).length <= VOICE_TRANSCRIPT_MAX_CHARS,
      ),
  }),
  z.strictObject({ type: z.literal("error"), code: z.enum(voiceErrorCodes) }),
]);
export type VoiceServerEvent = z.infer<typeof event>;
function decode(raw: string, limit: number) {
  if (new TextEncoder().encode(raw).byteLength > limit)
    throw new Error("Voice frame too large");
  return JSON.parse(raw);
}
export function parseVoiceControl(raw: string) {
  return control.parse(decode(raw, 128));
}
export function parseVoiceServerEvent(raw: string) {
  return event.parse(decode(raw, MAX_VOICE_EVENT_BYTES));
}
export function validateVoiceFrameBytes(bytes: number, total: number) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes % 2 ||
    bytes > MAX_VOICE_FRAME_BYTES ||
    total + bytes > MAX_VOICE_PCM_BYTES
  )
    throw new Error("Invalid voice audio");
  return total + bytes;
}
