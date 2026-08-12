// ── Shared types + IPC constants: single source of truth ──────────────────

export const APP_NAME = 'Vokto';

export type GroqModelId = 'whisper-large-v3' | 'whisper-large-v3-turbo';

export type KeyStatus = 'ready' | 'exhausted' | 'error' | 'invalid';

export interface EncKeyRef {
  id: string; // stable id
  label: string; // user-given name e.g. "key 1"
  hint: string; // last 4 chars, for UI
  cipher: string; // base64 DPAPI ciphertext
}

export interface PublicSettings {
  groqKeys: Array<{ id: string; label: string; hint: string; status: KeyStatus; requestsToday: number }>;
  groqModel: GroqModelId;
  language: string; // 'en'
  hotkey: string; // 'Alt+Q'
  autoPaste: boolean; // stream into focused app
  launchAtLogin: boolean;
  micDeviceId: string;
  overlayPos: { x: number; y: number; v?: number } | null; // remembered pill position (v = shape version)
}

export const DEFAULT_SETTINGS: PublicSettings = {
  groqKeys: [],
  groqModel: 'whisper-large-v3-turbo',
  language: 'en',
  hotkey: 'Alt+Q',
  autoPaste: true,
  launchAtLogin: true,
  micDeviceId: 'default',
  overlayPos: null,
};

export type SessionState = 'idle' | 'recording' | 'processing';

export const IPC = {
  // renderer → main (invoke)
  overlayReady: 'vq:overlay-ready',
  toggleDictation: 'vq:toggle-dictation',
  stopDictation: 'vq:stop-dictation',
  vadEvent: 'vq:vad-event',
  settingsGet: 'vq:settings-get',
  settingsUpdate: 'vq:settings-update',
  keysAdd: 'vq:keys-add',
  keyRemove: 'vq:key-remove',
  openOverlayDevTools: 'vq:overlay-devtools',
  overlayDragBy: 'vq:overlay-drag-by',
  overlayRegion: 'vq:overlay-region',
  openSettings: 'vq:open-settings',
  recordingsGet: 'vq:recordings-get',
  recordingsClear: 'vq:recordings-clear',
  quit: 'vq:quit',
  // main → renderer (send)
  overlayState: 'vq:overlay-state',
  audioCmd: 'vq:audio-cmd',
  settingsChanged: 'vq:settings-changed',
  recordingCompleted: 'vq:recording-completed',
  hotkeyConflict: 'vq:hotkey-conflict',
} as const;

// One successfully transcribed (+ pasted) utterance, persisted to the
// recordings history file owned by the main process.
export interface RecordingEntry {
  id: string;
  timestamp: number;
  durationSec: number;
  text: string;
  wordCount: number;
}

export type OverlayCmd =
  | { type: 'state'; state: SessionState; partialLive?: boolean }
  | { type: 'stream'; seq: number; liveText: string; finalized: boolean; replaceAll?: boolean }
  | {
      type: 'status';
      micOk: boolean;
      netOnline: boolean;
      keysAvailable: number;
      keysTotal: number;
      queuedChunks: number;
      warning?: string;
    }
  | { type: 'reset' };

export type VADEvent = 'session-start' | 'session-abort' | 'flush-end' | 'stop-requested';

export type AudioCmd =
  | { type: 'set-recording'; on: boolean }
  | { type: 'set-mic'; deviceId: string };
