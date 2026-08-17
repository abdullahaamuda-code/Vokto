import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { VoquaRecorder } from './audio';
import type { OverlayCmd, SessionState } from '@shared/index';

declare global {
  interface Window {
    vqOverlay: import('../../preload/overlay').OverlayApi;
  }
}

// Whisper-Flow tiny capsule. A slim pill that sits bottom-center, pure waveform
// only, no text. Cursor follows your voice peaks. Sleek.

// The capsule card hugs the bottom of the (500x160) always-on-top window.
// The transcript bubble grows upward from the pill so the pill never jumps.
const PILL_W = 94;
const PILL_H = 36;
const PILL_R = PILL_H / 2; // perfect capsule
const CARD_BOTTOM = 12; // the whole card hugs the bottom of the window
const TRANS_W = 464;
const TRANS_MAX_LINES = 3;

function useOverlayDrag() {
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const last = useRef({ x: 0, y: 0 });

  // The pill stays pinned dead-center of the fixed 340x88 window via CSS
  // (left/top 50% + translate) — no per-frame JS transform fighting the drag.

  // Drags use screen-global deltas so the window follows the cursor exactly,
  // no matter where on the pill you grabbed. Starting a drag re-centers via
  // deltas only — never jumps.
  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    last.current = { x: e.screenX, y: e.screenY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.screenX - last.current.x;
    const dy = e.screenY - last.current.y;
    if (dx === 0 && dy === 0) return;
    last.current = { x: e.screenX, y: e.screenY };
    void window.vqOverlay.dragBy(dx, dy);
  };
  const onPointerUp = () => {
    setDragging(false);
  };
  // The "move" cursor only appears while the pointer is actually over the
  // pill — never over the click-through area around it.
  const onPointerEnter = () => setHovering(true);
  const onPointerLeave = () => setHovering(false);
  const cursor = dragging ? 'grabbing' : hovering ? 'grab' : 'default';
  return { onPointerDown, onPointerMove, onPointerUp, onPointerEnter, onPointerLeave, cursor };
}

// Short, quiet double-beep to draw attention when something goes wrong
// (Groq rate-limit, network drop, mic failure). Played even if the pill is
// hidden so the user isn't left staring at silent failure.
function playErrorSound(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const playTone = (start: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    };
    playTone(now, 440);
    playTone(now + 0.18, 330);
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    /* audio feedback is best-effort */
  }
}

export function App() {
  const [state, setState] = useState<SessionState>('idle');
  const [warning, setWarning] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const levelRef = useRef(0);
  const [micError, setMicError] = useState(false);
  // Live "are they talking right now" — drives the glow/fade every frame.
  const [speakingNow, setSpeakingNow] = useState(false);
  const [queuedBlink, setQueuedBlink] = useState(false); // brief dot pulse when a chunk ships
  const [latencyMs, setLatencyMs] = useState<number | null>(null); // Groq round-trip for last utterance
  // Rolling transcript of the current session — newest on top. This is what
  // makes it feel like streaming: words land in the pill as they're transcribed.
  const [transcript, setTranscript] = useState<string[]>([]);
  const shipAtRef = useRef(0);
  const latencyTimerRef = useRef(0);
  const recorderRef = useRef<VoquaRecorder | null>(null);
  const drag = useOverlayDrag();

  useEffect(() => {
    const recorder = new VoquaRecorder({
      onSilenceStart: () => void window.vqOverlay.stopDictation(),
      onFlushEnd: (wav, dur) => {
        console.log(`[OverlayApp] flush-end: ${wav.byteLength} bytes, ${dur}s`);
        shipAtRef.current = performance.now();
        void window.vqOverlay.vadEvent('flush-end', { wav, durationSec: dur });
      },
      onUtterancePause: () => {
        // brief pulse so you can feel the sentence get shipped
        setQueuedBlink(true);
        window.setTimeout(() => setQueuedBlink(false), 520);
      },
      onError: () => {
        setMicError(true);
        setWarning('Mic unavailable');
        playErrorSound();
      },
    });
    recorderRef.current = recorder;

    window.vqOverlay.onState((cmd: OverlayCmd) => {
      if (cmd.type === 'state') {
        setState(cmd.state);
        if (cmd.state === 'recording') {
          setWarning(null);
          setVisible(true);
          setTranscript([]); // fresh session, fresh transcript
        }
        if (cmd.state === 'idle') {
          window.setTimeout(() => setVisible(false), 280);
        }
      } else if (cmd.type === 'status' && cmd.warning) {
        setWarning(cmd.warning);
        playErrorSound();
      } else if (cmd.type === 'stream') {
        const ms = Math.round(performance.now() - shipAtRef.current);
        if (ms > 0) {
          setLatencyMs(ms);
          window.clearTimeout(latencyTimerRef.current);
          latencyTimerRef.current = window.setTimeout(() => setLatencyMs(null), 2200);
        }
        if (cmd.finalized && cmd.liveText) {
          setTranscript((prev) => {
            const line = cmd.liveText;
            const next = [line, ...prev].slice(0, TRANS_MAX_LINES);
            return next;
          });
        }
      } else if (cmd.type === 'reset') {
        setWarning(null);
      }
    });

    window.vqOverlay.onAudioCmd((c) => {
      console.log(`[OverlayApp] AudioCmd:`, c);
      if (c.type === 'set-recording') {
        if (c.on) {
          void recorder.ensureMic().then(() => {
            console.log(`[OverlayApp] recorder started`);
            recorder.start();
          }).catch(() => setWarning('Mic error'));
        } else {
          console.log(`[OverlayApp] stopping recorder...`);
          recorder.stop();
        }
      } else if (c.type === 'set-mic') {
        void recorder.setDevice(c.deviceId).catch(() => undefined);
      }
    });

    window.vqOverlay.overlayReady();

    // Smooth follow: attack fast, release slow — like a real VU meter.
    // Also continuously mirrors "is the user talking" straight from the VAD so
    // the pill fades the instant you go quiet and flares the instant you speak.
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const r = recorderRef.current;
      const target = r ? Math.min(1, r.level * 4) : 0;
      const cur = levelRef.current;
      const rate = target > cur ? 14 : 4.5; // fast attack, slow release
      const next = cur + (target - cur) * Math.min(1, rate * dt);
      levelRef.current = next;
      setMicLevel(next);
      setSpeakingNow(!!r && r.isSpeakingNow);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      recorder.dispose();
    };
  }, []);

  const listening = state === 'recording';
  // Glow follows your VOICE: bright while you're talking, softly fades the
  // instant you go quiet (whether or not a sentence was just shipped), and
  // flares straight back up the moment you speak again. The pill NEVER
  // disappears until you press Alt+Q.
  const glow = listening && speakingNow;

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: 'transparent' }}>
      <AnimatePresence>
        {visible && (
          <motion.div
            id="vq-bar"
            initial={{ opacity: 0, scale: 0.9, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 5 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30 }}
            className="absolute flex flex-col items-center gap-[8px] select-none"
            style={{
              bottom: CARD_BOTTOM,
              left: '50%',
              transform: 'translateX(-50%)',
              cursor: drag.cursor,
              touchAction: 'none',
            }}
            {...drag}
          >
            {/* live transcript bubble — appears ABOVE the pill, newest on top.
                The card is bottom-anchored, so the bubble grows upward and the
                capsule never jumps. Whole card is one draggable surface. */}
            <AnimatePresence>
              {transcript.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className="rounded-xl px-3 py-2 text-[11px] leading-snug"
                  style={{
                    width: TRANS_W,
                    background: 'rgba(10,10,15,0.72)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    backdropFilter: 'blur(16px) saturate(160%)',
                    boxShadow: '0 8px 24px -12px rgba(0,0,0,0.8)',
                  }}
                >
                  {state === 'processing' && (
                    <div className="text-glow-soft/70 italic animate-pulse">…</div>
                  )}
                  {transcript.map((line, i) => (
                    <div
                      key={`${i}-${line}`}
                      className="whitespace-pre-wrap break-words overflow-hidden"
                      style={{
                        maxHeight: 18,
                        color: i === 0 ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.4)',
                        fontStyle: i === 0 ? 'normal' : 'italic',
                      }}
                    >
                      {line}
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* the capsule */}
            <div
              className="flex items-center justify-center gap-[7px] px-[9px]"
              style={{
                width: PILL_W,
                height: PILL_H,
                borderRadius: PILL_R,
                background: glow
                  ? 'linear-gradient(165deg, rgba(28,22,12,0.94), rgba(13,11,6,0.92))'
                  : 'rgba(12,12,17,0.92)',
                backdropFilter: 'blur(22px) saturate(170%)',
                border: glow ? '1px solid rgba(232,176,74,0.28)' : '1px solid rgba(255,255,255,0.08)',
                boxShadow: glow
                  ? '0 10px 32px -10px rgba(0,0,0,0.9), 0 0 0 1px rgba(232,176,74,0.10), 0 0 20px -4px rgba(232,176,74,0.35)'
                  : '0 10px 28px -10px rgba(0,0,0,0.85)',
                opacity: listening ? (glow ? 1 : 0.62) : 1,
                transition:
                  'background 220ms ease, border 220ms ease, box-shadow 220ms ease, opacity 240ms ease',
              }}
            >
              {/* status dot — pulses once when a sentence ships, bright while talking */}
              <motion.span
                className="block rounded-full shrink-0"
                style={{
                  width: 5,
                  height: 5,
                  background: micError ? '#ff5c74' : glow ? '#e8b04a' : '#6b6b7e',
                  boxShadow: glow ? '0 0 6px rgba(232,176,74,0.7)' : 'none',
                  transition: 'background 220ms ease, box-shadow 220ms ease',
                }}
                animate={queuedBlink ? { scale: [1, 1.9, 1], opacity: [1, 0.5, 1] } : glow ? { opacity: [0.85, 1, 0.85] } : {}}
                transition={queuedBlink ? { duration: 0.5 } : glow ? { duration: 2.1, repeat: Infinity } : {}}
              />
              {/* waveform — fixed slim width, no stretch */}
              <SlimWave level={micLevel} active={glow} error={micError} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {visible && warning && (
          <motion.p
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute left-1/2 -translate-x-1/2 text-[10px] text-warn text-center max-w-[220px] leading-snug"
            style={{ bottom: CARD_BOTTOM + PILL_H + 16 }}
          >
            {warning}
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {visible && latencyMs !== null && !warning && (
          <motion.span
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute left-1/2 -translate-x-1/2 font-mono text-[9px] tracking-wide text-glow-soft/80"
            style={{ bottom: CARD_BOTTOM + PILL_H + 10 }}
          >
            {latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${latencyMs}ms`}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function SlimWave({ level, active, error }: { level: number; active: boolean; error: boolean }) {
  // 10 bars, newest right, history left. Fixed width so the pill hugs it exactly.
  const N = 10;
  const hist = useRef<number[]>(new Array(N).fill(0));

  useEffect(() => {
    hist.current.push(level);
    hist.current.shift();
  });

  const color = error ? '#ff5c74' : '#e8b04a';
  if (!active) {
    return <div className="h-[2px] rounded-full bg-white/10" style={{ width: 38 }} />;
  }
  return (
    <div className="flex items-center gap-[2px] h-[16px]" style={{ width: 38 }} aria-hidden>
      {hist.current.map((v, i) => {
        const h = Math.max(2, Math.min(15, v * 15));
        return (
          <motion.span
            key={i}
            className="rounded-full flex-shrink-0"
            style={{
              width: 2,
              height: h,
              background: color,
              opacity: 0.25 + (i / N) * 0.75,
            }}
          />
        );
      })}
    </div>
  );
}
