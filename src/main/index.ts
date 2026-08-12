import { BrowserWindow, Notification, app, globalShortcut, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { IPC, APP_NAME } from '@shared/index';
import type { AudioCmd, EncKeyRef, OverlayCmd, PublicSettings, SessionState, VADEvent } from '@shared/index';
import { store } from './store';
import { groqKeySummaries, hasAnyKey, keysAvailable, onKeyStateChange, syncGroqKeys } from './groq';
import { createTray } from './tray';
import { Pipeline, cleanupOrphanSessions } from './pipeline';
import { addRecording, clearRecordings, loadRecordings } from './recordings';

let overlayWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let dashboardWin: BrowserWindow | null = null;
let tray: Electron.Tray | null = null;
let pipeline: Pipeline | null = null;
let state: SessionState = 'idle';

const applyLaunchAtLogin = (): void => {
  app.setLoginItemSettings({
    openAtLogin: store.disk.launchAtLogin,
    path: app.getPath('exe'),
  });
};

// Slim Whisper-Flow style pill — bottom-center of the nearest screen by default,
// draggable anywhere, always on top.
// The window is wider than the visual pill; the renderer re-centers the pill
// every animation frame so window dragging keeps it centered (rounded
// transparent windows clip content near edges).
const overlayDims = () => ({ w: 340, h: 88 });
const OVERLAY_CHANGED = 3; // bump to wipe stale saved positions after shape changes

function overlayDefaultPosition(): { x: number; y: number } {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { w, h } = overlayDims();
  return {
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: Math.round(d.workArea.y + d.workArea.height - h - 16), // sit low, hug the taskbar
  };
}

function loadSavedOverlayPos(): { x: number; y: number } | null {
  try {
    const raw = store.disk.overlayPos;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
    if ((raw as { v?: number }).v !== OVERLAY_CHANGED) return null; // stale shape version
    // sanity: must be on some visible screen
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return raw.x >= a.x - 100 && raw.x <= a.x + a.width && raw.y >= a.y - 50 && raw.y <= a.y + a.height;
    });
    return onScreen ? raw : null;
  } catch {
    return null;
  }
}

function createOverlay(): BrowserWindow {
  const { w, h } = overlayDims();
  let pos = loadSavedOverlayPos() ?? overlayDefaultPosition();
  if (process.env.VQ_POS) {
    const [x, y] = process.env.VQ_POS.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) pos = { x, y };
  }
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    hasShadow: false,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The whole window is click-through EXCEPT the pill itself. The renderer
  // reports whenever the cursor enters/leaves the pill and we flip the switch,
  // so dragging only ever starts directly on the capsule — clicks around it
  // pass straight to whatever app is underneath.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('moved', () => {
    if (!win.isDestroyed()) {
      const [x, y] = win.getPosition();
      store.set({ overlayPos: { x, y, v: OVERLAY_CHANGED } });
    }
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void win.loadURL(`${url}/overlay/index.html`);
  else void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  return win;
}

function createSettings(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 780,
    show: true,
    title: `${APP_NAME} Settings`,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b12',
    webPreferences: {
      preload: join(__dirname, '../preload/settings.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('closed', () => {
    settingsWin = null;
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void win.loadURL(`${url}/settings/index.html`);
  else void win.loadFile(join(__dirname, '../renderer/settings/index.html'));
  return win;
}

// The dashboard is the app's primary visible surface. Reuse the existing
// window (bring it to front) instead of ever creating a second one.
function createDashboard(): BrowserWindow {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    if (dashboardWin.isMinimized()) dashboardWin.restore();
    dashboardWin.show();
    dashboardWin.focus();
    return dashboardWin;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    show: true,
    center: true,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: '#0c0c11',
    webPreferences: {
      preload: join(__dirname, '../preload/dashboard.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('closed', () => {
    dashboardWin = null;
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void win.loadURL(`${url}/dashboard/index.html`);
  else void win.loadFile(join(__dirname, '../renderer/dashboard/index.html'));
  dashboardWin = win;
  return win;
}

function sendOverlay(cmd: OverlayCmd): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(IPC.overlayState, cmd);
}

function sendAudio(cmd: AudioCmd): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(IPC.audioCmd, cmd);
}

function publicSettings(): PublicSettings {
  syncGroqKeys();
  const summaries = groqKeySummaries();
  return {
    groqKeys: store.disk.groqKeys.map((r: EncKeyRef) => {
      const s = summaries.find((x) => x.id === r.id);
      return { id: r.id, label: r.label, hint: r.hint, status: s?.status ?? 'ready', requestsToday: s?.requestsToday ?? 0 };
    }),
    groqModel: 'whisper-large-v3-turbo' as PublicSettings['groqModel'],
    language: store.disk.language,
    hotkey: store.disk.hotkey,
    autoPaste: store.disk.autoPaste,
    launchAtLogin: store.disk.launchAtLogin,
    micDeviceId: store.disk.micDeviceId,
    overlayPos: store.disk.overlayPos ?? null,
  };
}

function broadcastSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(IPC.settingsChanged, publicSettings());
}

function showOverlay(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}

function hideOverlay(_force = false): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.hide();
}

function setState(next: SessionState): void {
  state = next;
  sendOverlay({ type: 'state', state: next });
}

function pushStatus(): void {
  sendOverlay({
    type: 'status',
    micOk: true,
    netOnline: true,
    keysAvailable: keysAvailable(),
    keysTotal: store.disk.groqKeys.length,
    queuedChunks: 0,
  });
}

// Global hotkey handling.
//
// Only ONE shortcut is ever active at a time — the one the user configured.
// If that key combo is already taken by another app (or the OS won't give it
// up), we surface it instead of silently falling back to something else.
function registerHotkey(): boolean {
  globalShortcut.unregisterAll();
  const accel = store.disk.hotkey || 'Alt+Q';
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => void toggleDictation());
  } catch {
    ok = false;
  }
  if (ok) {
    console.log(`[main] global hotkey active: ${accel}`);
  } else {
    console.warn(`[main] could NOT register global hotkey: ${accel} (taken by another app?)`);
    notifyHotkeyConflict(accel);
  }
  return ok;
}

function notifyHotkeyConflict(accel: string): void {
  try {
    new Notification({
      title: APP_NAME,
      body: `"${accel}" couldn't be registered — it's either already in use by another app or unsupported here. Pick a different shortcut in Settings (e.g. Ctrl+Alt+D).`,
      timeoutType: 'default',
    }).show();
  } catch {
    /* notification can fail silently */
  }
  // Also surface inline in the settings window if it's open.
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send(IPC.hotkeyConflict, accel);
  }
}

function showNoKeysHint(): void {
  new Notification({
    title: APP_NAME,
    body: 'Add a Groq API key first (tray → Settings). Free keys at console.groq.com/keys',
  }).show();
}

// ── Session control (single, no duplicates) ─────────────────────────────────

function startSession(): void {
  console.log('[main] startSession');
  if (pipeline) stopNarrator();
  pipeline = new Pipeline(
    `${Date.now().toString(36)}`,
    (cmd) => sendOverlay(cmd),
    {
      autoPaste: store.disk.autoPaste,
      onRecording: (entry) => {
        addRecording(entry);
        if (dashboardWin && !dashboardWin.isDestroyed()) {
          dashboardWin.webContents.send(IPC.recordingCompleted, entry);
        }
      },
    },
  );
  setState('recording');
  showOverlay();
  sendAudio({ type: 'set-recording', on: true });
  pushStatus();
}

function stopNarrator(): void {
  // Hard stop — kill everything without transcribing.
  console.log('[main] stopNarrator');
  if (!pipeline) return;
  pipeline.abort();
  pipeline = null;
  sendAudio({ type: 'set-recording', on: false });
  setState('idle');
  sendOverlay({ type: 'reset' });
  hideOverlay(true);
}

// Alt+Q while recording → recorder flushes its tail (arrives as flush-end),
// the pipeline pastes whatever was queued, then we fully close.
let finishing = false;
function finishSession(): void {
  console.log('[main] finish requested — flush tail, paste, close');
  if (!pipeline || finishing) return;
  finishing = true;
  sendAudio({ type: 'set-recording', on: false }); // recorder will emit flush-end with the tail
  // Give the flush IPC a moment to arrive before draining
  setTimeout(() => {
    if (!pipeline) {
      finishing = false;
      return;
    }
    void pipeline.finish().finally(() => {
      pipeline = null;
      finishing = false;
      setState('idle');
      sendOverlay({ type: 'reset' });
      hideOverlay(true);
    });
  }, 350);
}

function stopSessionSafety(): void {
  // Auto-stop from long silence — same behavior as hotkey stop.
  console.log('[main] stopSessionSafety');
  if (state === 'recording') {
    finishSession();
  }
}

function toggleDictation(): void {
  if (state === 'idle' && !pipeline) {
    if (!hasAnyKey()) {
      showNoKeysHint();
      return;
    }
    startSession();
  } else if (state === 'recording' && pipeline) {
    finishSession();
  }
}

// ── IPC wiring ─────────────────────────────────────────────────────────────

ipcMain.handle(IPC.toggleDictation, () => toggleDictation());
ipcMain.handle(IPC.stopDictation, () => stopNarrator());

ipcMain.handle(IPC.vadEvent, (_e, event: VADEvent, payload?: { wav?: ArrayBuffer; durationSec?: number }) => {
  console.log(`[vad] event=${event}, wavBytes=${payload?.wav?.byteLength ?? 0}, state=${state}, hasPipeline=${Boolean(pipeline)}`);
  if (event === 'session-abort') {
    stopNarrator();
    return;
  }
  if (event === 'flush-end') {
    if (!pipeline) {
      console.warn('[vad] flush-end arrived but pipeline=null');
      return;
    }
    if (payload?.wav && payload.wav.byteLength > 0) {
      console.log(`[vad] utterance ${(payload.wav.byteLength / 1024).toFixed(0)}KB, queueing`);
      pipeline.addUtterance(new Uint8Array(payload.wav), payload.durationSec ?? 0);
    } else {
      console.log('[vad] flush-end with empty audio (nothing buffered)');
    }
  }
});

ipcMain.handle(IPC.settingsGet, () => publicSettings());

ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<PublicSettings>) => {
  if (patch.groqModel) store.set({ groqModel: patch.groqModel });
  if (patch.language) store.set({ language: patch.language });
  if (typeof patch.autoPaste === 'boolean') store.set({ autoPaste: patch.autoPaste });
  if (typeof patch.launchAtLogin === 'boolean') {
    store.set({ launchAtLogin: patch.launchAtLogin });
    applyLaunchAtLogin();
  }
  if (patch.micDeviceId) {
    store.set({ micDeviceId: patch.micDeviceId });
    sendAudio({ type: 'set-mic', deviceId: patch.micDeviceId });
  }
  if (patch.hotkey) {
    const previous = store.disk.hotkey;
    store.set({ hotkey: patch.hotkey });
    if (!registerHotkey()) {
      // Revert so a dead shortcut is never persisted — fall back to the last
      // working one so the app always has a usable hotkey.
      store.set({ hotkey: previous });
      registerHotkey();
    }
  }
  broadcastSettings();
  return publicSettings();
});

ipcMain.handle(IPC.keysAdd, (_e, { label, key }: { label: string; key: string }) => {
  store.addGroqKey(label, key);
  broadcastSettings();
  pushStatus();
  return publicSettings();
});

ipcMain.handle(IPC.keyRemove, (_e, id: string) => {
  store.removeGroqKey(id);
  broadcastSettings();
  pushStatus();
  return publicSettings();
});

ipcMain.handle(IPC.overlayReady, () => {
  pushStatus();
});

ipcMain.handle(IPC.overlayDragBy, (_e, dx: number, dy: number) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// Renderer tells us when the cursor is over the pill → only then accept input.
ipcMain.handle(IPC.overlayRegion, (_e, inside: boolean) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(!inside, { forward: true });
});

ipcMain.handle(IPC.openOverlayDevTools, () => overlayWin?.webContents.openDevTools({ mode: 'detach' }));

ipcMain.handle(IPC.openSettings, () => {
  if (!settingsWin || settingsWin.isDestroyed()) settingsWin = createSettings();
  settingsWin.show();
  settingsWin.focus();
});

ipcMain.handle(IPC.recordingsGet, () => loadRecordings());

ipcMain.handle(IPC.recordingsClear, () => {
  clearRecordings();
  return [];
});

ipcMain.handle(IPC.quit, () => {
  pipeline?.abort();
  app.quit();
});

onKeyStateChange(() => {
  pushStatus();
  broadcastSettings();
});

// ── App lifecycle ──────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createDashboard();
  });

  app.whenReady().then(() => {
    applyLaunchAtLogin();
    syncGroqKeys();
    overlayWin = createOverlay();
    // The dashboard is the primary visible surface — open it on launch.
    // (The overlay pill stays hidden until dictation starts.)
    createDashboard();
    tray = createTray(
      () => createDashboard(),
      () => {
        if (!settingsWin || settingsWin.isDestroyed()) settingsWin = createSettings();
        settingsWin.focus();
      },
      toggleDictation,
      () => {
        pipeline?.abort();
        app.quit();
      },
    );
    // Show the pill briefly on startup so the user knows it's alive, then auto-hide.
    setTimeout(() => {
      if (state === 'idle') hideOverlay(true);
    }, 2_200);
    registerHotkey();
    cleanupOrphanSessions();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    pipeline?.abort();
  });

  app.on('window-all-closed', () => {
    /* tray app: stay alive */
  });
}
