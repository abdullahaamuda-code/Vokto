import { app, Menu, nativeImage, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Load the tray icon from build/icon.ico. In dev the main bundle runs from
// out/main/, so the build dir is two levels up; in production the icon ships
// next to the app resources. Falls back to an empty image if nothing is found.
function loadTrayIcon(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'build', 'icon.ico'),
        join(process.resourcesPath, 'icon.ico'),
        join(__dirname, '../../build/icon.ico'),
      ]
    : [join(__dirname, '../../build/icon.ico')];

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    } catch {
      /* try next candidate */
    }
  }
  return nativeImage.createEmpty();
}

export function createTray(
  onOpenDashboard: () => void,
  onShowSettings: () => void,
  onToggleDictation: () => void,
  onQuit: () => void,
): Tray {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip('Vokto — Alt+Q to dictate');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Vokto', click: onOpenDashboard },
      { type: 'separator' },
      { label: 'Settings', click: onShowSettings },
      { label: 'Start/Stop (Alt+Q)', click: onToggleDictation },
      { type: 'separator' },
      { label: 'Quit Vokto', click: onQuit },
    ]),
  );
  tray.on('click', onOpenDashboard);
  return tray;
}
