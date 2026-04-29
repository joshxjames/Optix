import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// When the project lives under OneDrive / Dropbox / iCloud, those sync clients
// race with Vite's esbuild dep-pre-bundler and cause "Access is denied" errors
// on Windows. We redirect the renderer's cache dir to the OS temp folder to
// sidestep the problem. Harmless if the project is already outside a sync
// folder.
const VITE_CACHE_DIR = resolve(tmpdir(), 'optix-vite-cache');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      outDir: 'out/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
        },
        // Electron preload scripts with `sandbox: true` must be CommonJS —
        // the sandboxed loader cannot parse ESM `import` statements. Force
        // CJS output even though package.json is `"type": "module"`.
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    plugins: [
      react(),
      {
        // In dev, Vite injects inline <script> blocks (react-refresh, HMR client)
        // that the production CSP (`script-src 'self'`) blocks, leaving #root
        // empty and the widget window invisible. Strip the meta CSP tag only
        // when the dev server is running; production builds keep it.
        name: 'optix-dev-csp-strip',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace(
            /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i,
            '',
          );
        },
      },
    ],
    cacheDir: VITE_CACHE_DIR,
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    root: 'src/renderer',
    build: {
      outDir: '../../out/renderer',
      rollupOptions: {
        input: {
          widget: resolve('src/renderer/widget/index.html'),
          overlay: resolve('src/renderer/overlay/index.html'),
        },
      },
    },
  },
});
