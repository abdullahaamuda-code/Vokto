import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordingEntry } from '@shared/index';

// Authoritative recording history store. A single JSON array file in the app
// userData dir, newest entry first. FIFO eviction keeps it under MAX_BYTES —
// oldest entries drop off first.
export const RECORDINGS_MAX_BYTES = 2 * 1024 * 1024; // ~2MB cap

function filePath(): string {
  return join(app.getPath('userData'), 'recordings.json');
}

function isValidEntry(x: unknown): x is RecordingEntry {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.timestamp === 'number' &&
    typeof r.durationSec === 'number' &&
    typeof r.text === 'string' &&
    typeof r.wordCount === 'number'
  );
}

export function loadRecordings(): RecordingEntry[] {
  try {
    const raw = readFileSync(filePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export function saveRecordings(list: RecordingEntry[]): void {
  // FIFO eviction: drop oldest entries until the serialized file fits.
  const items = [...list];
  let json = JSON.stringify(items, null, 1);
  while (json.length > RECORDINGS_MAX_BYTES && items.length > 1) {
    items.pop(); // oldest is last (list is newest-first)
    json = JSON.stringify(items, null, 1);
  }
  try {
    writeFileSync(filePath(), json, 'utf8');
  } catch (err) {
    console.error('[recordings] failed to save:', err);
  }
}

export function addRecording(entry: RecordingEntry): void {
  const list = loadRecordings();
  list.unshift(entry);
  saveRecordings(list);
}

export function clearRecordings(): void {
  saveRecordings([]);
}
