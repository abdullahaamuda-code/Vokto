// AudioWorklet source, delivered as a string → Blob URL (vite-friendly).
export const WORKLET_SOURCE = `
class VQCaptureWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.bufLen = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const ch = input[0];
      const copy = new Float32Array(ch.length);
      copy.set(ch);
      this.buf.push(copy);
      this.bufLen += ch.length;
      if (this.bufLen >= 2048) {
        const merged = new Float32Array(this.bufLen);
        let off = 0;
        let sumSq = 0;
        let peak = 0;
        for (const s of this.buf) {
          merged.set(s, off);
          for (let i = 0; i < s.length; i++) {
            const v = s[i];
            sumSq += v * v;
            const a = Math.abs(v);
            if (a > peak) peak = a;
          }
          off += s.length;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, this.bufLen));
        this.port.postMessage({ e: rms, level: peak, pcm: merged }, [merged.buffer]);
        this.buf = [];
        this.bufLen = 0;
      }
    }
    return true;
  }
}
registerProcessor('vq-capture', VQCaptureWorklet);
`;

export function workletUrl(): string {
  return URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
}
