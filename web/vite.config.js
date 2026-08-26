import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        e2e: resolve(import.meta.dirname, 'e2e.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
