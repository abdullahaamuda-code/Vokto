import { app, clipboard } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GroqExhaustedError, transcribeChunk } from './groq';
import type { OverlayCmd, RecordingEntry, SessionState } from '@shared/index';

export type OverlaySend = (cmd: OverlayCmd) => void;

interface PipelineOpts {
  autoPaste?: boolean;
  // Fired once per utterance that transcribed successfully.
  onRecording?: (entry: RecordingEntry) => void;
}

// Parallel per-utterance streaming pipeline.
// The session stays open across pauses. Every time the user pauses (~1.15s),
// the recorder flushes the buffered utterance here → we transcribe it →
// immediately paste it where the cursor is. Mic keeps listening. When the
// user presses Alt+Q again (or silence safety trips), close() is called and
// the remaining queue drains in the background while the UI is already gone.
//
// Unlike a serial chain, utterances transcribe in parallel (up to
// MAX_CONCURRENT at once) so sentence #2 is being transcribed while you're
// still speaking sentence #3 — the "streaming" feel. Pastes still land in
// strict utterance order so text never reorders.
export class Pipeline {
  private pending: Array<{ seq: number; wav: Uint8Array; durSec: number }> = [];
  private completed = new Map<number, { text: string; durSec: number }>(); // transcribed, awaiting in-order paste
  private nextPasteSeq = 1;
  private workers = 0;
  private seq = 0;
  private closed = false;
  private aborted = false;
  private abortController = new AbortController();
  private pastedAny = false;
  private lastTrimmed = ''; // guards against a split utterance being pasted twice
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void>;
  private lastState: SessionState = 'recording';

  constructor(
    sessionId: string,
    private send: OverlaySend,
    private opts: PipelineOpts,
  ) {
    void sessionId; // session dir persistence removed — audio is sent from memory
    this.donePromise = new Promise<void>((r) => {
      this.doneResolve = r;
    });
  }

  // Queue one utterance WAV. Transcriptions run in parallel, pastes in order.
  addUtterance(wav: Uint8Array, durSec: number): void {
    if (this.aborted || this.closed || wav.length === 0) return;
    // Sub-0.22s chunks are noise, not speech — never transcribe them.
    if (durSec < 0.22) {
      console.log(`[pipeline] dropped ${durSec.toFixed(2)}s chunk (too short)`);
      return;
    }
    const mySeq = ++this.seq;
    console.log(`[pipeline] utterance #${mySeq}: ${(wav.length / 1024).toFixed(0)}KB (${durSec.toFixed(1)}s)`);
    this.pending.push({ seq: mySeq, wav, durSec });
    this.pump();
  }

  // No more utterances will be added. Resolves once every queued utterance has
  // been transcribed and pasted (or the pipeline was aborted). The UI is NOT
  // required to wait for this — callers can drain in the background.
  close(): Promise<void> {
    this.closed = true;
    this.maybeDone();
    return this.donePromise;
  }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
    this.pending = [];
    this.completed.clear();
    this.doneResolve?.();
    this.doneResolve = null;
  }

  private pump(): void {
    if (this.aborted) return;
    while (this.workers < MAX_CONCURRENT && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.workers += 1;
      this.sendState('processing');
      void this.processItem(item);
    }
    if (this.workers === 0) this.sendState('recording');
    this.maybeDone();
  }

  private async processItem(item: { seq: number; wav: Uint8Array; durSec: number }): Promise<void> {
    let text = '';
    try {
      console.log(`[pipeline] transcribing utterance #${item.seq} (${item.wav.length} bytes)...`);
      const { text: t } = await transcribeWithRetry(item.wav, '', this.abortController.signal);
      text = t.trim();
      console.log(`[pipeline] utterance #${item.seq} → "${text.slice(0, 80)}"`);
    } catch (err) {
      if (this.aborted) return;
      console.error(`[pipeline] utterance #${item.seq} ERROR:`, err);
      const msg =
        err instanceof GroqExhaustedError
          ? `Groq is rate-limited — try again in a few seconds`
          : `Couldn't reach Groq — check internet`;
      this.send({
        type: 'status',
        micOk: true,
        netOnline: false,
        keysAvailable: 0,
        keysTotal: 0,
        queuedChunks: 0,
        warning: msg,
      });
      text = ''; // drop this one, keep going
    } finally {
      this.workers -= 1;
    }
    if (this.aborted) return;

    this.completed.set(item.seq, { text, durSec: item.durSec });
    this.flushCompleted();
    this.pump();
    this.maybeDone();
  }

  // Paste transcribed utterances strictly in sequence. Anything transcribed
  // out of order waits here until its turn — text never reorders.
  private flushCompleted(): void {
    if (this.aborted) return;
    while (this.completed.has(this.nextPasteSeq)) {
      const { text, durSec } = this.completed.get(this.nextPasteSeq)!;
      this.completed.delete(this.nextPasteSeq);
      const seq = this.nextPasteSeq++;
      const trimmed = text.trim();
      if (!trimmed) continue;
      // A single utterance occasionally gets cut + re-transcribed into two
      // identical chunks (a VAD split right at a pause). Never paste the same
      // sentence twice back-to-back.
      if (trimmed === this.lastTrimmed) {
        console.log(`[pipeline] skipping duplicate utterance #${seq} — identical to previous`);
        continue;
      }
      this.lastTrimmed = trimmed;

      this.send({ type: 'stream', seq, liveText: trimmed, finalized: true });

      // Separate consecutive utterances with a space (but never lead with one).
      const pasteBody = (this.pastedAny ? ' ' : '') + trimmed;
      this.pastedAny = true;

      void this.pasteIt(pasteBody);
      this.opts.onRecording?.({
        id: randomUUID(),
        timestamp: Date.now(),
        durationSec: durSec,
        text: trimmed,
        wordCount: trimmed.split(/\s+/).filter(Boolean).length,
      });
    }
  }

  private async pasteIt(pasteBody: string): Promise<void> {
    if (this.aborted) return;
    if (this.opts.autoPaste) {
      const { pasteText } = await import('./paste');
      const r = await pasteText(pasteBody);
      if (!r.ok) {
        clipboard.writeText(pasteBody);
        this.send({
          type: 'status',
          micOk: true,
          netOnline: true,
          keysAvailable: 0,
          keysTotal: 0,
          queuedChunks: 0,
          warning: `Auto-paste failed — text is on your clipboard, Ctrl+V`,
        });
      }
    } else {
      clipboard.writeText(pasteBody);
    }
  }

  private sendState(s: SessionState): void {
    if (this.lastState === s) return;
    this.lastState = s;
    this.send({ type: 'state', state: s, partialLive: true });
  }

  private maybeDone(): void {
    if (
      this.closed &&
      !this.aborted &&
      this.workers === 0 &&
      this.pending.length === 0 &&
      this.completed.size === 0
    ) {
      const r = this.doneResolve;
      if (r) {
        this.doneResolve = null;
        r();
      }
    }
  }
}

// Retries up to 4 times: 0s, 2s, 4s, 8s. Handles Groq rate limits gracefully.
async function transcribeWithRetry(
  wav: Uint8Array,
  prompt: string,
  signal: AbortSignal,
): Promise<{ text: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal.aborted) throw new Error('aborted');
    console.log(`[pipeline] groq attempt ${attempt + 1}...`);
    try {
      return await transcribeChunk(wav, prompt, signal);
    } catch (err) {
      lastErr = err as Error;
      console.error(`[pipeline] groq error (attempt ${attempt + 1}):`, (err as Error).message || err);
      if (err instanceof GroqExhaustedError) {
        if (attempt === 4) throw err;
        await sleep(Math.min(err.retryAfterMs + 500, 10_000) * (attempt + 1));
        continue;
      }
      if ((err as { retryable?: boolean }).retryable) {
        if (attempt === 4) throw err;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('unknown');
}

const MAX_CONCURRENT = 2;

export function cleanupOrphanSessions(): void {
  const temp = app.getPath('temp');
  try {
    readdirSync(temp)
      .filter((d: string) => d.startsWith('vokto-'))
      .forEach((d: string) => {
        try {
          rmSync(join(temp, d), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));