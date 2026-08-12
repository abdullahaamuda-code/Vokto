import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/index';
import type { RecordingEntry } from '@shared/index';

export interface DashboardApi {
  getRecordings: () => Promise<RecordingEntry[]>;
  clearRecordings: () => Promise<void>;
  // Subscribe to new recordings; returns an unsubscribe function.
  onRecordingCompleted: (cb: (rec: RecordingEntry) => void) => () => void;
  openSettings: () => void;
  quit: () => void;
}

const api: DashboardApi = {
  getRecordings: () => ipcRenderer.invoke(IPC.recordingsGet) as Promise<RecordingEntry[]>,
  clearRecordings: () => ipcRenderer.invoke(IPC.recordingsClear) as Promise<void>,
  onRecordingCompleted: (cb) => {
    const listener = (_e: unknown, rec: RecordingEntry) => cb(rec);
    ipcRenderer.on(IPC.recordingCompleted, listener);
    return () => ipcRenderer.removeListener(IPC.recordingCompleted, listener);
  },
  openSettings: () => {
    void ipcRenderer.invoke(IPC.openSettings);
  },
  quit: () => {
    void ipcRenderer.invoke(IPC.quit);
  },
};

contextBridge.exposeInMainWorld('vkDashboard', api);
