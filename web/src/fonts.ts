// Fuentes de las etiquetas y del número de hoja. El núcleo dibuja con DejaVu
// Sans incrustada; cualquier otra fuente viaja como bytes con cada llamada de
// hoja (compute_layout, render_sheet, assemble_layout), y la misma a las tres,
// porque el layout se mide con la fuente con la que luego se dibuja.
//
// Dos clases: las de la web (archivos en /fonts/, se piden al elegirlas) y
// las que sube el usuario (TTF u OTF), guardadas en IndexedDB para que
// sigan ahí al volver. El ajuste guarda sólo el id: "" (DejaVu),
// "builtin:<archivo>" o "custom:<nombre>".

import { run } from './pool.ts';
import type { Bytes } from './types.ts';

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

/** Bytes ya resueltos, por id: la vista previa pide la misma en cada cambio. */
const memo = new Map<string, Bytes>();

/** Nombres de las fuentes subidas, en orden alfabético. Vacío si el
 *  navegador no deja guardar (ventana privada estricta). */
export async function listCustomFonts(): Promise<string[]> {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    return keys.map(String).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
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

/**
 * Comprueba un archivo con el núcleo y lo guarda. Devuelve el id. Lanza con
 * el motivo si no es una fuente que sirva (WOFF, sin letras, cortado…).
 */
export async function addCustomFont(file: File): Promise<string> {
  if (file.size > MAX_FONT_BYTES)
    throw new Error(
      `${file.name} is ${Math.round(file.size / 1048576)} MB; fonts for labels must be under 30 MB.`,
    );
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
  }
  memo.set(id, bytes);
  return id;
}

export async function deleteCustomFont(id: string): Promise<void> {
  memo.delete(id);
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
  const hit = memo.get(id);
  if (hit) return hit;
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
  if (bytes) memo.set(id, bytes);
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
