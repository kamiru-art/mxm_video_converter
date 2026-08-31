// Presets y perfiles de calibración: viven en el navegador (localStorage)
// y se pueden exportar/importar como JSON para compartirlos entre máquinas.

const KEY = 'mxm-studio-v1';

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

/** Escribe el almacén entero. LANZA si el navegador no lo acepta: todo vive
 *  en UNA clave, así que un `setItem` fallido no guarda nada —ni lo nuevo ni
 *  lo que ya había—, y quien llama tiene que enterarse o la interfaz canta un
 *  “guardado” que no existe y el perfil se pierde al cerrar la pestaña. El
 *  mensaje dice qué puede hacer el usuario, que es lo único que le queda. */
function saveAll(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    const blocked = e?.name === 'SecurityError' || e?.name === 'NotAllowedError';
    throw new Error(blocked
      ? 'This browser is blocking storage for this site, so nothing was saved. Allow site data for this page (private windows and strict cookie settings turn it off); meanwhile “Export everything” in Calibration keeps your profiles in a file.'
      : 'The browser storage for this site is full, so nothing was saved. Use “Export everything” in Calibration to keep a copy, then delete the presets or profiles you no longer need and try again.');
  }
}

// kinds: "presets" | "impresora" | "cianotipia" | "cianotipia_color"
export function listProfiles(kind) {
  const all = loadAll();
  return Object.keys(all[kind] ?? {}).sort();
}

export function loadProfile(kind, name) {
  const all = loadAll();
  return all[kind]?.[name] ?? null;
}

export function saveProfile(kind, name, data) {
  const all = loadAll();
  all[kind] = all[kind] ?? {};
  all[kind][name] = { ...data, guardado: new Date().toISOString() };
  saveAll(all);
}

export function deleteProfile(kind, name) {
  const all = loadAll();
  if (all[kind]) {
    delete all[kind][name];
    saveAll(all);
  }
}

export function exportAll() {
  return JSON.stringify(loadAll(), null, 2);
}

export function importAll(json) {
  const incoming = JSON.parse(json);
  const all = loadAll();
  for (const [kind, entries] of Object.entries(incoming)) {
    all[kind] = { ...(all[kind] ?? {}), ...entries };
  }
  saveAll(all);
}

// último estado de ajustes de la fase ① (comodidad entre sesiones)
export function loadSettings() {
  return loadAll().ajustes ?? null;
}

export function saveSettings(s) {
  const all = loadAll();
  all.ajustes = s;
  saveAll(all);
}
