import type { KeyStatus } from '@shared/index';
import { store } from './store';
import { groqKeysDecrypted } from './keys';

export interface TranscriptResult {
  text: string;
  keyId: string;
  raw: string;
}

interface KeyRuntime {
  id: string;
  label: string;
  hint: string;
  apiKey: string;
  status: KeyStatus;
  requestsToday: number;
  rateLimitedUntil: number; // epoch ms
  concurrency: number;
}

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_IN_FLIGHT_PER_KEY = 2;
// The one model: verified working end-to-end. Faster + less hallucination-prone
// on short clipped chunks than large-v3.
const GROQ_MODEL = 'whisper-large-v3-turbo';

// Prompt keeps Whisper v3 stable + verbatim. Whisper can hallucinate
// subtitle/caption text when chunks are short or low-energy, so explicitly
// forbid caption formatting, credits, or subtitle artifacts.
const GROQ_PROMPT =
  'Verbatim personal dictation, live recorded with a desktop mic. ' +
  'Plain continuous prose ONLY. Absolutely no subtitles, caption credits, ' +
  'website credits, watermarks, "Subtitles by…", "please subscribe", ' +
  'made-for-captions formatting, or any added intro/outro. ' +
  'Preserve all filler words, stutters, and false starts exactly as spoken. ' +
  'Preserve profanity verbatim; never censor. ' +
  'Never invent content the speaker did not say. ' +
  'If audio is unclear, output only what is clearly intelligible.';

let runtimes: KeyRuntime[] = [];
let pendingRefresh = new Set<() => void>();
let lastApiKeySig: string | null = null;

export function syncGroqKeys(): void {
  const fresh = groqKeysDecrypted();
  const sig = fresh.map((f) => f.apiKey).join('|');
  if (sig === lastApiKeySig) return;
  lastApiKeySig = sig;
  runtimes.forEach((r) => {
    const still = fresh.find((f) => f.id === r.id);
    if (still) {
      still.apiKey = r.apiKey;
    }
  });
  const byId = new Map(runtimes.map((r) => [r.id, r]));
  runtimes = fresh.map((f) => {
    const prev = byId.get(f.id);
    return prev
      ? { ...prev, label: f.label, hint: f.hint }
      : {
          id: f.id,
          label: f.label,
          hint: f.hint,
          apiKey: f.apiKey,
          status: 'ready' as KeyStatus,
          requestsToday: 0,
          rateLimitedUntil: 0,
          concurrency: 0,
        };
  });
}

export function groqKeySummaries(): Array<{
  id: string;
  label: string;
  hint: string;
  status: KeyStatus;
  requestsToday: number;
}> {
  return runtimes.map((r) => ({
    id: r.id,
    label: r.label,
    hint: r.hint,
    status: r.status,
    requestsToday: r.requestsToday,
  }));
}

function pickKey(): KeyRuntime | null {
  const now = Date.now();
  const available = runtimes.filter((r) => r.status !== 'invalid');
  const ready = available.filter((r) => r.rateLimitedUntil <= now && r.concurrency < MAX_IN_FLIGHT_PER_KEY);
  if (ready.length === 0) return null;
  // least-loaded key wins — audio-hours (ASH) aren't in headers, so rotation is fair by request count
  ready.sort((a, b) => a.requestsToday - b.requestsToday || a.concurrency - b.concurrency);
  return ready[0];
}

function parseRateReset(header: string | null): number {
  // Formats: "2m59.56s", "7.66s", plain seconds
  if (!header) return 0;
  const m = header.match(/^(?:(\d+)m)?([\d.]+)s?$/);
  if (m) return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  const n = parseFloat(header);
  return Number.isFinite(n) ? n : 0;
}

export class GroqExhaustedError extends Error {
  constructor(public retryAfterMs: number) {
    super('All Groq keys currently rate-limited');
  }
}

export async function transcribeChunk(wavBytes: Uint8Array, promptTail: string, signal: AbortSignal): Promise<TranscriptResult> {
  syncGroqKeys();
  const key = pickKey();
  if (!key) {
    const soonest = Math.min(...runtimes.filter((r) => r.status !== 'invalid').map((r) => r.rateLimitedUntil));
    throw new GroqExhaustedError(Math.max(1_000, soonest - Date.now()));
  }

  key.concurrency += 1;
  try {
    const prompt = (GROQ_PROMPT + (promptTail ? `\n\nRecent context (verbatim): ${promptTail}` : '')).slice(0, 3000);
    const fd = new FormData();
    fd.append('file', new Blob([wavBytes.slice().buffer], { type: 'audio/wav' }), `vq-${Date.now()}.wav`);
    fd.append('model', GROQ_MODEL);
    fd.append('language', store.disk.language || 'en');
    fd.append('response_format', 'text');
    fd.append('temperature', '0');
    fd.append('prompt', prompt);

    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.apiKey}` },
      body: fd,
      signal,
    });

    // ── rate-limit header bookkeeping (only request-count headers are reliable) ──
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining-requests') ?? 'NaN', 10);
    const limit = parseInt(res.headers.get('x-ratelimit-limit-requests') ?? 'NaN', 10);
    if (Number.isFinite(remaining) && Number.isFinite(limit)) {
      key.requestsToday = Math.max(key.requestsToday, limit - remaining);
    }

    if (res.status === 401) {
      key.status = 'invalid';
      throw new Error('Invalid API key');
    }
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get('retry-after') ?? '0') * 1000;
      const resetMs = parseRateReset(res.headers.get('x-ratelimit-reset-requests')) * 1000;
      key.rateLimitedUntil = Date.now() + Math.max(retryAfter, resetMs, 5_000);
      key.status = 'exhausted';
      throw new GroqExhaustedError(Math.max(retryAfter, 1_000));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status >= 500) throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
      key.status = 'error';
      setTimeout(() => {
        if (key.status === 'error') key.status = 'ready';
      }, 30_000);
      throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
    }

    key.status = 'ready';
    key.requestsToday += 1;
    const text = sanitizeTranscript((await res.text()).trim());
    return { text, keyId: key.id, raw: text };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (err instanceof GroqExhaustedError) throw err;
    if (err instanceof TypeError || /fetch|network|terminated/i.test((err as Error).message)) {
      throw Object.assign(new Error('network'), { retryable: true, cause: err });
    }
    throw err;
  } finally {
    key.concurrency = Math.max(0, key.concurrency - 1);
    if (pendingRefresh.size > 0) {
      const fns = Array.from(pendingRefresh);
      pendingRefresh.clear();
      fns.forEach((fn) => fn());
    }
  }
}

// ── Whisper hallucination guard ────────────────────────────────────────────
// Short, quiet, or noise-only chunks make Whisper invent captions, credits,
// subscription plea's, and loops that repeat one line over and over. If the
// model "hallucinates" it almost always produces one of these shapes; drop it
// so junk never reaches your cursor.

const HALLUCINATION_PATTERNS = [
  /please subscribe/i,
  /subtitles by/i,
  /subtitle credits/i,
  /translated by/i,
  /transcribed by/i,
  /thanks for watching/i,
  /thank you for watching/i,
  /don't forget to (like|subscribe)/i,
  /www\.[a-z0-9-]+\.(com|net|org|io)/i,
  /copyright/i,
];

function sanitizeTranscript(raw: string): string {
  let text = raw;
  if (!text) return '';

  // 1. Cut the classic "X. X. X. X.…" loop — same sentence repeated 3+ times back to back.
  //    Works on any sentence ending in . ? !
  const loopMatch = text.match(/^(.{3,120}?[.?!])(\s+\1){2,}\s*$/);
  if (loopMatch) {
    text = loopMatch[1];
  }

  // 2. Kill known caption/subtitle hallucination lines entirely.
  const sentences = text.split(/(?<=[.?!])\s+/);
  const kept = sentences.filter((s) => !HALLUCINATION_PATTERNS.some((p) => p.test(s)));
  text = kept.join(' ').trim();

  // 3. If what's left is just repeated 1–3 word noise ("Rrrrr", "Preserve."),
  //    and nothing else, drop it.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[.?!,]/g, '')));
    if (uniq.size <= 2) return ''; // e.g. "Preserve. Preserve. Preserve. Preserve."
  }

  // 4. Pure non-speech noise (no vowels at all) → drop.
  if (text && !/[aeiou]/i.test(text.replace(/[^a-z]/gi, ''))) return '';

  return text;
}

export function onKeyStateChange(fn: () => void): void {
  pendingRefresh.add(fn);
}

export function keysAvailable(): number {
  const now = Date.now();
  return runtimes.filter((r) => r.status === 'ready' && r.rateLimitedUntil <= now).length;
}

export function hasAnyKey(): boolean {
  return runtimes.length > 0;
}
