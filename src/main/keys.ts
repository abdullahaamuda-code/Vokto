import { safeStorage } from 'electron';
import { store } from './store';

export function decryptKey(cipher: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return null;
  }
}

export function groqKeysDecrypted(): Array<{ id: string; label: string; hint: string; apiKey: string }> {
  return store.disk.groqKeys
    .map((ref) => {
      const apiKey = decryptKey(ref.cipher);
      return apiKey ? { id: ref.id, label: ref.label, hint: ref.hint, apiKey } : null;
    })
    .filter((k): k is NonNullable<typeof k> => k !== null);
}

