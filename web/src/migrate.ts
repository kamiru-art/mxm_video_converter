// La mudanza de mxm.sebastianlopez.me a mxmstudio.work, del lado que recibe.
//
// localStorage es de cada origen: los presets, los perfiles de calibración y
// los ajustes guardados en el dominio viejo no se ven desde este. Allí queda
// una página (deploy/old-domain/) que los lee y viene aquí con ellos en el
// fragmento de la URL, que no se manda a ningún servidor:
//
//   https://mxmstudio.work/#mxm-migrate=<base64url de {v, id, route, store, ram}>
//
// El fragmento sí queda un instante en el historial del navegador (y en el
// sincronizado) antes de que replaceState lo quite: lo que viaja son ajustes
// de impresión y calibración, sin datos personales, y se aceptó así.
//
// main.ts llama a runMigration() antes de mostrar nada. Lo que llega se SUMA
// a lo que ya hay y, si un nombre está en los dos lados, gana el de aquí
// (store.mergeFromOldAddress). Cada navegador viejo manda un `id` propio y
// cada id se importa UNA vez (IMPORTED_KEY): el dominio viejo sigue mandando
// sus datos cada vez que se entra por un enlace antiguo, y sin esto un preset
// borrado aquí volvería a aparecer. Que sea por id, y no una marca única,
// importa: si alguien abre un enlace de mudanza ajeno (copiado de otro, o
// fabricado), eso no le impide importar después los suyos.
//
// Lo peor que logra un enlace fabricado es añadir presets o perfiles con
// nombres nuevos, o unos ajustes iniciales a quien entra por primera vez:
// todo se ve y se borra desde la interfaz. Los `flags` no viajan.

import { mergeFromOldAddress, RAM_KEY } from './store.ts';

const PREFIX = '#mxm-migrate=';
const IMPORTED_KEY = 'mxm-migrated-ids';
const OLD_HOST = 'mxm.sebastianlopez.me';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function decode(b64url: string): unknown {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function importedIds(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Si la URL trae una mudanza, la importa y deja la URL limpia con la ruta
 *  que traía el enlace viejo. Devuelve qué decirle al usuario si no se pudo
 *  guardar, o null. */
export function runMigration(): string | null {
  if (!location.hash.startsWith(PREFIX)) return null;
  let route = '';
  let problem: string | null = null;
  try {
    const p = decode(location.hash.slice(PREFIX.length));
    if (!isObj(p) || p.v !== 1 || typeof p.id !== 'string' || !p.id) {
      throw new Error('unknown migration payload');
    }
    if (typeof p.route === 'string' && /^#[a-z]+$/.test(p.route)) route = p.route;
    const ids = importedIds();
    if (!ids.includes(p.id)) {
      if (typeof p.store === 'string') mergeFromOldAddress(p.store);
      if (typeof p.ram === 'string' && localStorage.getItem(RAM_KEY) === null) {
        localStorage.setItem(RAM_KEY, p.ram);
      }
      localStorage.setItem(IMPORTED_KEY, JSON.stringify([...ids, p.id]));
    }
  } catch (e) {
    console.warn('[migrate] could not import the data from the old address:', e);
    problem = `MXM Studio moved here from ${OLD_HOST}, but your saved presets and profiles could not be copied over (${e instanceof Error ? e.message : String(e)}). They are still there: open ${OLD_HOST}/?export to download them, then load the file with Import profiles in Calibration.`;
  }
  // El fragmento largo fuera de la barra de direcciones y del historial, con
  // la ruta que traía el enlace viejo en su lugar
  history.replaceState(null, '', location.pathname + location.search + route);
  return problem;
}
