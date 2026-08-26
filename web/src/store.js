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

function saveAll(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* almacenamiento lleno o bloqueado: la app sigue funcionando */
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
