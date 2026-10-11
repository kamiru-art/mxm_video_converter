// Los mensajes entre opfs.ts y su escritor en un worker (opfs-worker.ts).
// Sólo tipos: lo comparten los dos programas de TypeScript (página y
// worker).

/** Lo que la página pide al escritor. `path` son nombres desde la raíz de
 *  OPFS; `sid`, un archivo abierto para escribir por trozos. */
export type OpfsOp =
  | { op: 'probe' }
  | { op: 'put'; path: string[]; data: ArrayBuffer | Blob }
  | { op: 'open'; sid: number; path: string[] }
  | { op: 'write'; sid: number; data: ArrayBuffer | Blob; at?: number }
  | { op: 'close'; sid: number }
  | { op: 'discard'; sid: number };

/** Cada petición lleva el número con el que vuelve su respuesta. */
export type OpfsRequest = OpfsOp & { id: number };

/** La respuesta: el resultado de `probe`, o el error con su nombre
 *  (QuotaExceededError se reconoce por él). Con `id` 0, un error que no es
 *  de ninguna petición (un mensaje ilegible): la página deja de usar el
 *  escritor. */
export interface OpfsReply {
  id: number;
  value?: boolean;
  error?: { name: string; message: string };
}
