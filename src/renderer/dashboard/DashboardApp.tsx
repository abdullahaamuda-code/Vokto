import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import type { RecordingEntry } from '@shared/index';
import appIcon from './assets/icon.png';

declare global {
  interface Window {
    vkDashboard: import('../../preload/dashboard').DashboardApi;
  }
}

// ── Palette (matches the gold overlay) ──────────────────────────────────────
const BG = '#0c0c11';
const GOLD = '#e8b04a';
const GOLD_SOFT = '#f5cf85';
const GOLD_HOT = '#c78f1e';
const AMBER = '#ffb454';
const RED = '#ff5c74';

// Keep in sync with RECORDINGS_MAX_BYTES in src/main/recordings.ts
const CAP_BYTES = 2 * 1024 * 1024;

// ── Small format helpers ────────────────────────────────────────────────────

function bytesOf(list: RecordingEntry[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(list)).length;
  } catch {
    return 0;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

function fmtDuration(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function preview(text: string, max = 90): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

// One plain-text block per recording, newest first, with a friendly header.
function exportBody(list: RecordingEntry[]): string {
  return list
    .map((r) => `[${new Date(r.timestamp).toLocaleString()}]${r.durationSec >= 0 ? ` (${fmtDuration(r.durationSec)})` : ''}\n${r.text.trim()}\n`)
    .join('\n');
}

// ── Motion ──────────────────────────────────────────────────────────────────

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.08 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: 'easeOut' } },
};

// ── App ─────────────────────────────────────────────────────────────────────

export function DashboardApp() {
  const [recordings, setRecordings] = useState<RecordingEntry[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.vkDashboard.getRecordings().then((list) => {
      if (alive) setRecordings(Array.isArray(list) ? list : []);
    });
    const unsubscribe = window.vkDashboard.onRecordingCompleted((rec) => {
      setRecordings((prev) => {
        const base = prev ?? [];
        if (base.some((r) => r.id === rec.id)) return base;
        return [rec, ...base];
      });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Auto-dismiss the "sure?" clear confirmation after a beat.
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 2600);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  const sorted = useMemo(
    () => (recordings ?? []).slice().sort((a, b) => b.timestamp - a.timestamp),
    [recordings],
  );

  const usedBytes = useMemo(() => bytesOf(sorted), [sorted]);
  const pct = Math.min(100, (usedBytes / CAP_BYTES) * 100);
  const almostFull = pct > 80;
  const gaugeColor = pct > 95 ? RED : almostFull ? AMBER : GOLD;

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    await window.vkDashboard.clearRecordings();
    setRecordings([]);
  };

  return (
    <div className="relative h-full overflow-y-auto" style={{ background: BG }}>
      {/* atmosphere: soft gold aura rising from the top + faint vignette */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[360px]"
        style={{ background: 'radial-gradient(620px 280px at 50% -90px, rgba(232,176,74,0.14), transparent 72%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{ background: 'radial-gradient(120% 90% at 50% 10%, transparent 55%, rgba(0,0,0,0.45) 100%)' }}
      />

      <div className="relative max-w-[720px] mx-auto px-8 pt-12 pb-16">
        {/* ── Header ── */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          className="flex items-start justify-between gap-6"
        >
          <div className="flex items-center gap-4">
            <img
              src={appIcon}
              alt="Vokto"
              className="inline-block w-11 h-11 rounded-2xl shrink-0"
              style={{ boxShadow: '0 10px 28px -8px rgba(232,176,74,0.45)' }}
            />
            <div>
              <h1
                className="text-[40px] leading-none font-bold tracking-tight"
                style={{
                  backgroundImage: `linear-gradient(115deg, ${GOLD_SOFT}, ${GOLD} 48%, ${GOLD_HOT})`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                Vokto
              </h1>
              <p className="text-ink-300 text-[12.5px] mt-1.5 tracking-wide">
                Speak, and it types — wherever your cursor lives.
              </p>
            </div>
          </div>

          <button
            onClick={() => window.vkDashboard.openSettings()}
            className="shrink-0 mt-1.5 px-4 py-2 rounded-full text-[12.5px] font-medium tracking-wide transition-all duration-200 hover:bg-glow/10 active:scale-[0.97]"
            style={{ color: GOLD_SOFT, border: '1px solid rgba(232,176,74,0.35)' }}
          >
            Settings
          </button>
        </motion.header>

        {/* hairline divider under the header */}
        <div
          aria-hidden
          className="my-8 h-px"
          style={{ background: 'linear-gradient(90deg, transparent, rgba(232,176,74,0.35) 18%, rgba(232,176,74,0.35) 82%, transparent)' }}
        />

        {/* ── Storage gauge ── */}
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-ink-300 text-[11px] uppercase tracking-[0.14em]">History storage</p>
            <p className="font-mono text-[11px]" style={{ color: almostFull ? gaugeColor : '#8a8aa3' }}>
              {fmtBytes(usedBytes)} <span className="text-ink-400">/ {fmtBytes(CAP_BYTES)}</span>
            </p>
          </div>
          <div className="h-[5px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
            <motion.div
              className="h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(pct, usedBytes > 0 ? 1.5 : 0)}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              style={{
                background: `linear-gradient(90deg, ${GOLD_HOT}, ${gaugeColor})`,
                boxShadow: `0 0 10px -2px ${gaugeColor}88`,
              }}
            />
          </div>
          <AnimatePresence>
            {almostFull && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-2 text-[12px]"
                style={{ color: gaugeColor }}
              >
                Storage almost full — oldest recordings are pruned automatically.
              </motion.p>
            )}
          </AnimatePresence>
        </motion.section>

        {/* ── History ── */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-ink-100 text-[15px] font-medium tracking-tight">
            Transcriptions
            {sorted.length > 0 && (
              <span className="ml-2 font-mono text-[11px] text-ink-400">{sorted.length}</span>
            )}
          </h2>
          {sorted.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(exportBody(sorted));
                }}
                className="text-[11.5px] px-3 py-1.5 rounded-lg transition-colors hover:border-glow/40"
                style={{ color: '#8a8aa3', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Copy all
              </button>
              <button
                onClick={() => {
                  const blob = new Blob([exportBody(sorted)], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `vokto-${new Date().toISOString().slice(0, 10)}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="text-[11.5px] px-3 py-1.5 rounded-lg transition-colors hover:border-glow/40"
                style={{ color: '#8a8aa3', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Export .txt
              </button>
              <button
                onClick={() => void handleClear()}
                className="text-[11.5px] px-3 py-1.5 rounded-lg transition-colors"
                style={
                  confirmClear
                    ? { color: RED, border: '1px solid rgba(255,92,116,0.4)', background: 'rgba(255,92,116,0.08)' }
                    : { color: '#8a8aa3', border: '1px solid transparent' }
                }
              >
                {confirmClear ? 'Click again to confirm' : 'Clear history'}
              </button>
            </div>
          )}
        </div>

        {recordings === null ? (
          <p className="text-ink-400 text-sm text-center py-20">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState />
        ) : (
          <motion.ul className="space-y-3" variants={listVariants} initial="hidden" animate="show">
            <AnimatePresence initial={false}>
              {sorted.map((r) => (
                <motion.li key={r.id} variants={itemVariants} exit={{ opacity: 0, x: -14 }} layout>
                  <article
                    className="group relative rounded-2xl px-5 py-4 transition-colors duration-200 hover:border-glow/40"
                    style={{
                      background: 'rgba(16,16,24,0.72)',
                      border: '1px solid rgba(30,30,44,0.9)',
                      backdropFilter: 'blur(8px)',
                    }}
                  >
                    {/* gold spine */}
                    <span
                      aria-hidden
                      className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full opacity-70 group-hover:opacity-100 transition-opacity"
                      style={{ background: `linear-gradient(180deg, ${GOLD}, rgba(232,176,74,0.12))` }}
                    />
                    <div className="flex items-center justify-between mb-1.5 pl-2">
                      <span className="font-mono text-[11px] tracking-wide" style={{ color: GOLD_SOFT }}>
                        {fmtWhen(r.timestamp)}
                      </span>
                      <span className="font-mono text-[11px] text-ink-400">
                        {fmtDuration(r.durationSec)} · {r.wordCount} {r.wordCount === 1 ? 'word' : 'words'}
                      </span>
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-ink-200 pl-2 select-text">{preview(r.text)}</p>
                    <div className="flex justify-end mt-2 pr-1">
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(r.text);
                        }}
                        className="text-[10.5px] px-2 py-1 rounded-lg transition-all hover:border-glow/40"
                        style={{ color: '#8a8aa3', border: '1px solid transparent' }}
                      >
                        Copy
                      </button>
                    </div>
                  </article>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}

        <p className="text-center text-ink-400 text-[11px] mt-10">
          Everything stays on this machine — history lives in a local file, nothing is uploaded.
        </p>
      </div>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="text-center py-16 px-6 rounded-2xl"
      style={{ border: '1px dashed rgba(82,82,112,0.4)' }}
    >
      {/* breathing waveform glyph */}
      <div className="flex items-end justify-center gap-[3px] h-[26px] mb-5" aria-hidden>
        {[8, 16, 24, 16, 8].map((h, i) => (
          <motion.span
            key={i}
            className="w-[3px] rounded-full"
            style={{ background: GOLD, opacity: 0.85 }}
            animate={{ height: [h * 0.45, h, h * 0.45], opacity: [0.4, 0.9, 0.4] }}
            transition={{ duration: 1.9, repeat: Infinity, delay: i * 0.16, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <p className="text-ink-100 text-[15px] font-medium mb-1.5">Nothing here yet</p>
      <p className="text-ink-400 text-[13px] leading-relaxed max-w-[360px] mx-auto">
        Your transcriptions will appear here — press <Kbd>Alt</Kbd>+<Kbd>Q</Kbd> and start talking.
      </p>
    </motion.div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded-md bg-ink-700 border border-ink-600 text-[10px] font-mono text-ink-200">
      {children}
    </kbd>
  );
}
