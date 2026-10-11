// El escritor de OPFS para Safari (ver `syncWriter` en opfs.ts). Safari
// (26.5) deja en la carpeta temporal del sistema una copia entera de cada
// archivo escrito con createWritable y no la borra nunca: una sesión de 31
// escaneos dejó 2,8 GB. Un FileSystemSyncAccessHandle escribe en el propio
// archivo y no deja nada (medido en Safari 26.5.2), pero sólo existe en un
// worker. Este worker no hace otra cosa: recibe rutas y bytes, escribe y
// contesta.
//
// Las rutas son de nombres a partir de la raíz de OPFS; las carpetas ya las
// creó la página, sólo el archivo se crea aquí. Sólo llega aquí un Safari
// que también tiene createWritable (26 o posterior, ver `supported` en
// opfs.ts), donde los métodos del handle son síncronos.
//
// A diferencia de createWritable, que escribe aparte y cambia el archivo al
// cerrar, esto escribe en el archivo mismo: lo que había se pierde al
// empezar. Por eso sólo se escribe en nombres nuevos (cada caché numera sus
// archivos y cambia de carpeta al vaciarse) y en `alive`, que nadie lee
// entero.

import type { OpfsReply, OpfsRequest } from './opfs-protocol.ts';

/** Los archivos abiertos para escribir por trozos, y dónde va el siguiente
 *  trozo que no dice su posición. */
const open = new Map<number, { handle: FileSystemSyncAccessHandle; pos: number }>();
/** Lo de cada archivo, uno detrás de otro: un trozo no se escribe antes de
 *  que se abra el archivo ni después de cerrarlo, y dos escrituras del
 *  mismo archivo (dos latidos de `alive`) no chocan: el handle es
 *  exclusivo y el segundo fallaría. */
const queues = new Map<string, Promise<unknown>>();

async function folderAt(path: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  return dir;
}

function writeBytes(h: FileSystemSyncAccessHandle, bytes: Uint8Array, at: number): number {
  let done = 0;
  while (done < bytes.byteLength) {
    const n = h.write(bytes.subarray(done), { at: at + done });
    // sin espacio, el navegador lanza QuotaExceededError; si en vez de eso
    // no escribe nada, es lo mismo, y con ese nombre la página lo dice
    if (!(n > 0)) throw new DOMException(`OPFS wrote ${n} bytes`, 'QuotaExceededError');
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
      const dir = await folderAt(req.path);
      const name = req.path[req.path.length - 1];
      const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
      try {
        h.truncate(0);
        await writeAll(h, req.data, 0);
        h.flush();
        h.close();
      } catch (e) {
        // ya vaciado: lo escrito a medias no sirve a nadie. Lo borra este
        // worker, que sabe si llegó a abrirlo; un fallo antes de abrir no
        // toca un archivo que ya existiera
        h.close();
        await dir.removeEntry(name).catch(() => {});
        throw e;
      }
      return;
    }
    case 'open': {
      const dir = await folderAt(req.path);
      const file = await dir.getFileHandle(req.path[req.path.length - 1], { create: true });
      const handle = await file.createSyncAccessHandle();
      try {
        handle.truncate(0);
      } catch (e) {
        handle.close();
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
        if (req.op === 'close') f.handle.flush();
      } finally {
        f.handle.close();
      }
      return;
    }
  }
}

/** La cola de una petición: la de su archivo abierto, o la de su ruta. */
function queueOf(req: OpfsRequest): string | null {
  if ('sid' in req) return `sid:${req.sid}`;
  if (req.op === 'put') return `path:${req.path.join('/')}`;
  return null;
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
  const key = queueOf(req);
  if (!key) {
    void work();
    return;
  }
  const next = (queues.get(key) ?? Promise.resolve()).then(work);
  queues.set(key, next);
  // la cola de un archivo terminado no se queda para siempre
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
};

// un mensaje que no se pudo leer no dice de qué petición era: la página
// deja de usar este escritor y rechaza todo lo pendiente
self.onmessageerror = () => {
  postMessage({
    id: 0,
    error: { name: 'DataCloneError', message: 'OPFS writer got an unreadable message' },
  } satisfies OpfsReply);
};
