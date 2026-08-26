// Fase ④ — Reconstruir el video final desde los fotogramas procesados.

import { el, toast, download, progressBar, dropzone, field, numberInput } from './ui.js';
import { project } from './project.js';
import { ph2 } from './phase2.js';
import { buildVideo } from './video.js';
import { sanitizeLabel } from './ui.js';

/** Resuelve la secuencia de imágenes según la línea de tiempo del layout
 *  (port de frames_from_timeline: deduplicados reutilizados, alias). */
function framesFromTimeline(layout, disponibles) {
  // alias etiqueta→claves desambiguadas
  const alias = new Map();
  for (const h of layout.hojas ?? []) {
    for (const [clave, info] of Object.entries(h.frames ?? {})) {
      const et = info?.etiqueta;
      if (et && et !== clave) {
        const k = sanitizeLabel(et);
        if (!alias.has(k)) alias.set(k, []);
        alias.get(k).push(sanitizeLabel(clave));
      }
    }
  }
  let timeline = layout.timeline ?? [];
  if (!timeline.length) {
    timeline = [];
    let pos = 1;
    for (const h of layout.hojas ?? []) {
      for (const et of Object.keys(h.frames ?? {})) {
        timeline.push({ pos: pos++, etiqueta: et, rep: et });
      }
    }
  }
  const files = [];
  const missing = new Set();
  for (const item of [...timeline].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))) {
    const rep = sanitizeLabel(item.rep ?? item.etiqueta ?? '');
    const candidates = [rep, `${rep}_procesado`, ...(alias.get(rep) ?? [])];
    let found = null;
    for (const c of candidates) {
      if (disponibles.has(c)) { found = disponibles.get(c); break; }
    }
    if (found) files.push(found);
    else missing.add(item.etiqueta ?? rep);
  }
  return { files, missing: [...missing].sort() };
}

export function mountPhase4(root) {
  let layout = null;
  const extraFrames = new Map(); // stem → Blob (fotogramas sueltos del usuario)

  const layoutInfo = el('div', { class: 'hint' });
  const stateInfo = el('div', { class: 'hint' });
  const missingBox = el('div');
  const fpsIn = numberInput(12, { min: 0.1, step: 0.1 });
  const prog = progressBar();
  prog.hide();
  const preview = el('video', { controls: '', style: 'max-width:100%; border-radius:6px; margin-top:10px; display:none' });

  function currentLayout() {
    if (layout) return layout;
    if (ph2.layout) return ph2.layout;
    if (project.layoutJson) return JSON.parse(project.layoutJson);
    return null;
  }

  function availableMap() {
    const map = new Map();
    for (const [label, png] of project.processedFrames) {
      map.set(sanitizeLabel(label), { kind: 'bytes', data: png });
    }
    for (const [stemName, blob] of extraFrames) {
      map.set(stemName, { kind: 'blob', data: blob });
    }
    return map;
  }

  function refresh() {
    const l = currentLayout();
    layoutInfo.textContent = l
      ? `Layout: ${(l.proyecto || 'proyecto')} · ${l.timeline?.length || 'sin'} posiciones en la línea de tiempo`
      : 'Carga un layout.json (o procesa escaneos en la fase ②).';
    if (l?.video?.fps_extraccion) fpsIn.value = l.video.fps_extraccion;
    const disponibles = availableMap();
    stateInfo.textContent = `${disponibles.size} fotogramas disponibles (fase ② en memoria + los que sueltes aquí).`;
    if (l) {
      const { files, missing } = framesFromTimeline(l, disponibles);
      missingBox.replaceChildren(missing.length
        ? el('div', { class: 'missing-box' }, el('strong', {}, `Faltan ${missing.length}: `), missing.slice(0, 40).join(', ') + (missing.length > 40 ? '…' : ''))
        : el('div', { class: 'allok-box' }, `🎬 Las ${files.length} posiciones del video tienen fotograma.`));
    }
  }

  const buildBtn = el('button', { class: 'btn sun', style: 'width:100%; margin-top:10px' }, '🎬 Reconstruir video');
  buildBtn.addEventListener('click', async () => {
    const l = currentLayout();
    if (!l) { toast('No hay layout.', 'err'); return; }
    const { files, missing } = framesFromTimeline(l, availableMap());
    if (!files.length) { toast('No hay fotogramas para armar el video.', 'err'); return; }
    if (missing.length && !confirm(`Faltan ${missing.length} fotogramas; el video saltará esas posiciones. ¿Continuar?`)) return;
    buildBtn.disabled = true;
    prog.show();
    try {
      const getters = files.map((f) => async () => {
        if (f.kind === 'bytes') {
          return createImageBitmap(new Blob([f.data], { type: 'image/png' }));
        }
        return createImageBitmap(f.data);
      });
      const fps = parseFloat(fpsIn.value) || 12;
      const out = await buildVideo(getters, fps, (i, n) => prog.set(i / n, `codificando ${i}/${n}`));
      const name = `${sanitizeLabel(l.proyecto || 'video')}.${out.ext}`;
      download(out.bytes, name, out.mime);
      preview.src = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
      preview.style.display = '';
      toast(`Video reconstruido (${out.ext.toUpperCase()}, ${fps} fps).`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`No se pudo codificar: ${e.message ?? e}`, 'err');
    } finally {
      buildBtn.disabled = false;
      prog.hide();
    }
  });

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '④ Video final'),
    el('div', { class: 'hint' }, 'Reconstruye la película con los fotogramas procesados en su orden original, reutilizando los dibujos deduplicados en todas sus posiciones.'),
    dropzone({
      label: 'Layout.json del proyecto (opcional si vienes de la fase ②)',
      accept: '.json',
      onFiles: async ([f]) => {
        try { layout = JSON.parse(await f.text()); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }),
    layoutInfo,
    el('h3', {}, 'Fotogramas'),
    dropzone({
      label: 'Añadir fotogramas procesados desde archivos (opcional)',
      sublabel: 'Si procesaste los escaneos en otra sesión, suelta aquí la carpeta de fotogramas.',
      accept: 'image/*,.tif,.tiff', multiple: true,
      onFiles: (files) => {
        for (const f of files) extraFrames.set(sanitizeLabel(f.name.replace(/\.[^.]+$/, '')), f);
        refresh();
      },
    }),
    stateInfo,
    missingBox,
    field('Fotogramas por segundo', fpsIn, 'Se lee del proyecto; puedes cambiarlo.'),
    buildBtn,
    prog.root,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Resultado'),
    el('div', { class: 'hint', style: 'color:var(--cian-300)' },
      'El video se codifica en tu navegador (H.264 MP4 si tu navegador puede; WebM si no). Para códecs de edición (ProRes), usa los fotogramas sueltos en tu editor.'),
    preview,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
  root.addEventListener('mxm:activated', refresh);
  refresh();
}
