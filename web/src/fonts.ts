// Fuentes de las etiquetas y del número de hoja. El núcleo dibuja con DejaVu
// Sans incrustada; cualquier otra fuente viaja como bytes con cada llamada de
// hoja (compute_layout, render_sheet, assemble_layout), y la misma a las tres,
// porque el layout se mide con la fuente con la que luego se dibuja.
//
// Dos clases: las de la web (archivos en /fonts/, se piden al elegirlas) y
// las que sube el usuario (TTF, OTF, WOFF o WOFF2), guardadas en IndexedDB para que
// sigan ahí al volver. El ajuste guarda sólo el id: "" (DejaVu),
// "builtin:<archivo>" o "custom:<nombre>".

import { errMsg } from './errors.ts';
import { run } from './pool.ts';
import type { Bytes } from './types.ts';
import { zipEntries } from './unzip.ts';

export interface BuiltinFont {
  id: string;
  name: string;
  file: string;
}

/** Las que trae la web (todas OFL; la licencia va al lado, en /fonts/). */
export const BUILTIN_FONTS: BuiltinFont[] = [
  {
    id: 'builtin:ArchivoBlack-Regular.ttf',
    name: 'Archivo Black',
    file: 'ArchivoBlack-Regular.ttf',
  },
  { id: 'builtin:IBMPlexMono-Regular.ttf', name: 'IBM Plex Mono', file: 'IBMPlexMono-Regular.ttf' },
  {
    id: 'builtin:CourierPrime-Regular.ttf',
    name: 'Courier Prime',
    file: 'CourierPrime-Regular.ttf',
  },
  { id: 'builtin:PTSerif-Regular.ttf', name: 'PT Serif', file: 'PTSerif-Regular.ttf' },
];

const CUSTOM = 'custom:';
/** Más que esto no es una fuente de etiquetas: es una CJK completa o un
 *  archivo equivocado, y viajaría entero con cada vista previa. */
export const MAX_FONT_BYTES = 30 * 1024 * 1024;

const DB_NAME = 'mxm-fonts';
const STORE = 'fonts';

interface StoredFont {
  name: string;
  bytes: ArrayBuffer;
  added: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB did not open'));
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? new Error('Font storage failed'));
      t.onabort = () => reject(t.error ?? new Error('Font storage failed'));
    });
  } finally {
    db.close();
  }
}

/** Bytes ya resueltos, por id: la vista previa pide la misma en cada
 *  cambio. Sólo las últimas pocas: quien prueba una carpeta de fuentes
 *  recorriendo el desplegable no debe quedarse con todas en memoria. */
const memo = new Map<string, Bytes>();
const MEMO_MAX = 6;
function remember(id: string, bytes: Bytes): void {
  memo.delete(id);
  memo.set(id, bytes);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
}
/** Las subidas que el navegador no dejó guardar: viven sólo en esta sesión. */
const unstored = new Map<string, Bytes>();

/** Nombres de las fuentes subidas, en orden alfabético. Si el navegador no
 *  deja guardar (ventana privada estricta), sólo las de esta sesión. */
export async function listCustomFonts(): Promise<string[]> {
  const names = [...unstored.keys()].map((id) => id.slice(CUSTOM.length));
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    names.push(...keys.map(String));
  } catch {
    // sin almacenamiento: sólo las de esta sesión
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function customFontId(name: string): string {
  return CUSTOM + name;
}

/** Nombre legible del id, para avisos. */
export function fontName(id: string): string {
  if (!id) return 'DejaVu Sans';
  if (id.startsWith(CUSTOM)) return id.slice(CUSTOM.length);
  return BUILTIN_FONTS.find((f) => f.id === id)?.name ?? id;
}

function sizeMessage(name: string, size: number): string {
  return `${name} is ${Math.round(size / 1048576)} MB; fonts for labels must be under 30 MB.`;
}

/**
 * Comprueba un archivo con el núcleo y lo guarda. Devuelve el id. Lanza con
 * el motivo si no es una fuente que sirva (sin letras, cortada…).
 */
export async function addCustomFont(file: File): Promise<string> {
  if (file.size > MAX_FONT_BYTES) throw new Error(sizeMessage(file.name, file.size));
  const bytes = new Uint8Array(await file.arrayBuffer());
  await run('check_font', { bytes: bytes.slice() });
  const name = file.name;
  const id = customFontId(name);
  try {
    await tx('readwrite', (s) =>
      s.put({ name, bytes: bytes.buffer, added: new Date().toISOString() } satisfies StoredFont),
    );
  } catch {
    // sin almacenamiento sirve para esta sesión: queda en memoria
    unstored.set(id, bytes);
    return id;
  }
  // guardada: se lee de IndexedDB al elegirla (lo viejo del memo, fuera)
  memo.delete(id);
  return id;
}

/** Lo que se hace con un archivo al subir en bulk, por su nombre (o su
 *  ruta dentro de un ZIP o de una carpeta). */
export function fontFileKind(path: string): 'font' | 'zip' | 'other' {
  // lo que macOS mete en los ZIP (__MACOSX/) y deja en discos externos
  // («._Fuente.ttf») no son fuentes, aunque lo parezca su extensión
  if (/(^|\/)__MACOSX\//.test(path)) return 'other';
  const base = path.split('/').pop() ?? path;
  if (base.startsWith('.')) return 'other';
  const ext = base.toLowerCase().split('.').pop() ?? '';
  // las web (WOFF, WOFF2) las descomprime el núcleo
  if (['ttf', 'otf', 'ttc', 'woff', 'woff2'].includes(ext)) return 'font';
  if (ext === 'zip') return 'zip';
  return 'other';
}

export interface BulkResult {
  /** Ids de las que entraron, en el orden de los archivos. */
  added: string[];
  /** Las que eran fuente (o ZIP) y no sirvieron, con el motivo. */
  failed: { name: string; reason: string }[];
  /** Archivos que no son fuentes (en una carpeta o un ZIP: textos, imágenes…). */
  ignored: number;
}

/**
 * Sube varios archivos: fuentes sueltas, ZIP con fuentes dentro (a cualquier
 * profundidad) o lo que salga de una carpeta. Cada fuente se comprueba por
 * separado: una rota no frena a las demás, y se cuenta como fallida con el
 * motivo. Lo que no es fuente (readmes, imágenes) se ignora en silencio.
 */
export async function addCustomFonts(
  files: Iterable<File>,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkResult> {
  const out: BulkResult = { added: [], failed: [], ignored: 0 };
  const todo: { name: string; get: () => Promise<File> }[] = [];
  const sort = (path: string, name: string, get: () => Promise<File>): void => {
    const kind = fontFileKind(path);
    if (kind === 'font') todo.push({ name, get });
    else out.ignored++;
  };
  for (const f of files) {
    if (fontFileKind(f.name) !== 'zip') {
      sort(f.name, f.name, async () => f);
      continue;
    }
    try {
      // en orden de ruta, no en el que el ZIP las guardó: la primera que
      // entra es la que queda elegida, y así es siempre la misma
      const entries = zipEntries(new Uint8Array(await f.arrayBuffer())).sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true }),
      );
      for (const e of entries) {
        const base = e.path.split('/').pop() ?? e.path;
        sort(e.path, base, async () => {
          if (e.size > MAX_FONT_BYTES) throw new Error(sizeMessage(base, e.size));
          return new File([await e.read()], base);
        });
      }
    } catch (e) {
      out.failed.push({ name: f.name, reason: errMsg(e) });
    }
  }
  for (const [i, { name, get }] of todo.entries()) {
    onProgress?.(i, todo.length);
    try {
      const id = await addCustomFont(await get());
      if (!out.added.includes(id)) out.added.push(id);
    } catch (e) {
      out.failed.push({ name, reason: errMsg(e) });
    }
  }
  onProgress?.(todo.length, todo.length);
  return out;
}

/** Borra varias de una vez. */
export async function deleteCustomFonts(ids: Iterable<string>): Promise<void> {
  for (const id of ids) await deleteCustomFont(id);
}

export async function deleteCustomFont(id: string): Promise<void> {
  memo.delete(id);
  unstored.delete(id);
  if (!id.startsWith(CUSTOM)) return;
  await tx('readwrite', (s) => s.delete(id.slice(CUSTOM.length))).catch(() => undefined);
}

/**
 * Bytes de la fuente `id`, o null para DejaVu. Una fuente que ya no está
 * (otro navegador, almacenamiento borrado, un preset ajeno) también da null:
 * la hoja sale en DejaVu, y `fontMissing` permite avisarlo.
 */
export async function fontBytes(id: string | undefined): Promise<Bytes | null> {
  if (!id) return null;
  const hit = memo.get(id) ?? unstored.get(id);
  if (hit) {
    if (memo.has(id)) remember(id, hit);
    return hit;
  }
  let bytes: Bytes | null = null;
  if (id.startsWith(CUSTOM)) {
    const name = id.slice(CUSTOM.length);
    const rec = await tx<StoredFont | undefined>('readonly', (s) => s.get(name)).catch(
      () => undefined,
    );
    if (rec) bytes = new Uint8Array(rec.bytes);
  } else {
    const b = BUILTIN_FONTS.find((f) => f.id === id);
    if (b) {
      const res = await fetch(`/fonts/${b.file}`).catch(() => null);
      if (res?.ok) bytes = new Uint8Array(await res.arrayBuffer());
    }
  }
  if (bytes) remember(id, bytes);
  return bytes;
}

/** true si el ajuste pide una fuente que este navegador no tiene. */
export async function fontMissing(id: string | undefined): Promise<boolean> {
  return !!id && !(await fontBytes(id));
}

/** El aviso de los caracteres que la fuente no tiene: cuáles son, y que
 *  salen en DejaVu. Cada uno entre comillas, para que se vea un espacio o
 *  un signo suelto. */
export function missingGlyphsWarning(id: string, chars: string): string {
  const list = [...new Set(chars)].map((c) => `“${c}”`).join(' ');
  return `The font “${fontName(id)}” has no glyph for these characters, so they are drawn in DejaVu Sans: ${list}`;
}

/** Para los argumentos de un comando: se copian al worker (no se
 *  transfieren), así el memo sigue entero. */
export async function fontArg(id: string | undefined): Promise<Bytes | undefined> {
  return (await fontBytes(id)) ?? undefined;
}
