// La mudanza de mxm.sebastianlopez.me a mxmstudio.work, del lado que recibe.
//
// localStorage es de cada origen: los presets, los perfiles de calibración y
// los ajustes guardados en el dominio viejo no se ven desde este. Allí queda
// una página (deploy/old-domain/) que los lee y viene aquí con ellos en el
// fragmento de la URL, que nunca sale del navegador:
//
//   https://mxmstudio.work/#mxm-migrate=<base64url de {v, route, store, ram}>
//
// Este módulo es el primer import de main.ts, así que corre antes de que
// nada lea localStorage o la ruta. Lo que trae se SUMA a lo que ya haya aquí,
// y si un nombre está en los dos lados gana el de aquí: alguien que ya usó el
// dominio nuevo no pierde nada. Se importa UNA vez por navegador (marca
// MIGRATED_KEY): el dominio viejo sigue mandando sus datos cada vez que se
// entra por un enlace antiguo, y sin la marca un preset borrado aquí
// volvería a aparecer.
//
// Cualquiera puede escribir un enlace con #mxm-migrate=. Lo peor que logra
// es añadir presets con nombres que no existían o, a quien entra por primera
// vez, unos ajustes iniciales: todo se ve y se borra desde la propia
// interfaz, y store.ts lee cada campo con cuidado.

const PREFIX = '#mxm-migrate=';
/** Las claves del dominio viejo: store.ts (KEY) y phase2.ts. */
const STORE_KEY = 'mxm-studio-v1';
const RAM_KEY = 'mxm_ram_gb';
const MIGRATED_KEY = 'mxm-migrated-from';
const OLD_ORIGIN = 'https://mxm.sebastianlopez.me';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function decode(b64url: string): unknown {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseStore(raw: string | null): Obj {
  try {
    const v: unknown = JSON.parse(raw ?? 'null');
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** Suma el almacén viejo al de aquí. Cada clase de perfil (presets,
 *  impresora…) y `flags` se mezclan por nombre, ganando lo de aquí;
 *  `ajustes` es un bloque entero y solo entra si aquí no hay. */
function mergeStore(incoming: Obj): void {
  const current = parseStore(localStorage.getItem(STORE_KEY));
  for (const [kind, entries] of Object.entries(incoming)) {
    if (!isObj(entries)) continue;
    if (kind === 'ajustes') {
      if (!isObj(current.ajustes)) current.ajustes = entries;
      continue;
    }
    const mine = current[kind];
    current[kind] = { ...entries, ...(isObj(mine) ? mine : {}) };
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(current));
}

/** Qué decirle al usuario si la mudanza no pudo guardar sus datos; main.ts
 *  lo muestra cuando la página ya está montada. null si no hubo problema. */
export let migrationProblem: string | null = null;

if (location.hash.startsWith(PREFIX)) {
  let route = '';
  try {
    const p = decode(location.hash.slice(PREFIX.length));
    if (!isObj(p) || p.v !== 1) throw new Error('unknown migration payload');
    if (typeof p.route === 'string' && /^#[a-z]+$/.test(p.route)) route = p.route;
    if (localStorage.getItem(MIGRATED_KEY) === null) {
      if (typeof p.store === 'string') {
        const old = parseStore(p.store);
        if (Object.keys(old).length > 0) mergeStore(old);
      }
      if (typeof p.ram === 'string' && localStorage.getItem(RAM_KEY) === null) {
        localStorage.setItem(RAM_KEY, p.ram);
      }
      localStorage.setItem(MIGRATED_KEY, OLD_ORIGIN);
    }
  } catch (e) {
    console.warn('[migrate] could not import the data from the old address:', e);
    migrationProblem = `MXM Studio moved here from ${OLD_ORIGIN.replace('https://', '')}, but your saved presets and profiles could not be copied over (${e instanceof Error ? e.message : String(e)}). They are still there: open ${OLD_ORIGIN.replace('https://', '')}/?export to download them, then load the file with Import profiles in Calibration.`;
  }
  // El fragmento largo fuera de la barra de direcciones y del historial, con
  // la ruta que traía el enlace viejo en su lugar
  history.replaceState(null, '', location.pathname + location.search + route);
}
