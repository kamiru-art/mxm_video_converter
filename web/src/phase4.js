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
      ? `Layout: ${(l.proyecto || 'project')} · ${l.timeline?.length || 'no'} positions in the timeline`
      : 'Load a layout.json (or process scans in phase ②).';
    if (l?.video?.fps_extraccion) fpsIn.value = l.video.fps_extraccion;
    const disponibles = availableMap();
    stateInfo.textContent = `${disponibles.size} frames available (phase ② in memory + whatever you drop here).`;
    if (l) {
      const { files, missing } = framesFromTimeline(l, disponibles);
      missingBox.replaceChildren(missing.length
        ? el('div', { class: 'missing-box' }, el('strong', {}, `Missing ${missing.length}: `), missing.slice(0, 40).join(', ') + (missing.length > 40 ? '…' : ''))
        : el('div', { class: 'allok-box' }, `🎬 All ${files.length} video positions have a frame.`));
    }
  }

  const buildBtn = el('button', { class: 'btn sun', style: 'width:100%; margin-top:10px' }, '🎬 Rebuild video');
  buildBtn.addEventListener('click', async () => {
    const l = currentLayout();
    if (!l) { toast('No layout.', 'err'); return; }
    const { files, missing } = framesFromTimeline(l, availableMap());
    if (!files.length) { toast('There are no frames to build the video.', 'err'); return; }
    if (missing.length && !confirm(`${missing.length} frames are missing; the video will skip those positions. Continue?`)) return;
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
      const out = await buildVideo(getters, fps, (i, n) => prog.set(i / n, `encoding ${i}/${n}`));
      const name = `${sanitizeLabel(l.proyecto || 'video')}.${out.ext}`;
      download(out.bytes, name, out.mime);
      preview.src = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
      preview.style.display = '';
      toast(`Video rebuilt (${out.ext.toUpperCase()}, ${fps} fps).`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Encoding failed: ${e.message ?? e}`, 'err');
    } finally {
      buildBtn.disabled = false;
      prog.hide();
    }
  });

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '④ Final video'),
    el('div', { class: 'hint' }, 'Rebuilds the film with the processed frames in their original order, reusing deduplicated drawings in all their positions.'),
    dropzone({
      label: 'Project layout.json (optional if you come from phase ②)',
      accept: '.json',
      onFiles: async ([f]) => {
        try { layout = JSON.parse(await f.text()); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }),
    layoutInfo,
    el('h3', {}, 'Frames'),
    dropzone({
      label: 'Add processed frames from files (optional)',
      sublabel: 'If you processed the scans in another session, drop the frames folder here.',
      accept: 'image/*,.tif,.tiff', multiple: true,
      onFiles: (files) => {
        for (const f of files) extraFrames.set(sanitizeLabel(f.name.replace(/\.[^.]+$/, '')), f);
        refresh();
      },
    }),
    stateInfo,
    missingBox,
    field('Frames per second', fpsIn, 'Read from the project; you can change it.'),
    buildBtn,
    prog.root,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Result'),
    el('div', { class: 'hint', style: 'color:var(--cian-300)' },
      'The video is encoded in your browser (H.264 MP4 when supported; WebM otherwise). For editing codecs (ProRes), use the individual frames in your editor.'),
    preview,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
  root.addEventListener('mxm:activated', refresh);
  refresh();
}
