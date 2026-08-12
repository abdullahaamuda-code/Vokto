import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/index';
import type { AudioCmd, OverlayCmd, VADEvent } from '@shared/index';

const api = {
  vadEvent: (e: VADEvent, payload?: { wav?: ArrayBuffer; durationSec?: number }) =>
    ipcRenderer.invoke(IPC.vadEvent, e, payload),
  overlayReady: () => ipcRenderer.invoke(IPC.overlayReady),
  toggleDictation: () => ipcRenderer.invoke(IPC.toggleDictation),
  stopDictation: () => ipcRenderer.invoke(IPC.stopDictation),
  dragBy: (dx: number, dy: number) => ipcRenderer.invoke(IPC.overlayDragBy, dx, dy),
  cursorRegion: (inside: boolean) => ipcRenderer.invoke(IPC.overlayRegion, inside),
  onState: (cb: (cmd: OverlayCmd) => void) => {
    ipcRenderer.on(IPC.overlayState, (_e, cmd: OverlayCmd) => cb(cmd));
  },
  onAudioCmd: (cb: (cmd: AudioCmd) => void) => {
    ipcRenderer.on(IPC.audioCmd, (_e, cmd: AudioCmd) => cb(cmd));
  },
};

contextBridge.exposeInMainWorld('vqOverlay', api);

export type OverlayApi = typeof api;
