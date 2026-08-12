import { app, clipboard } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroqExhaustedError, transcribeChunk } from './groq';
import type { OverlayCmd, RecordingEntry } from '@shared/index';

export type OverlaySend = (cmd: OverlayCmd) => void;

interface PipelineOpts {
  autoPaste?: boolean;
  // Fired once per utterance that transcribed + pasted successfully.
  onRecording?: (entry: RecordingEntry) => void;
}

// Per-utterance streaming pipeline.
// The session stays open across pauses. Every time the user pauses (~1.5s),
// the recorder flushes the buffered utterance here → we transcribe it →
// immediately paste it where the cursor is. Mic keeps listening. When the
// user presses Alt+Q again (or silence safety trips), finish() flushes the
// tail and the session closes.
export class Pipeline {
  private abortController = new AbortController();
  private sessionDir: string;
  private aborted = false;
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  private pastedAny = false;

  constructor(
    sessionId: string,
    private send: OverlaySend,
    private opts: PipelineOpts,
  ) {
    this.sessionDir = join(app.getPath('temp'), `vokto-${sessionId}`);
    if (!existsSync(this.sessionDir)) mkdirSync(this.sessionDir, { recursive: true });
  }

  // Queue one utterance WAV. Calls are serialized so pastes land in order.
  addUtterance(wav: Uint8Array, durSec: number): void {
    if (this.aborted || wav.length === 0) return;
    const mySeq = ++this.seq;
    const file = join(this.sessionDir, `u-${mySeq}.wav`);
    try {
      writeFileSync(file, Buffer.from(wav));
    } catch {
      /* best effort persist; we still have it in memory */
    }
    console.log(`[pipeline] utterance #${mySeq}: ${(wav.length / 1024).toFixed(0)}KB (${durSec.toFixed(1)}s)`);
    this.chain = this.chain.then(() => this.process(file, wav, mySeq, durSec));
    // Surface queue errors so a broken key doesn't silently kill the session
    this.chain = this.chain.catch((err) => {
      console.error('[pipeline] chain error:', err);
    });
  }

  private async process(file: string, wav: Uint8Array, seq: number, durSec: number): Promise<void> {
    if (this.aborted) return;
    this.send({ type: 'state', state: 'processing', partialLive: true });
    try {
      console.log(`[pipeline] transcribing utterance #${seq} (${wav.length} bytes)...`);
      const { text } = await transcribeWithRetry(wav, '', this.abortController.signal);
      const trimmed = text.trim();
      console.log(`[pipeline] utterance #${seq} → "${trimmed.slice(0, 80)}"`);
      if (this.aborted || !trimmed) return;

      this.send({ type: 'stream', seq, liveText: trimmed, finalized: true });

      // Separate consecutive utterances with a space (but never lead with one).
      const pasteBody = (this.pastedAny ? ' ' : '') + trimmed;

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
      this.pastedAny = true;
      // Successful transcription + paste → record it for the dashboard history.
      this.opts.onRecording?.({
        id: randomUUID(),
        timestamp: Date.now(),
        durationSec: durSec,
        text: trimmed,
        wordCount: trimmed.split(/\s+/).filter(Boolean).length,
      });
    } catch (err) {
      if (this.aborted) return;
      console.error('[pipeline] utterance ERROR:', err);
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
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      if (!this.aborted) this.send({ type: 'state', state: 'recording' });
    }
  }

  // Alt+Q pressed while recording → wait for everything queued to paste, then resolve.
  async finish(): Promise<void> {
    console.log('[pipeline] finish — draining');
    try {
      await this.chain;
    } catch {
      /* surface already logged */
    }
  }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
    this.cleanup();
  }

  private cleanup(): void {
    try {
      rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      /* ignore */
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

export function cleanupOrphanSessions(): void {
  const temp = app.getPath('temp');
  try {
    require('node:fs').readdirSync(temp)
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
