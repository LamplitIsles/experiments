// Protocol/terminal validation adapted from lamplit-chat (Apache-2.0).
// Copyright 2026 LamplitIsles. See licenses/lamplit-app-Apache-2.0.txt.
import type { ServerWebSocket } from "bun";
import {
  MAX_VOICE_EVENT_BYTES,
  MAX_VOICE_QUEUE_BYTES,
  VOICE_TRANSCRIPT_MAX_CHARS,
  parseVoiceControl,
  validateVoiceFrameBytes,
  type VoiceErrorCode,
  type VoiceServerEvent,
} from "../src/voice-contract";

export const VOICE_PROVIDER =
  "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const VOICE_MODEL = "qwen-audio-3.1-asr-flash-streaming";
export type VoiceOptions = {
  configPath?: string;
  // The production connector is fixed; fixtures inject only a test-owned upstream.
  connect?: (key: string) => WebSocket;
  timeouts?: { startup: number; finish: number; lifetime: number };
};
export type VoiceSocketData = {
  key: string;
  peerId: string;
  options: VoiceOptions;
  relay?: ReturnType<typeof voiceRelay>;
};
export function voiceRelay(
  client: Pick<
    ServerWebSocket<unknown>,
    "send" | "close" | "getBufferedAmount"
  >,
  data: VoiceSocketData,
) {
  const taskId = crypto.randomUUID();
  let upstream: WebSocket | undefined,
    terminal = false,
    ready = false,
    finishing = false,
    bytes = 0,
    chars = 0;
  const sentences = new Map<number, string>(),
    unfinished = new Set<number>();
  const limits = data.options.timeouts ?? {
    startup: 15_000,
    finish: 20_000,
    lifetime: 320_000,
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const end = (event?: VoiceServerEvent) => {
    if (terminal) return;
    terminal = true;
    timers.forEach(clearTimeout);
    try {
      if (event) client.send(JSON.stringify(event));
    } catch {
      /* disconnected */
    }
    try {
      client.close(1000);
    } catch {
      /* disconnected */
    }
    try {
      upstream?.close(1000);
    } catch {
      /* connecting */
    }
    sentences.clear();
    unfinished.clear();
    data.key = "";
  };
  const fail = (code: VoiceErrorCode = "upstream_error") =>
    end({ type: "error", code });
  function send(value: string | Buffer) {
    if (
      !upstream ||
      upstream.readyState !== WebSocket.OPEN ||
      upstream.bufferedAmount + Buffer.byteLength(value) > MAX_VOICE_QUEUE_BYTES
    )
      throw new Error("Upstream unavailable");
    upstream.send(
      typeof value === "string" ? value : new Uint8Array(value).buffer,
    );
  }
  const receive = (message: string | Buffer) => {
    if (terminal) return;
    try {
      if (typeof message === "string") {
        const command = parseVoiceControl(message);
        if (command.type === "cancel") return end();
        if (!ready || finishing || !bytes) return fail("invalid_audio");
        finishing = true;
        send(
          JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: { input: {} },
          }),
        );
        timers.push(setTimeout(() => fail("timeout"), limits.finish));
      } else {
        if (!ready || finishing) return fail("invalid_audio");
        bytes = validateVoiceFrameBytes(message.byteLength, bytes);
        send(message);
      }
    } catch {
      fail("invalid_audio");
    }
  };
  timers.push(setTimeout(() => fail("timeout"), limits.startup));
  try {
    const Client = WebSocket as unknown as {
      new (
        url: string,
        options: { headers: Record<string, string> },
      ): WebSocket;
    };
    upstream = data.options.connect
      ? data.options.connect(data.key)
      : new Client(VOICE_PROVIDER, {
          headers: { Authorization: `Bearer ${data.key}` },
        });
    data.key = "";
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      if (terminal) {
        upstream?.close();
        return;
      }
      try {
        send(
          JSON.stringify({
            header: {
              action: "run-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: VOICE_MODEL,
              parameters: {
                format: "pcm",
                sample_rate: 16000,
                semantic_punctuation_enabled: false,
                max_sentence_silence: 400,
              },
              input: {},
            },
          }),
        );
      } catch {
        fail();
      }
    };
    upstream.onerror = upstream.onclose = () => {
      if (!terminal) fail();
    };
    upstream.onmessage = (event) => {
      if (terminal) return;
      try {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > MAX_VOICE_EVENT_BYTES
        )
          return fail("transcript_invalid");
        const frame = JSON.parse(event.data);
        if (
          frame?.header?.task_id !== taskId ||
          !frame.payload ||
          typeof frame.payload !== "object" ||
          Array.isArray(frame.payload)
        )
          return fail("transcript_invalid");
        switch (frame.header.event) {
          case "task-started":
            if (ready) return fail("transcript_invalid");
            ready = true;
            clearTimeout(timers[0]);
            timers.push(setTimeout(() => fail("timeout"), limits.lifetime));
            if (
              client.getBufferedAmount() > MAX_VOICE_QUEUE_BYTES ||
              client.send(
                JSON.stringify({ type: "ready", peerId: data.peerId }),
              ) === 0
            )
              end();
            break;
          case "result-generated": {
            if (!ready) return fail("transcript_invalid");
            const sentence = frame.payload.output?.sentence;
            if (!sentence || typeof sentence !== "object")
              return fail("transcript_invalid");
            if (sentence.heartbeat === true) return;
            if (
              typeof sentence.sentence_end !== "boolean" ||
              !Number.isSafeInteger(sentence.sentence_id) ||
              sentence.sentence_id < 1 ||
              typeof sentence.text !== "string"
            )
              return fail("transcript_invalid");
            if (!sentence.sentence_end) {
              if (!sentences.has(sentence.sentence_id))
                unfinished.add(sentence.sentence_id);
              if (unfinished.size > VOICE_TRANSCRIPT_MAX_CHARS)
                fail("transcript_invalid");
              return;
            }
            if (!sentence.text.trim()) return fail("transcript_invalid");
            unfinished.delete(sentence.sentence_id);
            chars +=
              Array.from(sentence.text).length -
              Array.from(sentences.get(sentence.sentence_id) ?? "").length;
            if (chars > VOICE_TRANSCRIPT_MAX_CHARS)
              return fail("transcript_invalid");
            sentences.set(sentence.sentence_id, sentence.text);
            break;
          }
          case "task-finished": {
            if (!ready || !finishing || !sentences.size || unfinished.size)
              return fail("transcript_invalid");
            const text = [...sentences]
              .sort(([a], [b]) => a - b)
              .map(([, text]) => text)
              .join("")
              .trim();
            end({ type: "result", text });
            break;
          }
          case "task-failed":
            fail();
            break;
          default:
            fail("transcript_invalid");
        }
      } catch {
        fail("transcript_invalid");
      }
    };
  } catch {
    fail();
  }
  return { receive, dispose: () => end() };
}
