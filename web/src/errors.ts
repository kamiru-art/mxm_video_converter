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
