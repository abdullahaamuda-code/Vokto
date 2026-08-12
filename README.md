# Vokto

Premium always-on voice typing for your PC. Press **Alt+Q** anywhere, talk naturally, and text streams live into whatever app your cursor is in. Built on Groq Whisper v3 (free tier). Rotation across multiple free API keys spreads the load so you rarely hit daily limits.

Open source — MIT licensed.

## Why it feels like Wispr Flow

- **Adaptive VAD chunking** — the app detects when you pause (~1.5s) and ships that clause to Groq instantly, so text appears phrase-by-phrase. Same technique Perplexity and Wispr use.
- **Whisper `prompt` chaining** — each chunk gets the prior text passed back as context, keeping punctuation, tone, and spelling continuous across chunk boundaries.
- **Multi-key rotation** — add 2–3 Groq keys and Vokto picks the least-loaded one, marks rate-limited keys as `exhausted`, and retries the failed chunk on the next key automatically.
- **Never lose a recording** — every chunk is written to a temp file before upload. App kill, network drop, or sleep mid-sentence → chunks are retried until they land or you cancel.
- **Hallucination guard** — Whisper's short-chunk caption/subtitle loops are detected and dropped so junk never reaches your cursor.

## Setup

```bash
npm install
npm run dev           # hot-reload development
npm run dist          # package a portable .exe
npm run dist:full     # build the NSIS installer
```

On first run the app sits in the system tray. Right-click tray → Settings:

1. **Groq key(s)** — free at https://console.groq.com/keys. Add as many as you want.
2. **Dictation shortcut** — pick a preset **or press any key combo to set your own** (e.g. Ctrl+Alt+D, Alt+Space, F5). Only your chosen combo works — if another app already grabs it, Vokto tells you and keeps your previous shortcut instead of silently failing.
3. **Auto-paste** — paste the transcribed text into whatever app has focus.

Then close settings (it keeps running in the tray). In any app, click where you want text, press **Alt+Q**, talk.

## Usage

| Action | Result |
|---|---|
| Your dictation hotkey (default `Alt+Q`, fully customizable) | Toggle dictation on/off (works in every app, no focus needed) |
| Your hotkey while recording | Stop and flush the tail |
| Long silence (2 min) | Auto-closes the session (safety) |
| Dashboard | Browses transcription history, copy/export entries, storage gauge |

## Architecture

```
src/
  main/                   Electron main process
    index.ts              Window mgmt, global hotkey, tray, IPC wiring
    store.ts              DPAPI-encrypted settings + key vault (Windows protected)
    keys.ts               Key decryption helpers
    groq.ts               Multi-key rotation, per-key rate-limit tracking
    pipeline.ts           Sessions, persistent chunk queue, retry logic
    paste.ts              Clipboard + SendKeys Ctrl+V (no native deps)
    recordings.ts         Local transcription history store
    tray.ts               System tray + menu
  preload/
    overlay.ts            contextBridge for the always-on-top pill
    settings.ts           contextBridge for settings window
    dashboard.ts          contextBridge for the dashboard
  renderer/
    overlay/
      index.html/App.tsx  The pill — waveform, glow, drag state
      audio.ts            getUserMedia + AudioWorklet, adaptive VAD, chunker
      worklet.ts          AudioWorkletProcessor source (as blob)
      wav.ts              Float32 → 16-bit WAV encoder
    settings/             React settings UI (keys, hotkey, auto-paste)
    dashboard/            Transcription history dashboard
packages/shared/src/index.ts   Shared types + IPC contract (single source of truth)
```

## Privacy

- All API keys encrypted with Windows DPAPI (machine + user bound), stored only in `%APPDATA%\vokto\vokto-config.json`.
- Audio never persists beyond the active session temp folder (auto-deleted per-session and on crash-recovery).
- No telemetry, no accounts, no cloud storage. Only outbound traffic: the Groq API calls you explicitly configure.

---
 **Built with ❤️ by Abdullah A-Amuda**
