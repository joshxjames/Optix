import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Static marketing site. Vite handles dev server + minification + hashing.
// Output goes to `dist/` so Firebase Hosting can serve from there directly:
//   firebase init hosting → public dir: website/dist
//   firebase deploy --only hosting
export default defineConfig({
  root: '.',
  server: {
    open: false,
    port: 4321,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
    sourcemap: true,
    rollupOptions: {
      // Multi-page build: each entry becomes a top-level HTML file in dist/.
      // Firebase Hosting serves /privacy.html when the URL is /privacy
      // (with the firebase.json `cleanUrls: true` setting we'll add later).
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
        terms: resolve(import.meta.dirname, 'terms.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
