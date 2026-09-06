import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

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
  // las mismas cabeceras que public/_headers pone en el sitio: sin ellas el
  // servidor de desarrollo no aísla el origen y ffmpeg corre en un hilo
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
});
