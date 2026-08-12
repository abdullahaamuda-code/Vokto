import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EncKeyRef, PublicSettings } from '@shared/index';
import { DEFAULT_SETTINGS } from '@shared/index';

interface DiskShape {
  hotkey: string;
  groqModel: string;
  language: string;
  autoPaste: boolean;
  launchAtLogin: boolean;
  micDeviceId: string;
  overlayPos: { x: number; y: number; v?: number } | null;
  groqKeys: EncKeyRef[];
}

const DEFAULT_DISK: DiskShape = {
  hotkey: DEFAULT_SETTINGS.hotkey,
  groqModel: DEFAULT_SETTINGS.groqModel,
  language: DEFAULT_SETTINGS.language,
  autoPaste: DEFAULT_SETTINGS.autoPaste,
  launchAtLogin: DEFAULT_SETTINGS.launchAtLogin,
  micDeviceId: DEFAULT_SETTINGS.micDeviceId,
  overlayPos: DEFAULT_SETTINGS.overlayPos,
  groqKeys: [],
};

function storePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = join(dir, 'vokto-config.json');
  // One-time migration from the old Voquill config filename
  const legacy = join(dir, 'voquill-config.json');
  if (!existsSync(next) && existsSync(legacy)) {
    try {
      renameSync(legacy, next);
    } catch (err) {
      console.error('[store] config migration failed', err);
    }
  }
  return next;
}

function load(): DiskShape {
  try {
    const raw = readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DiskShape>;
    return {
      ...DEFAULT_DISK,
      ...parsed,
    };
  } catch {
    return structuredClone(DEFAULT_DISK);
  }
}

let disk: DiskShape = load();

function persist(): void {
  try {
    writeFileSync(storePath(), JSON.stringify(disk, null, 2), 'utf-8');
  } catch (err) {
    console.error('[store] persist failed', err);
  }
}

export const store = {
  get disk(): DiskShape {
    return disk;
  },

  addGroqKey(label: string, key: string): EncKeyRef {
    const trimmed = key.trim();
    const cipher = safeStorage.encryptString(trimmed).toString('base64');
    const ref: EncKeyRef = {
      id: `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label: label.trim() || `Key ${disk.groqKeys.length + 1}`,
      hint: `…${trimmed.slice(-4)}`,
      cipher,
    };
    disk.groqKeys.push(ref);
    persist();
    return ref;
  },

  removeGroqKey(id: string): void {
    disk.groqKeys = disk.groqKeys.filter((k) => k.id !== id);
    persist();
  },

  set(patch: Partial<Omit<DiskShape, 'groqKeys'>>): void {
    disk = { ...disk, ...patch };
    persist();
  },
};
