import { defineConfig } from 'vite';

// Static marketing site. Vite handles dev server + minification + hashing.
// Output goes to `dist/` so Firebase Hosting can serve from there directly:
//   firebase init hosting → public dir: website/dist
//   firebase deploy --only hosting
export default defineConfig({
  // Keep the source root at project root (so index.html stays where it is).
  root: '.',
  // Don't auto-open the browser — we're embedded in a longer dev workflow.
  server: {
    open: false,
    // Match the port we reserved for the marketing site so docs links don't drift.
    port: 4321,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    // Inline anything under 4KB so we don't ship a hundred small assets.
    assetsInlineLimit: 4096,
    // Generate sourcemaps for the production bundle — small site, useful for
    // debugging post-deploy. Strip if hosting bandwidth becomes a concern.
    sourcemap: true,
    rollupOptions: {
      output: {
        // Hash output filenames for cache-busting; Firebase Hosting sets
        // long max-age on hashed files automatically.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
