// Adapted from lamplit-app (Apache-2.0); see licenses/lamplit-app-Apache-2.0.txt.
/* Bundled locally. Actual AudioContext must be 16 kHz; no resampling fallback. */
class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(3200);
    this.view = new DataView(this.frame);
    this.offset = 0;
    this.finished = false;
    this.samples = 0;
    this.limited = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush" || this.finished) return;
      this.finished = true;
      if (this.offset)
        this.port.postMessage(this.frame.slice(0, this.offset), []);
      this.port.postMessage({ type: "flushed" });
    };
  }
  process(inputs) {
    if (this.finished) return false;
    if (this.limited) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(
        this.offset,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
      this.offset += 2;
      this.samples++;
      if (this.offset === 3200) {
        this.port.postMessage(this.frame, [this.frame]);
        this.frame = new ArrayBuffer(3200);
        this.view = new DataView(this.frame);
        this.offset = 0;
      }
      if (this.samples === 4800000) {
        this.limited = true;
        this.port.postMessage({ type: "duration-limit" });
        break;
      }
    }
    return true;
  }
}
registerProcessor("voice-pcm", VoicePCM);
