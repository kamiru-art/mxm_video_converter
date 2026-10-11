// El escritor de OPFS para Safari (ver `syncWriter` en opfs.ts). Safari
// (26.5) deja en la carpeta temporal del sistema una copia entera de cada
// archivo escrito con createWritable y no la borra nunca: una sesión de 31
// escaneos dejó 2,8 GB. Un FileSystemSyncAccessHandle escribe en el propio
// archivo y no deja nada (medido en Safari 26.5.2), pero sólo existe en un
// worker. Este worker no hace otra cosa: recibe rutas y bytes, escribe y
// contesta.
//
// Las rutas son de nombres a partir de la raíz de OPFS; las carpetas ya las
// creó la página, sólo el archivo se crea aquí. Los métodos del handle se
// esperan con `await`: en Safari 15–16 devolvían promesas.

import type { OpfsReply, OpfsRequest } from './opfs-protocol.ts';

/** Los archivos abiertos para escribir por trozos, y dónde va el siguiente
 *  trozo que no dice su posición. */
const open = new Map<number, { handle: FileSystemSyncAccessHandle; pos: number }>();
/** Lo de cada archivo abierto, uno detrás de otro: un trozo no se escribe
 *  antes de que se abra el archivo, ni después de cerrarlo. */
const queues = new Map<number, Promise<unknown>>();

async function fileAt(path: string[]): Promise<FileSystemFileHandle> {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  return dir.getFileHandle(path[path.length - 1], { create: true });
}

function writeBytes(h: FileSystemSyncAccessHandle, bytes: Uint8Array, at: number): number {
  let done = 0;
  while (done < bytes.byteLength) {
    const n = h.write(bytes.subarray(done), { at: at + done });
    // sin espacio, el navegador lanza QuotaExceededError; un 0 sin error
    // sería un bucle sin fin
    if (!(n > 0)) throw new Error(`OPFS wrote ${n} bytes`);
    done += n;
  }
  return at + done;
}

/** Escribe `data` desde `at`; devuelve dónde acabó. Un Blob se lee a
 *  trozos: puede ser un fotograma entero de otro archivo de OPFS. */
async function writeAll(
  h: FileSystemSyncAccessHandle,
  data: ArrayBuffer | Blob,
  at: number,
): Promise<number> {
  if (!(data instanceof Blob)) return writeBytes(h, new Uint8Array(data), at);
  const reader = data.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return at;
    at = writeBytes(h, value, at);
  }
}

async function run(req: OpfsRequest): Promise<boolean | undefined> {
  switch (req.op) {
    case 'probe':
      return (
        typeof FileSystemFileHandle !== 'undefined' &&
        'createSyncAccessHandle' in FileSystemFileHandle.prototype
      );
    case 'put': {
      const h = await (await fileAt(req.path)).createSyncAccessHandle();
      try {
        await h.truncate(0);
        await writeAll(h, req.data, 0);
        await h.flush();
      } finally {
        await h.close();
      }
      return;
    }
    case 'open': {
      const handle = await (await fileAt(req.path)).createSyncAccessHandle();
      try {
        await handle.truncate(0);
      } catch (e) {
        await handle.close();
        throw e;
      }
      open.set(req.sid, { handle, pos: 0 });
      return;
    }
    case 'write': {
      const f = open.get(req.sid);
      if (!f) throw new Error('OPFS file is not open');
      f.pos = await writeAll(f.handle, req.data, req.at ?? f.pos);
      return;
    }
    case 'close':
    case 'discard': {
      const f = open.get(req.sid);
      if (!f) return;
      open.delete(req.sid);
      try {
        if (req.op === 'close') await f.handle.flush();
      } finally {
        await f.handle.close();
      }
      return;
    }
  }
}

self.onmessage = (e: MessageEvent<OpfsRequest>) => {
  const req = e.data;
  const reply = (r: OpfsReply): void => postMessage(r);
  const work = (): Promise<void> =>
    run(req).then(
      (value) => reply({ id: req.id, value }),
      (err: unknown) =>
        reply({
          id: req.id,
          // un DOMException (QuotaExceededError) cruza con su nombre
          error:
            err && typeof err === 'object' && 'name' in err
              ? { name: String(err.name), message: String((err as Error).message) }
              : { name: 'Error', message: String(err) },
        }),
    );
  if (!('sid' in req)) {
    void work();
    return;
  }
  const next = (queues.get(req.sid) ?? Promise.resolve()).then(work);
  queues.set(req.sid, next);
  // la cola de un archivo cerrado no se queda para siempre
  void next.then(() => {
    if (queues.get(req.sid) === next) queues.delete(req.sid);
  });
};
