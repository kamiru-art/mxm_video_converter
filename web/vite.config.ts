import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        ...(process.env.MXM_E2E ? { e2e: resolve(import.meta.dirname, 'e2e.html') } : {}),
        // El service worker es una entrada propia: se escribe en TypeScript
        // como el resto y sale como /sw.js, el nombre fijo con el que main.ts
        // lo registra. No importa nada, así que no comparte trozos con la app.
        sw: resolve(import.meta.dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
