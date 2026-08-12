# Vokto — personal dev notes

My own scratchpad for tracking bug fixes and future additions. Worked examples of exactly where things live, so I can fix or add without re-exploring the whole codebase each time.

## Quick commands

```bash
npm run dev           # hot-reload development
npm run build         # compile to out/
npm run typecheck     # tsc for main + renderer
npm run dist          # portable .exe
npm run dist:full     # NSIS installer
```

## File map (what to touch for what)

| I want to change… | File(s) |
|---|---|
| The global hotkey (default Alt+Q) + conflict handling | `src/main/index.ts` → `registerHotkey()` / `notifyHotkeyConflict()`, settings UI in `src/renderer/settings/SettingsApp.tsx` |
| Groq keys / rotation / rate limits / key health | `src/main/groq.ts`, key list UI in `SettingsApp.tsx` |
| How chunks are queued + transcribed | `src/main/pipeline.ts` |
| Auto-paste / clipboard / hidden SendKeys | `src/main/paste.ts` |
| The pill UI (waveform, glow, drag, latency, error beep) | `src/renderer/overlay/App.tsx` |
| Mic / VAD / chunking | `src/renderer/overlay/audio.ts` |
| Settings screen | `src/renderer/settings/SettingsApp.tsx` |
| History dashboard + copy/export | `src/renderer/dashboard/DashboardApp.tsx` |
| App icon | `profile pic.ico` → `build/icon.ico` (via `npm run icon`), dashboard uses `src/renderer/dashboard/assets/icon.png` |
| Shared types + IPC contract | `packages/shared/src/index.ts` |
| Windows installer config | `package.json` → `"build"` |

## Feature notes

- **Hotkey conflict detection** (`v0.1`): only the configured shortcut is ever active. If a chosen combo is already taken by another app, main shows a native notification + the settings window shows an inline red warning, and the stored hotkey reverts to the previous working one. Test by setting something already used (e.g. Ctrl+C).
- **Key health** (`v0.1`): Settings now lists every Groq key with live status (ready / rate-limited / error / invalid), today's request count, and a Remove button.
- **Latency meter** (`v0.1`): the pill flashes the Groq round-trip time (ms or s) for ~2s after each utterance lands. Measured renderer-side between `onFlushEnd` and the `stream` command arriving.
- **Hidden SendKeys** (`v0.1`): auto-paste spawns PowerShell with `-WindowStyle Hidden` + `windowsHide: true` — no black console flash anymore.
- **Error beep** (`v0.1`): a short double-beep plays when a warning/mic error reaches the overlay.
- **Dashboard export** (`v0.1`): per-entry Copy, plus Copy-all and Export .txt in the header.

## Known quirks

- **Hotkey input uses `e.code`** (physical key), not `e.key` — `e.key` produces invisible control characters when Ctrl is held, which broke "Set" validation. Presets in `src/renderer/settings/SettingsApp.tsx`.
- **Whisper hallucinations** get filtered in `src/main/groq.ts` → `sanitizeTranscript()`.
- **`showOverlayAlone` / Cerebras** were removed; don't add them back without updating settings.

## To-do / ideas

- [ ] Confirm multi-key rotation end-to-end with a real second key on a heavy day
- [ ] (add things here freely)

## Ideas for later

- PWA companion for Samsung
- Native Android floating bubble + IME binding (Kotlin)
- Command mode (voice-triggered shortcuts)
- Keep this list updated as you decide.