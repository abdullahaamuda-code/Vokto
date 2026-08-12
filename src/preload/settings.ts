import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/index';
import type { PublicSettings } from '@shared/index';

const api = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<PublicSettings>,
  updateSettings: (patch: Partial<PublicSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<PublicSettings>,
  addKey: (label: string, key: string) => ipcRenderer.invoke(IPC.keysAdd, { label, key }) as Promise<PublicSettings>,
  removeKey: (id: string) => ipcRenderer.invoke(IPC.keyRemove, id) as Promise<PublicSettings>,
  quit: () => ipcRenderer.invoke(IPC.quit),
  onSettingsChanged: (cb: (s: PublicSettings) => void) => {
    ipcRenderer.on(IPC.settingsChanged, (_e, s: PublicSettings) => cb(s));
  },
  onHotkeyConflict: (cb: (accel: string) => void) => {
    ipcRenderer.on(IPC.hotkeyConflict, (_e, accel: string) => cb(accel));
  },
};

contextBridge.exposeInMainWorld('vqSettings', api);

export type SettingsApi = typeof api;
