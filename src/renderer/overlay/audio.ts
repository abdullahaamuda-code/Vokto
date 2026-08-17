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
// Sustained energy required before a blip is promoted to a real utterance.
// Worklet frames arrive every ~128ms (2048 samples @ 16k), so requiring ~2
// consecutive frames above threshold kills single-frame transients (clicks,
// taps, one-off pops) from ever becoming dictation.
const SPEECH_CONFIRM_MS = 200;
const UTTERANCE_PAUSE_MS = 950; // ~0.95s of real quiet → ship this sentence + auto-paste
const SPEECH_RESUME_GRACE_MS = 220; // brief dips below threshold still count as "talking"
const TAIL_CARRY_MS = 140; // keep a whisper of the pause so we never clip a word edge
const MIN_UTTERANCE_MS = 280; // drop sub-0.28s blips, but keep short words like "So" / "Okay"
const LONG_PAUSE_ABORT_MS = 120_000; // 2 min dead silence → auto-close entirely (safety)
// A shipped chunk whose RMS doesn't beat this much of the noise floor is not
// speech — drop it before it ever reaches Whisper (kills "random text from
// random sound").
const NOISE_DROP_RATIO = 2.5;
const MIN_CHUNK_RMS = 0.004;
// A chunk also needs a real peak sample above this. Near-silent audio can have
// decent RMS (hiss) but no peaks — and Whisper's silence-hallucinations ("If
// the audio is clear…") come from exactly that: near-silent audio it shouldn't
// have seen. Requiring a peak kills room-tone/hiss chunks entirely.
const MIN_CHUNK_PEAK = 0.02;

// Per-utterance streaming: we keep the mic hot across the whole session.
// Every time you pause to breathe/think (~1.1s), the buffered speech is cut
// out, transcribed and pasted where your cursor sits — and the recorder keeps
// listening for your next sentence without missing a beat.
//
// Noise safety:
//  - No silence is ever buffered. The buffer only fills while speech (or a
//    140ms tail) is live, so a stray sound after long quiet can't ship a
//    bucket of silence that Whisper turns into hallucinated text.
//  - A blip must stay above threshold for SPEECH_CONFIRM_MS before it counts
//    as an utterance (keyboard clicks are far shorter than that).
//  - Shipped chunks are RMS-checked against the noise floor; near-silent
//    "utterances" are dropped on the floor.

export class VoquaRecorder {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private src?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private recording = false;
  private buf: Float32Array[] = [];
  private bufMs = 0;
  private floor = 0.0035;
  private calibratingUntil = 0;
  private deviceId = 'default';
  private lastLevel = 0;
  private speaking = false; // inside an utterance (speech confirmed + in progress)
  private hot = false; // voice-active right now (grace-extended) — drives the pill glow
  private lastEnergyAt = 0; // last frame with energy above threshold
  private energyStartAt = 0; // first frame of the current sustained-energy run (debounce)

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
    this.lastEnergyAt = performance.now();
    this.energyStartAt = 0;
  }

  stop(): void {
    this.recording = false;
    this.hot = false;
    this.energyStartAt = 0;
    // Flush whatever is still buffered (the tail of the last sentence) — gated
    // so a leftover 140ms of silence after a flush can't ship as junk.
    this.flushFinal();
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

  private rate(): number {
    return this.ctx?.sampleRate ?? 16000;
  }

  private minSamples(): number {
    return Math.floor((MIN_UTTERANCE_MS / 1000) * this.rate());
  }

  // Encode segments → WAV only if they clear the energy gate. Returns null if
  // the chunk is really just noise.
  private segmentsToWav(segments: Float32Array[]): { wav: ArrayBuffer; durationSec: number } | null {
    const total = segments.reduce((n, s) => n + s.length, 0);
    if (total < this.minSamples()) return null;
    const rate = this.rate();
    const merged = new Float32Array(total);
    let off = 0;
    let sumSq = 0;
    let peak = 0;
    for (const s of segments) {
      merged.set(s, off);
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        sumSq += v * v;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }
      off += s.length;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, total));
    if (rms < Math.max(this.floor * NOISE_DROP_RATIO, MIN_CHUNK_RMS)) return null;
    if (peak < MIN_CHUNK_PEAK) return null;
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

    // Slow floor adaptation while quiet so a changing room noise doesn't drift
    // the threshold into hallucination territory.
    if (!isSpeech) {
      this.floor = Math.min(Math.max(this.floor * 0.999 + f.e * 0.001, 0.0015), 0.03);
    }

    // "hot" = voice active WITH a short grace so the pill doesn't flicker
    // between words. "speaking" = an utterance is in progress (needs a real gap
    // to turn off, which is exactly what cuts the sentence cleanly).
    if (isSpeech) {
      this.lastEnergyAt = now;
      this.hot = true;
    } else if (now - this.lastEnergyAt > SPEECH_RESUME_GRACE_MS) {
      this.hot = false;
    }

    // Debounce speech start: a blip must stay above threshold for
    // SPEECH_CONFIRM_MS before it becomes an utterance. One-off clicks and
    // keyboard taps never qualify.
    if (isSpeech) {
      if (this.energyStartAt === 0) this.energyStartAt = now;
      if (!this.speaking && now - this.energyStartAt >= SPEECH_CONFIRM_MS) {
        this.speaking = true;
        this.buf = [];
        this.bufMs = 0;
      }
    } else {
      this.energyStartAt = 0;
    }

    if (!this.recording) return;

    // Real pause after talking → cut the utterance just BEFORE the silence
    // (keeping a whisper of tail so no word edge is ever clipped) and ship it
    // to be transcribed + auto-pasted. The session stays live.
    if (this.speaking && !isSpeech && now - this.lastEnergyAt > UTTERANCE_PAUSE_MS) {
      this.speaking = false;
      this.shipUtterance(now);
    }

    // Buffer only while speaking or for a whisper of tail after shipping.
    // Silence is never accumulated — that's what kept shipping noise buckets.
    const buffering = this.speaking || now - this.lastEnergyAt < TAIL_CARRY_MS;
    if (buffering) {
      this.buf.push(f.pcm);
      this.bufMs += (f.pcm.length / this.rate()) * 1000;
    } else if (this.bufMs > 0) {
      this.buf = [];
      this.bufMs = 0;
    }

    // Safety: dead silence (never spoke, or long after settle) for 2 minutes → close
    if (!this.speaking && this.bufMs === 0 && now - this.lastEnergyAt > LONG_PAUSE_ABORT_MS) {
      this.events.onSilenceStart();
    }
  }

  // Cut the buffered utterance, trim trailing silence, ship the speech chunk.
  private shipUtterance(now: number): void {
    if (!this.ctx) return;
    const rate = this.rate();
    const silenceMs = Math.min(now - this.lastEnergyAt, UTTERANCE_PAUSE_MS);
    const cutSamples = Math.max(0, Math.floor(((silenceMs - TAIL_CARRY_MS) / 1000) * rate));
    const { segments, remainder, remainderMs } = this.sliceBufferTail(this.buf, cutSamples);
    this.buf = remainder;
    this.bufMs = remainderMs;

    const wav = this.segmentsToWav(segments);
    if (wav) {
      const dur = wav.durationSec;
      this.events.onFlushEnd(wav.wav, dur);
      this.events.onUtterancePause();
      console.log(`[audio] sentence done — shipping ${dur.toFixed(1)}s (${Math.round(silenceMs)}ms quiet)`);
    } else {
      console.log(`[audio] chunk dropped (too short / below noise gate)`);
    }
  }

  // Final flush on manual stop: ship whatever is still buffered, gated.
  private flushFinal(): void {
    const wav = this.segmentsToWav(this.buf);
    if (wav) {
      this.events.onFlushEnd(wav.wav, wav.durationSec);
      this.events.onUtterancePause();
    } else {
      this.events.onFlushEnd(new ArrayBuffer(0), 0);
    }
  }

  // Remove `cutSamples` of trailing silence from the END of the buffer.
  // Returns the speech-only segments plus the small tail we carry forward so
  // the next word never starts mid-phoneme.
  private sliceBufferTail(
    segments: Float32Array[],
    cutSamples: number,
  ): { segments: Float32Array[]; remainder: Float32Array[]; remainderMs: number } {
    const rate = this.rate();
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
      remainder: remClean,
      remainderMs: (remSamples / rate) * 1000,
    };
  }
}