import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// When the project lives under OneDrive / Dropbox / iCloud, those sync clients
// race with Vite's esbuild dep-pre-bundler and cause "Access is denied" errors
// on Windows. We redirect the renderer's cache dir to the OS temp folder to
// sidestep the problem. Harmless if the project is already outside a sync
// folder.
const VITE_CACHE_DIR = resolve(tmpdir(), 'optix-vite-cache');

// Inject the app version from package.json at build time so the support
// form (and any other consumer) doesn't have to keep a hand-maintained
// `APP_VERSION` const in sync. Read once at config-load — Vite re-runs
// the config when it changes, which catches a `pnpm version` bump.
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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
    // Sandboxed preload (`sandbox: true` on the BrowserWindow) runs in
    // a restricted Electron context that cannot `require()` arbitrary
    // node_modules — only Electron built-ins. Default
    // `externalizeDepsPlugin()` would emit `require('zod')` for the
    // schema validation we do here (StoredPlanSchema for the plan
    // onChanged broadcast); that throws "module not found: zod" at
    // preload load time, which kills the contextBridge and leaves the
    // renderer with `window.optix === undefined` — every subsequent
    // `window.optix.X` access then throws "Cannot read properties of
    // undefined (reading 'X')". Excluding zod from externalization
    // bundles it inline (~50KB) so the preload is self-contained.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
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
    // Inject __APP_VERSION__ at build time. JSON.stringify so it lands as a
    // proper string literal (not an unquoted identifier) in the bundle.
    define: {
      __APP_VERSION__: JSON.stringify(PKG_VERSION),
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
