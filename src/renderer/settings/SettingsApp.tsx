import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { PublicSettings } from '@shared/index';

declare global {
  interface Window {
    vqSettings: import('../../preload/settings').SettingsApi;
  }
}

const GUIDE_STEPS = [
  'Go to console.groq.com',
  'Sign up or log in',
  'Navigate to API Keys',
  'Create a new key and copy it',
  'Paste it above',
];

const HOTKEY_PRESETS = ['Alt+Q', 'Ctrl+Shift+Space', 'Alt+Space', 'Ctrl+Alt+D'];

// Build an Electron accelerator (e.g. "Ctrl+Alt+D", "F5", "Alt+Space") from a
// physical KeyboardEvent. We use e.code (physical key, e.g. "KeyD"/"Digit1")
// instead of e.key — e.key turns Ctrl+<letter> into invisible control chars
// (Ctrl+D -> "\x04") which would corrupt the stored shortcut.
function acceleratorFromEvent(e: React.KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const code = e.code;
  let key: string;
  if (code.startsWith('Key') && code.length === 4) key = code.slice(3);
  else if (code.startsWith('Digit') && code.length === 6) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code === 'Enter') key = 'Enter';
  else if (code === 'Tab') key = 'Tab';
  else if (code === 'Backspace') key = 'Backspace';
  else if (code === 'Delete') key = 'Delete';
  else if (code === 'Insert') key = 'Insert';
  else if (code === 'Home') key = 'Home';
  else if (code === 'End') key = 'End';
  else if (code === 'PageUp') key = 'PageUp';
  else if (code === 'PageDown') key = 'PageDown';
  else if (code === 'Escape') key = 'Esc';
  else if (code === 'ArrowUp') key = 'Up';
  else if (code === 'ArrowDown') key = 'Down';
  else if (code === 'ArrowLeft') key = 'Left';
  else if (code === 'ArrowRight') key = 'Right';
  else if (/^Numpad\d$/.test(code)) key = code.slice(6);
  else {
    const single = e.key.trim().toUpperCase();
    if (single.length !== 1 || !/[A-Z0-9]/.test(single)) return '';
    key = single;
  }

  if (mods.length === 0 && !/^(F\d{1,2}|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Esc|Up|Down|Left|Right)$/.test(key)) {
    return '';
  }
  return [...mods, key].join('+');
}

export function SettingsApp() {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [newKey, setNewKey] = useState('');
  const [hotkeyDraft, setHotkeyDraft] = useState('');
  const [hotkeyErr, setHotkeyErr] = useState(false);
  const [hotkeyConflict, setHotkeyConflict] = useState<string | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    void window.vqSettings.getSettings().then((next) => {
      setS(next);
      setHotkeyDraft(next.hotkey);
    });
    window.vqSettings.onSettingsChanged((next) => {
      setS(next);
      setHotkeyDraft(next.hotkey);
    });
    window.vqSettings.onHotkeyConflict((accel) => {
      setHotkeyConflict(accel);
      window.setTimeout(() => setHotkeyConflict(null), 5000);
    });
  }, []);

  const flashSaved = () => {
    setSaveFlash(true);
    window.setTimeout(() => setSaveFlash(false), 1200);
  };

  const update = async (patch: Partial<PublicSettings>) => {
    const next = await window.vqSettings.updateSettings(patch);
    setS(next);
    setHotkeyDraft(next.hotkey);
    flashSaved();
  };

  const saveHotkey = async () => {
    const hk = hotkeyDraft.trim();
    if (!hk) {
      setHotkeyErr(true);
      return;
    }
    setHotkeyErr(false);
    await update({ hotkey: hk });
  };

  if (!s) {
    return (
      <div className="h-full flex items-center justify-center text-ink-400 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[560px] mx-auto px-6 py-8">
        {/* header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ background: 'linear-gradient(150deg, #f5cf85, #e8b04a 55%, #c78f1e)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}
            >
              Vokto
            </h1>
            <p className="text-ink-400 text-[13px] mt-1">
              Press <Kbd>{s.hotkey}</Kbd> anywhere, talk, text appears at your cursor.
            </p>
          </div>
          <AnimatePresence>
            {saveFlash && (
              <motion.span
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-mint text-[12px] flex items-center gap-1"
              >
                ● saved
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Groq API key */}
        <Section title="Groq API key" sub="Paste your Groq key below — Vokto uses it to turn your voice into text.">
          <div className="flex gap-2 mb-3">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="gsk_…"
              type="password"
              className="flex-1 bg-ink-800 border border-ink-600/60 rounded-xl px-3 py-2.5 text-[13px] text-ink-100 placeholder:text-ink-400 focus:outline-none focus:border-glow/60 font-mono"
            />
            <button
              onClick={async () => {
                if (!newKey.trim()) return;
                setS(await window.vqSettings.addKey('key', newKey));
                setNewKey('');
                flashSaved();
              }}
              className="px-4 py-2.5 rounded-xl text-[13px] font-medium text-black shrink-0"
              style={{ background: 'linear-gradient(150deg, #f5cf85, #e8b04a)' }}
            >
              Save
            </button>
          </div>

          {s.groqKeys.length === 0 ? (
            <div className="flex items-center gap-2.5 bg-ink-850 border border-ink-700 rounded-xl px-3.5 py-3">
              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: '#525270' }} />
              <p className="text-ink-400 text-[12px]">No key set</p>
            </div>
          ) : (
            <div className="space-y-2">
              {s.groqKeys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between bg-ink-850 border border-ink-700 rounded-xl px-3.5 py-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{
                        background:
                          k.status === 'ready'
                            ? '#34e0b4'
                            : k.status === 'exhausted'
                              ? '#ffb454'
                              : '#ff5c74',
                        boxShadow:
                          k.status === 'ready' ? '0 0 8px rgba(52,224,180,0.4)' : 'none',
                      }}
                    />
                    <div className="min-w-0">
                      <p className="text-ink-200 text-[12px] truncate">
                        {k.label} <span className="text-ink-400 font-mono">…{k.hint}</span>
                      </p>
                      <p className="text-ink-400 text-[10px] mt-0.5">
                        {k.status === 'ready'
                          ? 'ready'
                          : k.status === 'exhausted'
                            ? 'rate-limited'
                            : k.status}
                        {' · '}
                        {k.requestsToday} req today
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setS(await window.vqSettings.removeKey(k.id));
                      flashSaved();
                    }}
                    className="text-[11px] px-2 py-1 rounded-lg transition-colors shrink-0"
                    style={{ color: '#8a8aa3', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* How to get a Groq API key */}
          <div className="mt-4 rounded-xl border border-ink-700/70 overflow-hidden">
            <button
              onClick={() => setGuideOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3.5 py-3 text-left hover:bg-white/[0.03] transition-colors"
            >
              <span className="text-ink-200 text-[12px] font-medium">How to get a Groq API key</span>
              <motion.span
                animate={{ rotate: guideOpen ? 180 : 0 }}
                transition={{ duration: 0.2 }}
                className="text-ink-400 text-[10px]"
              >
                ▼
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {guideOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                >
                  <ol className="px-3.5 pb-3.5 pt-1 space-y-2">
                    {GUIDE_STEPS.map((step, i) => (
                      <li key={step} className="flex items-start gap-2.5">
                        <span className="mt-0.5 shrink-0 rounded-full bg-glow/10 border border-glow/30 text-glow-soft text-[10px] font-medium flex items-center justify-center" style={{ width: 18, height: 18 }}>
                          {i + 1}
                        </span>
                        <span className="text-ink-300 text-[12px] leading-relaxed">
                          {i === 0 ? (
                            <>Go to <span className="text-glow-soft font-mono">console.groq.com</span></>
                          ) : (
                            step
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Section>

        {/* Dictation shortcut */}
        <Section title="Dictation shortcut" sub="Choose the global hotkey that starts and stops dictation anywhere.">
          <div className="flex gap-2">
            <input
              value={hotkeyDraft}
              onChange={(e) => {
                setHotkeyDraft(e.target.value);
                setHotkeyErr(false);
                setHotkeyConflict(null);
              }}
              onKeyDown={(e) => {
                e.preventDefault();
                const combo = acceleratorFromEvent(e);
                if (combo) {
                  setHotkeyDraft(combo);
                  setHotkeyErr(false);
                }
              }}
              placeholder="Ctrl+Alt+D"
              className="flex-1 bg-ink-800 border border-ink-600/60 rounded-xl px-3 py-2.5 text-[13px] text-ink-100 placeholder:text-ink-400 focus:outline-none focus:border-glow/60 font-mono"
            />
            <button
              onClick={() => void saveHotkey()}
              className="px-4 py-2.5 rounded-xl text-[13px] font-medium text-black shrink-0"
              style={{ background: 'linear-gradient(150deg, #f5cf85, #e8b04a)' }}
            >
              Set
            </button>
          </div>
          {hotkeyErr && (
            <p className="text-[11px] mt-2" style={{ color: '#ff5c74' }}>
              Invalid shortcut — use the text field above and press keys on your keyboard (e.g. Ctrl+Alt+D).
            </p>
          )}
          {hotkeyConflict && (
            <AnimatePresence>
              <motion.p
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-[11px] mt-2 flex items-center gap-1.5"
                style={{ color: '#ff5c74' }}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#ff5c74' }} />
                {hotkeyConflict} is already in use by another app — it reverted to your previous shortcut. Pick a different one.
              </motion.p>
            </AnimatePresence>
          )}
          {/* preset chips */}
          <div className="flex flex-wrap gap-2 mt-4">
            {HOTKEY_PRESETS.map((preset) => {
              const active = s.hotkey === preset;
              return (
                <button
                  key={preset}
                  onClick={() => void update({ hotkey: preset })}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-mono transition-all ${active ? 'text-black' : 'text-ink-200 hover:border-glow/40'}`}
                  style={active ? { background: 'linear-gradient(150deg, #f5cf85, #e8b04a)' } : { border: '1px solid rgba(82,82,112,0.5)' }}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </Section>

        {/* Behavior */}
        <Section title="Behavior" sub="">
          <Row
            label="Auto-paste"
            desc="After a pause in your speech, Vokto automatically pastes the transcribed text into whatever app you're using."
            checked={s.autoPaste}
            onChange={(v) => void update({ autoPaste: v })}
          />
        </Section>

        <p className="text-center text-ink-400 text-[11px] mt-6 pb-4">
          Vokto runs entirely on your machine. Your key is encrypted with Windows DPAPI and never leaves this PC except to call Groq.
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6 rounded-2xl border border-ink-700/70 bg-ink-900/70 p-5" style={{ backdropFilter: 'blur(10px)' }}>
      <div className="mb-4">
        <h2 className="text-ink-100 text-[15px] font-medium">{title}</h2>
        {sub && <p className="text-ink-400 text-[12px] mt-1 leading-relaxed max-w-[380px]">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function Row({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-ink-100 text-[13px]">{label}</p>
        <p className="text-ink-400 text-[11px] mt-0.5 max-w-[360px] leading-relaxed">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-glow' : 'bg-ink-600'}`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded-md bg-ink-700 border border-ink-600 text-[10px] font-mono text-ink-200">
      {children}
    </kbd>
  );
}