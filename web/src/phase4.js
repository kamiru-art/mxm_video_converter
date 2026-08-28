// Fase ④ — Reconstruir el video final desde los fotogramas procesados.

import { el, toast, download, progressBar, dropzone, field, numberInput, select } from './ui.js';
import { project } from './project.js';
import { ph2 } from './phase2.js';
import { buildVideo, buildVideoLossless, buildVideoProres, decodeFrameBitmap } from './video.js';
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
  const fmtSel = select([
    ['auto', 'Automatic (best supported)'],
    ['mp4', 'MP4 (H.264)'],
    ['webm', 'WebM (VP9/VP8)'],
  ], 'auto');
  const qualSel = select([
    ['lossless', 'Lossless (PNG frames in a MOV, for editors)'],
    ['prores', 'ProRes 4444 (edit-ready, plays in QuickTime)'],
    ['max', 'Maximum (visually lossless, huge file)'],
    ['very_high', 'Very high'],
    ['high', 'High (recommended)'],
    ['medium', 'Medium'],
    ['low', 'Low (small file)'],
    ['custom', 'Custom bitrate…'],
  ], 'high');
  const isMovQuality = () => qualSel.value === 'lossless' || qualSel.value === 'prores';
  const bitrateIn = numberInput(8, { min: 0.5, max: 500, step: 0.5 });
  const bitrateField = field('Bitrate (Mbps)', bitrateIn);
  bitrateField.style.display = 'none';
  qualSel.addEventListener('change', () => {
    bitrateField.style.display = qualSel.value === 'custom' ? '' : 'none';
    fmtSel.disabled = isMovQuality(); // el contenedor es MOV
    refreshResInfo();
  });
  const resSel = select([
    ['original', 'Original (same as the frames)'],
    ['4320', '8K (4320p)'],
    ['2880', '5K (2880p)'],
    ['2160', '4K (2160p)'],
    ['1440', '1440p'],
    ['1080', '1080p (Full HD)'],
    ['720', '720p'],
    ['480', '480p'],
  ], 'original');
  const resInfo = el('div', { class: 'hint' }, 'Load frames to see the output resolution.');
  let nativeDims = null; // {w, h} del primer frame disponible

  function evenPair(w, h) {
    return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
  }
  function outputDims() {
    if (!nativeDims) return null;
    let { w, h } = nativeDims;
    const target = resSel.value === 'original' ? null : parseInt(resSel.value, 10);
    if (target) {
      w = w * (target / h);
      h = target;
    }
    // los MOV (PNG lossless / ProRes) no exigen dimensiones pares; H.264 sí
    const [ew, eh] = isMovQuality()
      ? [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))]
      : evenPair(w, h);
    return { w: ew, h: eh, upscaled: target ? target > nativeDims.h : false };
  }
  function refreshResInfo() {
    const d = outputDims();
    if (!d) { resInfo.textContent = 'Load frames to see the output resolution.'; return; }
    resInfo.textContent = `Output resolution: ${d.w}×${d.h}`
      + (resSel.value === 'original' ? ' (native frame size)' : ` (frames are ${nativeDims.w}×${nativeDims.h})`)
      + (d.upscaled ? '. This upscales the frames; expect some softness.' : '');
  }
  resSel.addEventListener('change', refreshResInfo);
  const nameIn = el('input', { type: 'text', placeholder: '= project name' });
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
        : el('div', { class: 'allok-box' }, `All ${files.length} video positions have a frame.`));
      // dimensiones nativas del primer frame disponible, para mostrar la salida
      const first = files[0];
      if (first) {
        const blob = first.data instanceof Blob ? first.data : new Blob([first.data], { type: 'image/png' });
        decodeFrameBitmap(blob).then((bmp) => {
          nativeDims = { w: bmp.width, h: bmp.height };
          bmp.close();
          refreshResInfo();
        }).catch(() => {});
      } else {
        nativeDims = null;
        refreshResInfo();
      }
    }
  }

  const buildBtn = el('button', { class: 'btn sun', style: 'width:100%; margin-top:10px' }, 'Rebuild video');
  buildBtn.addEventListener('click', async () => {
    const l = currentLayout();
    if (!l) { toast('No layout.', 'err'); return; }
    const { files, missing } = framesFromTimeline(l, availableMap());
    if (!files.length) { toast('There are no frames to build the video.', 'err'); return; }
    if (missing.length && !confirm(`${missing.length} frames are missing; the video will skip those positions. Continue?`)) return;
    buildBtn.disabled = true;
    prog.show();
    try {
      // un getter por dibujo ÚNICO (files repite objetos para los dedup):
      // buildVideo cachea los reescalados por identidad del getter
      const getterOf = new Map();
      const getters = files.map((f) => {
        let g = getterOf.get(f);
        if (!g) {
          g = async () => {
            const blob = f.data instanceof Blob ? f.data : new Blob([f.data], { type: 'image/png' });
            return decodeFrameBitmap(blob); // TIFF sueltos incluidos
          };
          getterOf.set(f, g);
        }
        return g;
      });
      const fps = parseFloat(fpsIn.value) || 12;
      const targetH = resSel.value === 'original' ? 0 : parseInt(resSel.value, 10);
      let out;
      if (qualSel.value === 'lossless') {
        const blobs = files.map((f) => (f.data instanceof Blob ? f.data : new Blob([f.data], { type: 'image/png' })));
        out = await buildVideoLossless(blobs, fps,
          (i, n) => prog.set(i / (n + 1), `preparing frame ${i}/${n}`), { targetH });
      } else if (qualSel.value === 'prores') {
        const blobs = files.map((f) => (f.data instanceof Blob ? f.data : new Blob([f.data], { type: 'image/png' })));
        prog.set(0.02, 'encoding ProRes…');
        out = await buildVideoProres(blobs, fps,
          (p) => prog.set(p, `encoding ProRes ${Math.round(p * 100)}%`), { targetH });
      } else {
        out = await buildVideo(getters, fps, (i, n) => prog.set(i / n, `encoding ${i}/${n}`), {
          format: fmtSel.value,
          quality: qualSel.value,
          bitrateMbps: parseFloat(bitrateIn.value) || 0,
          targetH,
        });
      }
      const base = sanitizeLabel(nameIn.value.trim() || l.proyecto || 'video');
      const name = `${base}.${out.ext}`;
      download(out.bytes, name, out.mime);
      if (preview.src) URL.revokeObjectURL(preview.src); // soltar el video anterior
      if (out.ext === 'mov') {
        // los navegadores no decodifican PNG-en-MOV ni ProRes: sin vista previa
        preview.removeAttribute('src');
        preview.style.display = 'none';
        toast(qualSel.value === 'prores'
          ? `ProRes MOV saved (${fps} fps). Open it in QuickTime or your editor; browsers cannot preview it.`
          : `Lossless MOV saved (${fps} fps). Open it in DaVinci Resolve, Premiere, VLC or IINA; QuickTime and browsers cannot play PNG video. For a QuickTime-playable master use the ProRes 4444 quality.`, 'ok');
      } else {
        preview.src = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
        preview.style.display = '';
        toast(`Video rebuilt (${out.ext.toUpperCase()}, ${fps} fps).`, 'ok');
      }
    } catch (e) {
      console.error(e);
      toast(`Encoding failed: ${e.message ?? e}`, 'err');
    } finally {
      buildBtn.disabled = false;
      prog.hide();
    }
  });

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '③ Final video'),
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
    el('h3', {}, 'Output'),
    el('div', { class: 'row' },
      field('Frames per second', fpsIn, 'Read from the project; you can change it.'),
      field('Format', fmtSel),
    ),
    el('div', { class: 'row' },
      field('Quality', qualSel),
      bitrateField,
      field('Resolution', resSel),
    ),
    resInfo,
    el('div', { class: 'hint' },
      'Lossless stores every frame as PNG inside a MOV: pixel-identical, any resolution (8K included); it opens in editors (DaVinci Resolve, Premiere) and VLC/IINA, but QuickTime Player and browsers no longer decode PNG video. ProRes 4444 is the QuickTime-playable master: visually lossless, 10-bit, ready for editing. The remaining qualities use the browser encoder, which is always lossy.'),
    field('File name', nameIn),
    buildBtn,
    prog.root,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Result'),
    el('div', { class: 'hint', style: 'color:var(--cian-300)' },
      'The video is built in your browser: H.264 MP4 or WebM (VP9/AV1) for the lossy qualities, lossless PNG-in-MOV for editors, or ProRes 4444 for QuickTime and editing. Resolutions the browser encoder rejects (some machines refuse 5K/8K H.264) still work with the MOV qualities.'),
    preview,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
  root.addEventListener('mxm:activated', refresh);
  refresh();
}
