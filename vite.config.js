import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  server: {
    // Listen on all interfaces so the dev server is reachable from other devices on the LAN.
    host: true,
  },
  resolve: {
    alias: {
      // Import EZ-Tree from source so its bark/leaf images ship as separate files
      // instead of the 4 MB base64 bundle in its prebuilt build.
      'ez-tree-src': fileURLToPath(new URL('./node_modules/@dgreenheck/ez-tree/src/lib/index.js', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
