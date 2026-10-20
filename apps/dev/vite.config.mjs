import { fileURLToPath } from 'node:url';

// Dev Focus bundle, served by the desktop at p9://dev/. cssMinify is off: lightningcss rejects an empty selector in the DUWOP CSS.
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  logLevel: 'warn',
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', cssMinify: false, assetsInlineLimit: 0, chunkSizeWarningLimit: 100000 },
  worker: { format: 'es' },
};
