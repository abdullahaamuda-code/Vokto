// Strategy: locked foreground window stays put (Electron is focusable: false,
// so it never steals focus). We write clipboard then SendKeys ^v — OS routes
// keystrokes to the currently focused window. For streaming mode: text lands
// immediately when Groq finishes, in whatever app has focus.
//
// Reliability: pastes run through a FIFO serial queue so fast consecutive
// utterance flushes never drop text. If the queue fills up, the OLDEST
// pending item is dropped so the most recent speech always wins.

import { clipboard } from 'electron';
import { execFile } from 'node:child_process';

const PASTE_PS = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.SendKeys]::SendWait('^v')",
].join('; ');

// Spawn PowerShell fully hidden — windowsHide:true keeps the paste operation
// invisible (no black console flash on the user's screen while typing).
const SPAWN_FLAGS = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PASTE_PS];

const QUEUE_CAP = 5;
const RETRY_DELAY_MS = 200;

interface QueueItem {
  text: string;
  resolve: (result: { ok: boolean; reason?: string }) => void;
}

const queue: QueueItem[] = [];
let workerRunning = false;

export function pasteText(text: string): Promise<{ ok: boolean; reason?: string }> {
  if (!text) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    enqueue({ text, resolve });
  });
}

function enqueue(item: QueueItem): void {
  if (queue.length >= QUEUE_CAP) {
    // Drop the OLDEST pending item — the most recent speech always wins.
    const dropped = queue.shift();
    console.warn(`[paste] queue full (${QUEUE_CAP}); dropping oldest pending paste`);
    dropped?.resolve({ ok: false, reason: 'dropped: queue overflow' });
  }
  queue.push(item);
  void drain();
}

async function drain(): Promise<void> {
  // Single worker: never process two pastes at once. Enqueue + drain are
  // race-safe because JS is single-threaded between await points and the
  // workerRunning flag guards re-entry.
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const result = await executePaste(item.text);
      item.resolve(result);
    }
  } finally {
    workerRunning = false;
    // Re-check in case something was enqueued between the last shift and now.
    if (queue.length > 0) void drain();
  }
}

async function executePaste(text: string): Promise<{ ok: boolean; reason?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAY_MS);
    try {
      clipboard.writeText(text);
      await wait(80); // long enough for clipboard to settle
      await sendCtrlV();
      await wait(50); // trailing settle so the next paste starts clean
      return { ok: true };
    } catch (e) {
      const reason = (e as Error).message;
      if (attempt === 0) {
        console.warn(`[paste] SendKeys failed, retrying once in ${RETRY_DELAY_MS}ms: ${reason}`);
        continue;
      }
      return { ok: false, reason };
    }
  }
  // Unreachable, but keeps TypeScript happy.
  return { ok: false, reason: 'unknown' };
}

function sendCtrlV(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      SPAWN_FLAGS,
      { timeout: 5_000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
