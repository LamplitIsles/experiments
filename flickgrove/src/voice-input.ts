// Adapted from lamplit-app (Apache-2.0); see licenses/lamplit-app-Apache-2.0.txt.
import workletUrl from "./voice-worklet.js?url&no-inline";
import {
  MAX_VOICE_DURATION_MS,
  MAX_VOICE_QUEUE_BYTES,
  VOICE_TRANSCRIPT_MAX_CHARS,
  VOICE_SAMPLE_RATE,
  parseVoiceServerEvent,
  validateVoiceFrameBytes,
  type VoiceErrorCode,
} from "./voice-contract";
export type VoiceRecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "transcribing"
  | "unavailable";
export interface VoiceTranscription {
  text: string;
}
export class VoiceRecordingError extends Error {
  constructor(
    readonly code:
      | VoiceErrorCode
      | "insecure-context"
      | "unsupported"
      | "permission-denied"
      | "capture-failed"
      | "duration-limit"
      | "size-limit"
      | "transcript-invalid",
  ) {
    super(code);
    this.name = "VoiceRecordingError";
  }
}
export function canCaptureVoice(): boolean {
  return (
    globalThis.isSecureContext !== false &&
    typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function" &&
    typeof globalThis.AudioContext === "function" &&
    typeof globalThis.AudioWorkletNode === "function" &&
    typeof globalThis.WebSocket === "function"
  );
}
export function normalizeVoiceTranscription(raw: unknown): VoiceTranscription {
  const text =
    raw &&
    typeof raw === "object" &&
    "text" in raw &&
    typeof raw.text === "string"
      ? raw.text.trim()
      : "";
  if (!text || Array.from(text).length > VOICE_TRANSCRIPT_MAX_CHARS)
    throw new VoiceRecordingError("transcript-invalid");
  return { text };
}
interface Take {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  socket?: WebSocket;
  remoteReady: boolean;
  queue: ArrayBuffer[];
  queuedBytes: number;
  flushed: boolean;
  finishSent: boolean;
  drainTimer?: ReturnType<typeof setTimeout>;
  deliveryTimer?: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  bytes: number;
  finishing: boolean;
  terminal: boolean;
  timers: ReturnType<typeof setTimeout>[];
  flushTimer?: ReturnType<typeof setTimeout>;
  ready: Promise<boolean>;
  resolveReady: (value: boolean) => void;
  rejectReady: (error: unknown) => void;
  result: Promise<VoiceTranscription>;
  resolve: (value: VoiceTranscription) => void;
  reject: (error: unknown) => void;
}
/** Owns one capture/transport lifecycle with at most five seconds of startup PCM. */
export class VoiceRecordingController {
  private take?: Take;
  private disposed = false;
  private statusValue: VoiceRecordingStatus = "idle";
  constructor(
    private options: {
      onStatus?: (status: VoiceRecordingStatus) => void;
      onError?: (error: VoiceRecordingError) => void;
      onDurationLimit?: () => void;
      onResult?: (result: VoiceTranscription) => void;
    } = {},
  ) {}
  get status() {
    return this.statusValue;
  }
  get elapsedMs() {
    return this.take?.startedAt
      ? Math.max(0, Date.now() - this.take.startedAt)
      : 0;
  }
  private setStatus(next: VoiceRecordingStatus) {
    this.statusValue = next;
    this.options.onStatus?.(next);
  }
  private releaseCapture(take: Take) {
    for (const node of [take.source, take.node]) {
      try {
        node?.disconnect();
      } catch {
        /* Already released. */
      }
    }
    for (const track of take.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* Release the rest too. */
      }
    }
    take.stream = undefined;
    take.source = undefined;
    take.node = undefined;
    if (take.context) {
      void take.context.close().catch(() => undefined);
      take.context = undefined;
    }
  }
  private end(
    take: Take,
    error?: VoiceRecordingError,
    result?: VoiceTranscription,
  ) {
    if (take.terminal) return;
    take.terminal = true;
    take.timers.forEach(clearTimeout);
    clearTimeout(take.drainTimer);
    take.queue = [];
    take.queuedBytes = 0;
    this.releaseCapture(take);
    try {
      take.socket?.close(1000);
    } catch {
      /* Closing connecting sockets can throw. */
    }
    if (this.take === take) {
      this.take = undefined;
      this.setStatus("idle");
    }
    if (error) {
      take.rejectReady(error);
      take.reject(error);
      if (error.code !== "cancelled") this.options.onError?.(error);
    } else if (result) {
      take.resolve(result);
      this.options.onResult?.(result);
    }
  }
  async start(
    connect: () => Promise<WebSocket>,
    peerId: string,
  ): Promise<boolean> {
    if (this.disposed || this.take) return false;
    if (!canCaptureVoice())
      throw new VoiceRecordingError(
        globalThis.isSecureContext === false
          ? "insecure-context"
          : "unsupported",
      );
    let resolveReady!: Take["resolveReady"],
      rejectReady!: Take["rejectReady"],
      resolve!: Take["resolve"],
      reject!: Take["reject"];
    const ready = new Promise<boolean>((a, b) => {
      resolveReady = a;
      rejectReady = b;
    });
    const result = new Promise<VoiceTranscription>((a, b) => {
      resolve = a;
      reject = b;
    });
    void ready.catch(() => undefined);
    void result.catch(() => undefined);
    const take: Take = {
      remoteReady: false,
      queue: [],
      queuedBytes: 0,
      flushed: false,
      finishSent: false,
      startedAt: 0,
      bytes: 0,
      terminal: false,
      finishing: false,
      timers: [],
      ready,
      result,
      resolveReady,
      rejectReady,
      resolve,
      reject,
    };
    this.take = take;
    this.setStatus("starting");
    take.startupTimer = setTimeout(
      () => this.end(take, new VoiceRecordingError("timeout")),
      15_000,
    );
    take.timers.push(take.startupTimer);
    // Attach transport handlers independently of permission and Worklet preparation.
    void this.connect(take, connect, peerId);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: VOICE_SAMPLE_RATE },
      });
      if (take.terminal) {
        stream.getTracks().forEach((track) => track.stop());
        return ready;
      }
      take.stream = stream;
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      take.context = context;
      if (context.sampleRate !== VOICE_SAMPLE_RATE)
        throw new VoiceRecordingError("unsupported");
      await context.audioWorklet.addModule(workletUrl);
      if (take.terminal) return ready;
      await context.resume();
      if (take.terminal) return ready;
      const node = new AudioWorkletNode(context, "voice-pcm", {
        channelCount: 1,
        channelCountMode: "explicit",
      });
      take.node = node;
      take.source = context.createMediaStreamSource(stream);
      node.onprocessorerror = () =>
        this.end(take, new VoiceRecordingError("capture-failed"));
      node.port.onmessage = (event) => {
        if (take.terminal) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            const frame = event.data;
            if (!take.startedAt) {
              take.startedAt = Date.now();
              if (take.remoteReady) clearTimeout(take.startupTimer);
              this.setStatus("recording");
              take.resolveReady(true);
              take.timers.push(
                setTimeout(() => {
                  if (!take.finishing && !take.terminal) {
                    this.options.onDurationLimit?.();
                    if (!take.finishing)
                      void this.stopAndGet().catch(() => undefined);
                  }
                }, MAX_VOICE_DURATION_MS),
              );
            }
            try {
              take.bytes = validateVoiceFrameBytes(
                frame.byteLength,
                take.bytes,
              );
            } catch {
              throw new VoiceRecordingError("size-limit");
            }
            if (
              take.queuedBytes + frame.byteLength > 160_000 ||
              take.queuedBytes +
                frame.byteLength +
                (take.socket?.bufferedAmount ?? 0) >
                MAX_VOICE_QUEUE_BYTES
            )
              throw new VoiceRecordingError("size-limit");
            take.queue.push(frame);
            take.queuedBytes += frame.byteLength;
            this.drain(take);
          } else if (event.data?.type === "duration-limit" && !take.finishing) {
            this.options.onDurationLimit?.();
            if (!take.finishing) void this.stopAndGet().catch(() => undefined);
          } else if (event.data?.type === "flushed" && take.finishing) {
            clearTimeout(take.flushTimer);
            this.releaseCapture(take);
            take.flushed = true;
            take.deliveryTimer = setTimeout(
              () => this.end(take, new VoiceRecordingError("timeout")),
              20_000,
            );
            take.timers.push(take.deliveryTimer);
            this.setStatus("transcribing");
            this.drain(take);
          }
        } catch (error) {
          this.end(
            take,
            error instanceof VoiceRecordingError
              ? error
              : new VoiceRecordingError("capture-failed"),
          );
        }
      };
      take.source.connect(node);
      node.connect(context.destination);
    } catch (error) {
      this.end(
        take,
        error instanceof VoiceRecordingError
          ? error
          : new VoiceRecordingError(
              error instanceof Error && error.name === "NotAllowedError"
                ? "permission-denied"
                : "capture-failed",
            ),
      );
    }
    return ready;
  }
  private async connect(
    take: Take,
    connect: () => Promise<WebSocket>,
    peerId: string,
  ) {
    try {
      const socket = await connect();
      if (take.terminal) {
        socket.close();
        return;
      }
      take.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        if (take.terminal) return;
        try {
          if (typeof event.data !== "string")
            throw new VoiceRecordingError("transcript-invalid");
          const data = parseVoiceServerEvent(event.data);
          if (
            data.type === "ready" &&
            !take.remoteReady &&
            data.peerId === peerId
          ) {
            take.remoteReady = true;
            if (take.startedAt) clearTimeout(take.startupTimer);
            this.drain(take);
          } else if (
            data.type === "result" &&
            take.finishSent &&
            this.statusValue === "transcribing"
          )
            this.end(take, undefined, normalizeVoiceTranscription(data));
          else if (data.type === "error")
            this.end(take, new VoiceRecordingError(data.code));
          else throw new VoiceRecordingError("transcript-invalid");
        } catch (error) {
          this.end(
            take,
            error instanceof VoiceRecordingError
              ? error
              : new VoiceRecordingError("transcript-invalid"),
          );
        }
      };
      socket.onerror = socket.onclose = () => {
        if (!take.terminal)
          this.end(take, new VoiceRecordingError("upstream_error"));
      };
    } catch {
      this.end(take, new VoiceRecordingError("upstream_error"));
    }
  }
  private drain(take: Take) {
    if (take.terminal || !take.remoteReady || take.drainTimer) return;
    const socket = take.socket!;
    try {
      if (socket.readyState !== WebSocket.OPEN)
        throw new VoiceRecordingError("upstream_error");
      while (take.queue.length) {
        const frame = take.queue[0];
        if (socket.bufferedAmount + frame.byteLength > MAX_VOICE_QUEUE_BYTES)
          break;
        socket.send(frame);
        take.queue.shift();
        take.queuedBytes -= frame.byteLength;
      }
      if (
        take.queue.length ||
        (take.flushed && socket.bufferedAmount + 17 > MAX_VOICE_QUEUE_BYTES)
      ) {
        take.drainTimer = setTimeout(() => {
          take.drainTimer = undefined;
          this.drain(take);
        }, 10);
      } else if (take.flushed) {
        take.flushed = false;
        clearTimeout(take.deliveryTimer);
        socket.send(JSON.stringify({ type: "finish" }));
        take.finishSent = true;
        take.timers.push(
          setTimeout(
            () => this.end(take, new VoiceRecordingError("timeout")),
            20_000,
          ),
        );
      }
    } catch (error) {
      this.end(
        take,
        error instanceof VoiceRecordingError
          ? error
          : new VoiceRecordingError("upstream_error"),
      );
    }
  }
  async stopAndGet(): Promise<VoiceTranscription | undefined> {
    const take = this.take;
    if (!take) return undefined;
    if (!take.finishing) {
      if (!take.startedAt) {
        this.end(take, new VoiceRecordingError("cancelled"));
        return undefined;
      }
      take.finishing = true;
      this.setStatus("stopping");
      // Port ordering guarantees every final PCM frame arrives before the flush acknowledgement.
      take.node!.port.postMessage({ type: "flush" });
      take.flushTimer = setTimeout(
        () => this.end(take, new VoiceRecordingError("timeout")),
        20_000,
      );
      take.timers.push(take.flushTimer);
    }
    return take.result;
  }
  async cancel(): Promise<void> {
    const take = this.take;
    if (!take) return;
    try {
      if (take.socket?.readyState === WebSocket.OPEN)
        take.socket.send(JSON.stringify({ type: "cancel" }));
    } catch {
      /* Still close locally. */
    }
    this.end(take, new VoiceRecordingError("cancelled"));
  }
  dispose() {
    this.disposed = true;
    void this.cancel();
  }
}
