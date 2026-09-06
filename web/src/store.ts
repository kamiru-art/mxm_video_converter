// Presets y perfiles de calibración: viven en el navegador (localStorage)
// y se pueden exportar/importar como JSON para compartirlos entre máquinas.

import type {
  ColorProfile,
  CyanProfile,
  PresetProfile,
  PrinterProfile,
  Settings,
} from './types.ts';

const KEY = 'mxm-studio-v1';

/** Qué guarda cada clase de perfil. */
export interface ProfileMap {
  presets: PresetProfile;
  impresora: PrinterProfile;
  cianotipia: CyanProfile;
  cianotipia_color: ColorProfile;
}

export type ProfileKind = keyof ProfileMap;

/** Lo guardado lleva además la fecha. */
type Stored<T> = T & { guardado?: string };

/** El almacén entero: una clave por clase de perfil, más los últimos
 *  ajustes de la fase ①. Viene de localStorage, así que la forma es la que
 *  se escribió en su día: se lee con cuidado. */
interface StoreData {
  presets?: Record<string, Stored<PresetProfile>>;
  impresora?: Record<string, Stored<PrinterProfile>>;
  cianotipia?: Record<string, Stored<CyanProfile>>;
  cianotipia_color?: Record<string, Stored<ColorProfile>>;
  ajustes?: Partial<Settings>;
  /** Resultados de pruebas del navegador que no cambian entre sesiones (la
   *  del ffmpeg multihilo): evitan repetirlas en cada carga. */
  flags?: Record<string, string>;
}

function loadAll(): StoreData {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return parsed && typeof parsed === 'object' ? (parsed as StoreData) : {};
  } catch {
    return {};
  }
}

/** Escribe el almacén entero. LANZA si el navegador no lo acepta: todo vive
 *  en UNA clave, así que un `setItem` fallido no guarda nada —ni lo nuevo ni
 *  lo que ya había—, y quien llama tiene que enterarse o la interfaz canta un
 *  “guardado” que no existe y el perfil se pierde al cerrar la pestaña. El
 *  mensaje dice qué puede hacer el usuario, que es lo único que le queda. */
function saveAll(data: StoreData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    const blocked = name === 'SecurityError' || name === 'NotAllowedError';
    throw new Error(
      blocked
        ? 'This browser is blocking storage for this site, so nothing was saved. Allow site data for this page (private windows and strict cookie settings turn it off); meanwhile “Export everything” in Calibration keeps your profiles in a file.'
        : 'The browser storage for this site is full, so nothing was saved. Use “Export everything” in Calibration to keep a copy, then delete the presets or profiles you no longer need and try again.',
    );
  }
}

function kindMap<K extends ProfileKind>(
  all: StoreData,
  kind: K,
): Record<string, Stored<ProfileMap[K]>> {
  const existing = all[kind] as Record<string, Stored<ProfileMap[K]>> | undefined;
  if (existing) return existing;
  const created: Record<string, Stored<ProfileMap[K]>> = {};
  (all as Record<string, unknown>)[kind] = created;
  return created;
}

export function listProfiles(kind: ProfileKind): string[] {
  const all = loadAll();
  return Object.keys(all[kind] ?? {}).sort();
}

export function loadProfile<K extends ProfileKind>(kind: K, name: string): ProfileMap[K] | null {
  const all = loadAll();
  const map = all[kind] as Record<string, Stored<ProfileMap[K]>> | undefined;
  return map?.[name] ?? null;
}

export function saveProfile<K extends ProfileKind>(
  kind: K,
  name: string,
  data: ProfileMap[K],
): void {
  const all = loadAll();
  kindMap(all, kind)[name] = { ...data, guardado: new Date().toISOString() };
  saveAll(all);
}

export function deleteProfile(kind: ProfileKind, name: string): void {
  const all = loadAll();
  if (all[kind]) {
    delete all[kind]?.[name];
    saveAll(all);
  }
}

export function exportAll(): string {
  return JSON.stringify(loadAll(), null, 2);
}

export function importAll(json: string): void {
  const incoming: unknown = JSON.parse(json);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('The file is not a profiles export (expected a JSON object).');
  }
  const all = loadAll() as Record<string, unknown>;
  for (const [kind, entries] of Object.entries(incoming as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object') continue;
    const current = all[kind];
    all[kind] = { ...(current && typeof current === 'object' ? current : {}), ...entries };
  }
  saveAll(all as StoreData);
}

// último estado de ajustes de la fase ① (comodidad entre sesiones)
export function loadFlag(name: string): string | null {
  return loadAll().flags?.[name] ?? null;
}

/** Guarda una bandera. No lanza: perderla solo cuesta repetir la prueba. */
export function saveFlag(name: string, value: string): void {
  try {
    const all = loadAll();
    all.flags = { ...all.flags, [name]: value };
    saveAll(all);
  } catch {
    /* sin almacenamiento: se probará otra vez la próxima vez */
  }
}

export function loadSettings(): Partial<Settings> | null {
  return loadAll().ajustes ?? null;
}

export function saveSettings(s: Settings): void {
  const all = loadAll();
  all.ajustes = s;
  saveAll(all);
}
