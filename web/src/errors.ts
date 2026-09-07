// Errores compartidos.

/** Mensaje legible de cualquier cosa lanzada: un Error, un string, un
 *  DOMException. Lo que antes era `e.message ?? e` repetido en cada catch. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string')
    return e.message;
  return String(e);
}

/** Rango de tiempo vacío o invertido al extraer fotogramas. Se distingue
 *  del resto porque extractFrames lo relanza en lugar de taparlo con el error
 *  del contenedor (ver video.ts y avi.ts). */
export class BadRangeError extends Error {
  readonly badRange = true;
}

/** Parada pedida por el usuario (botón Cancel) a mitad de una tarea larga:
 *  generar hojas, procesar escaneos, reconstruir el video. No es un fallo:
 *  quien lo recoge lo anuncia como parada y no como error. */
export class CancelledError extends Error {
  readonly cancelled = true;
  constructor(what = 'Cancelled.') {
    super(what);
    this.name = 'CancelledError';
  }
}

/** ¿Es una parada pedida (CancelledError, o el AbortError del navegador)? */
export function isCancelled(e: unknown): boolean {
  return (
    e instanceof CancelledError ||
    (e instanceof DOMException && e.name === 'AbortError') ||
    (!!e && typeof e === 'object' && 'cancelled' in e && e.cancelled === true)
  );
}

/** Lanza CancelledError si la señal ya está abortada: la comprobación que
 *  cada bucle largo hace entre una unidad de trabajo y la siguiente. */
export function throwIfCancelled(signal: AbortSignal | undefined, what?: string): void {
  if (signal?.aborted) throw new CancelledError(what);
}
