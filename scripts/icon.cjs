// Copies the Vokto icon (profile pic.ico at project root) to build/icon.ico
// so electron-builder uses it for the taskbar, installer, and tray.
const { copyFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const src = join(root, 'profile pic.ico');
const buildDir = join(root, 'build');
const dest = join(buildDir, 'icon.ico');

if (!existsSync(src)) {
  console.error('[icon] source not found: profile pic.ico');
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
copyFileSync(src, dest);
console.log('[icon] copied profile pic.ico → build/icon.ico');
