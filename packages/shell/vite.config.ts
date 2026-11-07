import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = import.meta.dirname;
const core = process.env.SERVERMIN_CORE_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    // Frontend HMR for the shell; module bundles and the API come from the core (§52).
    proxy: {
      '/api/v1/ws': { target: core.replace(/^http/, 'ws'), ws: true },
      '/api': { target: core, changeOrigin: false },
      '/modules': { target: core, changeOrigin: false },
    },
  },
});
