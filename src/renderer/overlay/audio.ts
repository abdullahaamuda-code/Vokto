import { encodeWav } from './wav';
import { workletUrl } from './worklet';

export interface RecorderEvents {
  onSilenceStart: () => void;
  onFlushEnd: (wav: ArrayBuffer, durationSec: number) => void;
  // Fired the moment an utterance is cut + shipped (so the pill can pulse once).
  onUtterancePause: () => void;
  onError: (msg: string) => void;
}

interface WorkletFrame {
  e: number;
  level: number;
  pcm: Float32Array;
}

const FLOOR_CALIBRATION_MS = 900;
const UTTERANCE_PAUSE_MS = 1_700; // ~1.7s of real quiet → ship this sentence + auto-paste
const SPEECH_RESUME_GRACE_MS = 220; // brief dips below threshold still count as "talking"
const TAIL_CARRY_MS = 140; // keep a whisper of the pause so we never clip a word edge
const MIN_UTTERANCE_MS = 500; // don't flush on accidental sub-0.5s blips
const LONG_PAUSE_ABORT_MS = 120_000; // 2 min dead silence → auto-close entirely (safety)

// Per-utterance streaming: we keep the mic hot across the whole session.
// Every time you pause to breathe/think (~1.5s), the buffered speech is cut
// out, transcribed and pasted where your cursor sits — and the recorder keeps
// listening for your next sentence without missing a beat.

export class VoquaRecorder {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private src?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private recording = false;
  private buf: Float32Array[] = [];
  private bufMs = 0;
  private lastSpeechAt = 0;
  private floor = 0.0035;
  private calibratingUntil = 0;
  private deviceId = 'default';
  private lastLevel = 0;
  private speaking = false; // in an utterance (after a real pause)
  private hot = false; // voice-active right now (grace-extended) — drives the pill glow

  constructor(private events: RecorderEvents) {}

  get level(): number {
    return this.lastLevel;
  }

  // True while the user's voice is live (with a short grace so micro-gaps
  // between words don't make the pill flicker). The overlay reads this every
  // frame for its fade.
  get isSpeakingNow(): boolean {
    return this.hot;
  }

  async ensureMic(): Promise<void> {
    if (this.stream) return;
    await this.openStream(this.deviceId);
  }

  async setDevice(deviceId: string): Promise<void> {
    this.deviceId = deviceId;
    const wasRecording = this.recording;
    this.teardown();
    await this.openStream(deviceId);
    if (wasRecording) this.start();
  }

  private async openStream(deviceId: string): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 16000 },
      },
      video: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.ctx = new AudioContext({ sampleRate: this.stream.getAudioTracks()[0].getSettings().sampleRate ?? 16000 });
    await this.ctx.audioWorklet.addModule(workletUrl());
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'vq-capture');
    this.node.port.onmessage = (ev: MessageEvent<WorkletFrame>) => this.onFrame(ev.data);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.calibratingUntil = performance.now() + FLOOR_CALIBRATION_MS;
  }

  start(): void {
    this.recording = true;
    this.speaking = false;
    this.hot = false;
    this.buf = [];
    this.bufMs = 0;
    this.lastSpeechAt = performance.now();
  }

  stop(): void {
    this.recording = false;
    this.hot = false;
    if (this.buf.length > 0) {
      const wav = this.bufferToWav(this.buf);
      // Only use flush-end — audioChunk is a no-op in the simple pipeline
      if (wav) {
        this.events.onFlushEnd(wav.wav, wav.durationSec); // sole trigger
      } else {
        this.events.onFlushEnd(new ArrayBuffer(0), 0);
      }
    } else {
      this.events.onFlushEnd(new ArrayBuffer(0), 0);
    }
    this.buf = [];
    this.bufMs = 0;
    this.speaking = false;
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    try {
      this.node?.disconnect();
      this.src?.disconnect();
      this.sink?.disconnect();
      void this.ctx?.close();
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    this.stream = undefined;
    this.ctx = undefined;
    this.node = undefined;
  }

  private bufferToWav(segments: Float32Array[]): { wav: ArrayBuffer; durationSec: number } | null {
    const total = segments.reduce((n, s) => n + s.length, 0);
    if (total < 4000) return null; // below 0.25s, don't bother
    const merged = new Float32Array(total);
    let off = 0;
    for (const s of segments) {
      merged.set(s, off);
      off += s.length;
    }
    const rate = this.ctx?.sampleRate ?? 16000;
    const wav = encodeWav(merged, rate);
    return { wav: wav.buffer as ArrayBuffer, durationSec: total / rate };
  }

  private onFrame(f: WorkletFrame): void {
    if (!this.ctx) return;
    const now = performance.now();
    this.lastLevel = f.level;

    // Adaptive noise floor during first 900ms
    if (now < this.calibratingUntil) {
      this.floor = Math.min(Math.max(this.floor * 0.94 + f.e * 0.06, 0.0015), 0.02);
      return;
    }

    const threshold = Math.max(this.floor * 3.0, 0.005);
    const isSpeech = f.e > threshold;

    // "hot" = voice active WITH a short grace so the pill doesn't flicker
    // between words. "speaking" = an utterance is in progress (needs a real gap
    // to turn off, which is exactly what cuts the sentence cleanly).
    if (isSpeech) {
      this.lastSpeechAt = now;
      this.hot = true;
      this.speaking = true;
    } else {
      if (now - this.lastSpeechAt > SPEECH_RESUME_GRACE_MS) this.hot = false;
      if (now - this.lastSpeechAt > UTTERANCE_PAUSE_MS) this.speaking = false;
    }

    if (!this.recording) return;

    this.buf.push(f.pcm);
    this.bufMs += (f.pcm.length / this.ctx.sampleRate) * 1000;

    const silenceMs = now - this.lastSpeechAt;

    // Real pause after talking → cut the utterance just BEFORE the silence
    // (keeping a whisper of tail so no word edge is ever clipped) and ship it
    // to be transcribed + auto-pasted. The session stays live.
    if (this.speaking === false && this.bufMs >= MIN_UTTERANCE_MS && silenceMs > UTTERANCE_PAUSE_MS) {
      const rate = this.ctx.sampleRate;
      const cutSamples = Math.max(0, Math.floor(((silenceMs - TAIL_CARRY_MS) / 1000) * rate));
      const slice = this.sliceBufferTail(this.buf, cutSamples);
      console.log(
        `[audio] sentence done (${Math.round(silenceMs)}ms quiet) — shipping ${(slice.ms / 1000).toFixed(1)}s, dropped ${(cutSamples / rate).toFixed(2)}s of trailing silence`,
      );
      const wav = this.bufferToWav(slice.segments);
      if (wav) {
        this.events.onFlushEnd(wav.wav, wav.durationSec);
        this.events.onUtterancePause();
      }
      this.buf = slice.remainder;
      this.bufMs = slice.remainderMs;
      return;
    }

    // Safety: dead silence (never spoke, or long after settle) for 2 minutes → close
    if (!this.speaking && this.bufMs < 500 && silenceMs > LONG_PAUSE_ABORT_MS) {
      this.events.onSilenceStart();
    }
  }

  // Remove `cutSamples` of trailing silence from the END of the buffer.
  // Returns the speech-only segments plus the small tail we carry forward so
  // the next word never starts mid-phoneme.
  private sliceBufferTail(
    segments: Float32Array[],
    cutSamples: number,
  ): { segments: Float32Array[]; ms: number; remainder: Float32Array[]; remainderMs: number } {
    const rate = this.ctx?.sampleRate ?? 16000;
    const total = segments.reduce((n, s) => n + s.length, 0);
    const keepLen = Math.max(0, total - cutSamples);

    const out: Float32Array[] = [];
    let acc = 0;
    for (const seg of segments) {
      if (acc >= keepLen) break;
      const room = keepLen - acc;
      if (seg.length <= room) {
        out.push(seg);
        acc += seg.length;
      } else {
        out.push(seg.slice(0, room));
        acc = keepLen;
      }
    }
    const speech = out.filter((s) => s.length > 0);
    const speechSamples = speech.reduce((n, s) => n + s.length, 0);

    // remainder = everything after keepLen (the trailing pause — we keep only
    // TAIL_CARRY_MS of it, which we already left intact by slicing at keepLen;
    // the rest is simply dropped by not re-buffering it)
    const remainder: Float32Array[] = [];
    let acc2 = 0;
    for (const seg of segments) {
      const segStart = acc2;
      const segEnd = acc2 + seg.length;
      acc2 = segEnd;
      if (segEnd <= keepLen) continue;
      const from = Math.max(0, keepLen - segStart);
      remainder.push(seg.slice(from));
    }
    const remClean = remainder.filter((s) => s.length > 0);
    const remSamples = remClean.reduce((n, s) => n + s.length, 0);

    return {
      segments: speech,
      ms: (speechSamples / rate) * 1000,
      remainder: remClean,
      remainderMs: (remSamples / rate) * 1000,
    };
  }
}
