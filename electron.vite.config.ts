import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const sharedAlias = { '@shared': resolve(__dirname, 'packages/shared/src') };

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: { alias: sharedAlias },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          dashboard: resolve(__dirname, 'src/preload/dashboard.ts'),
        },
      },
    },
    resolve: { alias: sharedAlias },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          dashboard: resolve(__dirname, 'src/renderer/dashboard/index.html'),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'packages/shared/src'),
      },
    },
  },
});
