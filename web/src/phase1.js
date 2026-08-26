// Fase ① — Generar hojas de contacto.

import { run } from './pool.js';
import { el, toast, download, progressBar, dropzone, field, numberInput, select, check,
         selectIndices, uniquifyLabels, originalPageNumbers, sanitizeLabel, pngUrl } from './ui.js';
import { project, clearFrames, frameImageData, ensureThumb } from './project.js';
import { extractFrames, probeVideo } from './video.js';
import { generateSheets, resolveCyanCurve, packThumbs, packImageData, settingsForCore } from './gen.js';
import * as store from './store.js';
import { makeZip } from './zip.js';

const PAPERS = ['A4', 'A3', 'A5', 'A6', 'B4', 'B5', 'Carta (Letter)', 'Oficio (Legal)', 'Tabloide (Tabloid)', 'Personalizado'];
const ORIENTATIONS = ['Mejor ajuste (automático)', 'Vertical', 'Horizontal'];
const CORNERS = ['Inferior derecha', 'Inferior izquierda', 'Superior derecha', 'Superior izquierda'];

export function defaultSettings() {
  return {
    paper: 'A4', orientation: 'Mejor ajuste (automático)', dpi: 300,
    custom_w_mm: 210, custom_h_mm: 297, margin_mm: 10, gutter_mm: 5,
    bg_color: '#FFFFFF', alpha_mode: 'ninguno', alpha_bg_color: '#000000',
    alpha_border_color: '#000000', alpha_border_mm: 0.5,
    cols: 4, rows: 5, labels_on: true, base_name: 'abc', separator: '_',
    leading_zeros: 3, start_index: 1, font_size_pt: 9, label_gap_mm: 1.5,
    label_color: '#000000', page_num_on: true, page_num_corner: 'Inferior derecha',
    page_num_prefix: '', page_num_start: 1, page_num_zeros: 1, page_num_size_pt: 11,
    page_num_color: '#000000', registration_on: true, marker_count: 8,
    marker_size_mm: 8, marker_margin_mm: 4, marker_dict: 'DICT_4X4_50',
    qr_on: true, qr_size_mm: 10, gray_patch_on: false, project_name: '',
    mode: 'normal', cyan_mirror: true, cyan_ink: '#000000', cyan_curve: null,
    cyan_curve_strength: 100, cyan_adaptive: 0, cyan_clarity: 0,
    cyan_bg: 'ahorro', cyan_halo_mm: 5, cyan_frame_border_mm: 0.8,
    cyan_block_color: null, cyan_ink_stops: null,
    print_scale_x: 1, print_scale_y: 1, out_name: 'hojas',
    fmt_png: true, fmt_pdf: true, fmt_tiff: false,
  };
}

// estado de la fase (persistido en localStorage)
export const ph1 = {
  settings: { ...defaultSettings(), ...(store.loadSettings() ?? {}) },
  include: '', exclude: '',
  naming: 'auto',           // auto | original (nombre de archivo)
  numbering: 'continua',    // continua | original
  pageNumbering: 'continua',
  dedupOn: true, dedupThreshold: 4,
  dedupGroups: null,        // {reps, rep_of} sobre la selección actual
  keepOriginals: true, exportFrames: false,
  sheets_include: '', sheets_exclude: '',
  previewPage: 0, previewSimulate: false,
  cyanResponse: null,       // respuesta medida del perfil (soft-proof)
};

function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

function formatLabel(s, num) {
  let str = String(num);
  while (str.length < (s.leading_zeros ?? 1)) str = '0' + str;
  return s.base_name ? `${s.base_name}${s.separator}${str}` : str;
}

/** Plan de impresión completo (selección → dedup → etiquetas → timeline). */
export function computePlan() {
  const s = ph1.settings;
  const N = project.frames.length;
  const positions = selectIndices(N, ph1.include, ph1.exclude);
  let rawLabels = positions.map((pos, k) => {
    if (ph1.naming === 'original') return stem(project.frames[pos - 1].name);
    const num = ph1.numbering === 'original' ? s.start_index + pos - 1 : s.start_index + k;
    return formatLabel(s, num);
  });
  rawLabels = uniquifyLabels(rawLabels);

  let reps = positions.map((_, k) => k);
  let repOf = reps.slice();
  if (ph1.dedupOn && ph1.dedupGroups && ph1.dedupGroups.rep_of.length === positions.length) {
    reps = ph1.dedupGroups.reps;
    repOf = ph1.dedupGroups.rep_of;
  }
  const printed = reps.map((k) => ({
    frameIdx: positions[k] - 1,
    label: rawLabels[k],
    pos: positions[k],
  }));
  const timeline = positions.map((pos, k) => ({
    pos: k + 1, etiqueta: rawLabels[k], rep: rawLabels[repOf[k]],
  }));
  const perPage = Math.max(1, s.cols * s.rows);
  const pageNumbers = ph1.pageNumbering === 'original'
    ? originalPageNumbers(printed.map((p) => p.pos), perPage, s.page_num_start)
    : null;
  const numPages = Math.max(printed.length ? 1 : 0, Math.ceil(printed.length / perPage));
  return { positions, rawLabels, printed, timeline, pageNumbers, numPages, perPage };
}

async function computeDedup(statusEl) {
  const positions = selectIndices(project.frames.length, ph1.include, ph1.exclude);
  if (!positions.length) { ph1.dedupGroups = null; return; }
  statusEl.textContent = 'analizando dibujos repetidos…';
  const thumbs = [];
  for (const pos of positions) thumbs.push(await ensureThumb(pos - 1));
  const { meta, pixels } = packThumbs(thumbs);
  const hashes = await run('dedup_hashes', { meta, pixels }, [pixels.buffer]);
  const groups = JSON.parse(await run('group_duplicates', { hashes, threshold: ph1.dedupThreshold }));
  ph1.dedupGroups = groups;
  const dups = groups.rep_of.filter((r, i) => r !== i).length;
  statusEl.textContent = dups
    ? `↺ ${dups} fotograma(s) repetidos: se imprimen una sola vez y se reutilizan al armar el video.`
    : 'sin dibujos repetidos en la selección.';
}

// ── Interfaz ──────────────────────────────────────────────────

export function mountPhase1(root) {
  const s = ph1.settings;

  // ---------- panel de origen ----------
  const framesInfo = el('div', { class: 'hint' }, 'Sin fotogramas todavía.');
  const thumbsGrid = el('div', { class: 'thumbs' });
  const extractProg = progressBar();
  extractProg.hide();

  const startIn = numberInput(0, { min: 0, step: 0.1 });
  const endIn = el('input', { type: 'number', min: 0, step: 0.1, placeholder: 'fin' });
  const fpsIn = el('input', { type: 'number', min: 0, step: 0.1, value: 4, placeholder: 'fps' });
  const allFrames = check('TODOS los fotogramas (cuadro a cuadro)', false);

  let pendingVideo = null;
  const videoInfo = el('div', { class: 'hint' });

  const extractBtn = el('button', { class: 'btn blue small', disabled: '' }, 'Extraer fotogramas');
  extractBtn.addEventListener('click', async () => {
    if (!pendingVideo) return;
    extractBtn.disabled = true;
    extractProg.show();
    clearFrames();
    try {
      const meta = await extractFrames(pendingVideo, {
        start: parseFloat(startIn.value) || 0,
        end: endIn.value ? parseFloat(endIn.value) : undefined,
        fps: allFrames.input.checked ? null : (parseFloat(fpsIn.value) || null),
        onFrame: async (blob, thumb, t, i, w, h) => {
          project.frames.push({ name: `frame_${String(i + 1).padStart(6, '0')}.png`, blob, thumb, w, h, hasAlpha: false });
        },
        onProgress: (i, est) => extractProg.set(est ? i / est : 0.5, `fotograma ${i}${est ? ` de ~${est}` : ''}`),
      });
      project.videoMeta = { fps_extraccion: meta.fps, origen: meta.origen };
      toast(`${meta.count} fotogramas extraídos sin pérdida (PNG).`, 'ok');
      afterFramesChanged();
    } catch (e) {
      toast(`No se pudo extraer: ${e.message}`, 'err');
    } finally {
      extractBtn.disabled = false;
      extractProg.hide();
    }
  });

  const dz = dropzone({
    label: 'Suelta aquí tu video o una carpeta de imágenes',
    sublabel: 'MP4 / MOV / WebM / MKV — o PNG, JPG, TIFF, WebP (también de 16 bits). Nada se sube a ningún sitio.',
    accept: 'video/*,image/*,.tif,.tiff',
    multiple: true,
    onFiles: async (fileList) => {
      const videos = fileList.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name));
      const images = fileList.filter((f) => !videos.includes(f));
      if (videos.length) {
        pendingVideo = videos[0];
        try {
          const p = await probeVideo(pendingVideo);
          videoInfo.textContent = `${pendingVideo.name} — ${p.width}×${p.height}, ${p.duration.toFixed(1)} s${p.fps ? `, ${p.fps.toFixed(2)} fps` : ''}. Elige rango/fps y pulsa «Extraer».`;
          endIn.value = p.duration.toFixed(1);
          extractBtn.disabled = false;
        } catch (e) {
          toast(e.message, 'err');
        }
      } else if (images.length) {
        clearFrames();
        images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const f of images) {
          const needsWasmDecode = /\.(tif|tiff)$/i.test(f.name);
          let w = 0, h = 0, hasAlpha = false;
          if (!needsWasmDecode) {
            try {
              const bmp = await createImageBitmap(f);
              w = bmp.width; h = bmp.height; bmp.close();
              hasAlpha = /\.png$/i.test(f.name) || /\.webp$/i.test(f.name);
            } catch { continue; }
          } else {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const r = await run('decode_image', { bytes }, [bytes.buffer]);
            w = r.w; h = r.h; hasAlpha = r.had_alpha;
          }
          project.frames.push({ name: f.name, blob: f, thumb: null, w, h, hasAlpha, needsWasmDecode });
        }
        project.videoMeta = { origen: 'imágenes', fps_extraccion: 12 };
        toast(`${project.frames.length} imágenes cargadas.`, 'ok');
        afterFramesChanged();
      }
    },
  });

  // ---------- selección, nombres, dedup ----------
  const includeIn = el('input', { type: 'text', placeholder: 'ej. 1, 3-5 (vacío = todos)' });
  const excludeIn = el('input', { type: 'text', placeholder: 'ej. 8, 12' });
  includeIn.addEventListener('change', () => { ph1.include = includeIn.value; afterFramesChanged(); });
  excludeIn.addEventListener('change', () => { ph1.exclude = excludeIn.value; afterFramesChanged(); });

  const namingSel = select([['auto', 'Autoincremental (abc_001…)'], ['original', 'Nombre del archivo original']], ph1.naming);
  const numberingSel = select([['continua', 'Continua (1, 2, 3…)'], ['original', 'Original (posición en el video)']], ph1.numbering);
  const pageNumberingSel = select([['continua', 'Continua (1, 2, 3…)'], ['original', 'Original (según los fotogramas)']], ph1.pageNumbering);
  namingSel.addEventListener('change', () => { ph1.naming = namingSel.value; refreshPreview(); });
  numberingSel.addEventListener('change', () => { ph1.numbering = numberingSel.value; refreshPreview(); });
  pageNumberingSel.addEventListener('change', () => { ph1.pageNumbering = pageNumberingSel.value; refreshPreview(); });

  const dedupCheck = check('Detectar dibujos repetidos (imprimir una sola vez)', ph1.dedupOn);
  const dedupStatus = el('div', { class: 'hint' });
  dedupCheck.input.addEventListener('change', async () => {
    ph1.dedupOn = dedupCheck.input.checked;
    if (ph1.dedupOn) await computeDedup(dedupStatus);
    else dedupStatus.textContent = '';
    refreshPreview(); renderThumbs();
  });

  // ---------- ajustes de hoja (enlace genérico) ----------
  const binds = [];
  function bindNum(key, input, { integer = false } = {}) {
    input.value = s[key];
    input.addEventListener('change', () => {
      const v = integer ? parseInt(input.value, 10) : parseFloat(input.value);
      if (!Number.isNaN(v)) s[key] = v;
      persist(); refreshPreview();
    });
    binds.push(() => { input.value = s[key]; });
    return input;
  }
  function bindText(key, input) {
    input.value = s[key] ?? '';
    input.addEventListener('change', () => { s[key] = input.value; persist(); refreshPreview(); });
    binds.push(() => { input.value = s[key] ?? ''; });
    return input;
  }
  function bindSel(key, input) {
    input.value = s[key];
    input.addEventListener('change', () => { s[key] = input.value; persist(); refreshPreview(); });
    binds.push(() => { input.value = s[key]; });
    return input;
  }
  function bindCheck(key, c) {
    c.input.checked = !!s[key];
    c.input.addEventListener('change', () => { s[key] = c.input.checked; persist(); refreshPreview(); });
    binds.push(() => { c.input.checked = !!s[key]; });
    return c.label;
  }
  function bindColor(key, input) {
    input.value = s[key] ?? '#000000';
    input.addEventListener('input', () => { s[key] = input.value.toUpperCase(); persist(); refreshPreviewSoon(); });
    binds.push(() => { input.value = s[key] ?? '#000000'; });
    return input;
  }
  function persist() { store.saveSettings(s); }

  const customRow = el('div', { class: 'row' },
    field('Ancho (mm)', bindNum('custom_w_mm', numberInput(210, { min: 30 }))),
    field('Alto (mm)', bindNum('custom_h_mm', numberInput(297, { min: 30 }))),
  );
  const paperSel = bindSel('paper', select(PAPERS, s.paper));
  const syncCustom = () => { customRow.style.display = paperSel.value === 'Personalizado' ? '' : 'none'; };
  paperSel.addEventListener('change', syncCustom);
  syncCustom();

  // ---------- cianotipia ----------
  const modeCheck = check('MODO CIANOTIPIA: generar negativos para acetato', String(s.mode).startsWith('cian'));
  const cyanBox = el('fieldset', {}, el('legend', {}, '☀️ Cianotipia'));
  modeCheck.input.addEventListener('change', () => {
    s.mode = modeCheck.input.checked ? 'cianotipia' : 'normal';
    cyanBody.style.display = modeCheck.input.checked ? '' : 'none';
    simulateToggle.parentElement.style.display = modeCheck.input.checked ? '' : 'none';
    persist(); refreshPreview();
  });

  const curveProfiles = () => [['', '(sin curva: lineal)'], ...store.listProfiles('cianotipia').map((n) => [n, n])];
  const curveSel = select(curveProfiles(), '');
  curveSel.addEventListener('change', () => {
    const p = curveSel.value ? store.loadProfile('cianotipia', curveSel.value) : null;
    s.cyan_curve = p?.lut ?? null;
    ph1.cyanResponse = p?.respuesta ?? null;
    if (p?.ink && p.ink !== s.cyan_ink && !s.cyan_ink_stops) {
      toast(`Ojo: esta curva se midió con la tinta ${p.ink} y ahora usas ${s.cyan_ink}.`);
    }
    persist(); refreshPreview();
  });
  const inkProfiles = () => [['', '(tinta simple)'], ...store.listProfiles('cianotipia_color').map((n) => [n, n])];
  const inkProfSel = select(inkProfiles(), '');
  inkProfSel.addEventListener('change', () => {
    const p = inkProfSel.value ? store.loadProfile('cianotipia_color', inkProfSel.value) : null;
    if (p) {
      s.cyan_ink_stops = p.stops ?? null;
      s.cyan_ink = p.mejor_color ?? s.cyan_ink;
      if (p.mejor_color) s.cyan_block_color = p.mejor_color;
      toast(`Degradado ColorBlocker aplicado (${p.mejor_color ?? ''}).`, 'ok');
    } else {
      s.cyan_ink_stops = null;
    }
    persist(); refreshPreview();
  });

  const cyanBody = el('div', {},
    bindCheck('cyan_mirror', check('Espejar (impresión emulsión-contra-emulsión)', s.cyan_mirror)),
    el('div', { class: 'row' },
      field('Color de tinta', bindColor('cyan_ink', el('input', { type: 'color' }))),
      field('Perfil de color (ColorBlocker)', inkProfSel),
    ),
    field('Curva de compensación (perfil de cianotipia)', curveSel,
      'Se calibra en la fase ③. Sin curva, densidad = brillo original.'),
    el('div', { class: 'row' },
      field('Fuerza de la curva (%)', bindNum('cyan_curve_strength', numberInput(100, { min: 0, max: 100 }))),
      field('Adaptación al contenido (%)', bindNum('cyan_adaptive', numberInput(0, { min: 0, max: 100 }))),
      field('Micro-contraste (%)', bindNum('cyan_clarity', numberInput(0, { min: 0, max: 100 }))),
    ),
    field('Fondo del negativo', bindSel('cyan_bg', select([['ahorro', 'AHORRO de tinta (solo halos entintados)'], ['completo', 'Completo (todo el fondo entintado)']], s.cyan_bg))),
    el('div', { class: 'row' },
      field('Halo entintado (mm)', bindNum('cyan_halo_mm', numberInput(5, { min: 0, step: 0.5 }))),
      field('Borde bloqueador (mm)', bindNum('cyan_frame_border_mm', numberInput(0.8, { min: 0, step: 0.1 }))),
    ),
  );
  cyanBody.style.display = String(s.mode).startsWith('cian') ? '' : 'none';
  cyanBox.append(modeCheck.label, cyanBody);

  // ---------- perfil de impresora ----------
  const printerProfiles = () => [['', '(sin compensación)'], ...store.listProfiles('impresora').map((n) => [n, n])];
  const printerSel = select(printerProfiles(), '');
  printerSel.addEventListener('change', () => {
    const p = printerSel.value ? store.loadProfile('impresora', printerSel.value) : null;
    s.print_scale_x = p?.scale_x ?? 1;
    s.print_scale_y = p?.scale_y ?? 1;
    if (p?.marker_recomendado_mm) s.marker_size_mm = Math.max(s.marker_size_mm, p.marker_recomendado_mm);
    if (p?.qr_recomendado_mm) s.qr_size_mm = Math.max(s.qr_size_mm, p.qr_recomendado_mm);
    binds.forEach((b) => b());
    persist(); refreshPreview();
    if (p) toast(`Perfil de impresora aplicado (escala ${(p.scale_x * 100).toFixed(1)} % × ${(p.scale_y * 100).toFixed(1)} %).`, 'ok');
  });

  // ---------- presets ----------
  const presetSel = select([['', '(elegir preset…)'], ...store.listProfiles('presets').map((n) => [n, n])], '');
  const presetName = el('input', { type: 'text', placeholder: 'nombre del preset' });
  const refreshPresetList = () => {
    presetSel.replaceChildren(...[['', '(elegir preset…)'], ...store.listProfiles('presets').map((n) => [n, n])]
      .map(([v, l]) => el('option', { value: v }, l)));
  };
  const presetsRow = el('div', {},
    el('div', { class: 'row tight' },
      field('Presets guardados', presetSel),
      el('button', {
        class: 'btn ghost small', onclick: () => {
          if (!presetSel.value) return;
          const p = store.loadProfile('presets', presetSel.value);
          if (p?.settings) {
            Object.assign(s, p.settings);
            Object.assign(ph1, p.fase ?? {});
            binds.forEach((b) => b());
            persist(); refreshPreview();
            toast(`Preset «${presetSel.value}» cargado.`, 'ok');
          }
        },
      }, 'Cargar'),
      el('button', {
        class: 'btn danger small', onclick: () => {
          if (presetSel.value) { store.deleteProfile('presets', presetSel.value); refreshPresetList(); }
        },
      }, 'Borrar'),
    ),
    el('div', { class: 'row tight' },
      field('Guardar ajustes actuales como', presetName),
      el('button', {
        class: 'btn ghost small', onclick: () => {
          const name = presetName.value.trim();
          if (!name) return;
          store.saveProfile('presets', name, {
            settings: s,
            fase: { naming: ph1.naming, numbering: ph1.numbering, pageNumbering: ph1.pageNumbering, dedupOn: ph1.dedupOn },
          });
          refreshPresetList();
          toast(`Preset «${name}» guardado.`, 'ok');
        },
      }, 'Guardar'),
    ),
  );

  // ---------- generación ----------
  const genProg = progressBar();
  genProg.hide();
  const warnBox = el('ul', { class: 'warnlist' });
  const genBtn = el('button', { class: 'btn sun', style: 'width:100%; margin-top:8px' }, '🖨️ Generar hojas (ZIP: PNG + PDF + layout.json)');
  genBtn.addEventListener('click', async () => {
    const plan = computePlan();
    if (!plan.printed.length) { toast('No hay fotogramas que imprimir.', 'err'); return; }
    genBtn.disabled = true;
    genProg.show();
    try {
      const thumbs = [];
      if (String(s.mode).startsWith('cian') && (s.cyan_adaptive ?? 0) > 0) {
        for (const p of plan.printed) thumbs.push(await ensureThumb(p.frameIdx));
      }
      const settings = await resolveCyanCurve({ ...s, sheets_include: ph1.sheets_include, sheets_exclude: ph1.sheets_exclude }, thumbs);
      const frames = plan.printed.map((p) => {
        const f = project.frames[p.frameIdx];
        return {
          name: f.name, w: f.w, h: f.h, hasAlpha: f.hasAlpha, blob: f.blob,
          getImageData: (full) => frameImageData(p.frameIdx, full),
        };
      });
      const out = await generateSheets({
        settings, frames, labels: plan.printed.map((p) => p.label),
        pageNumbers: plan.pageNumbers, timeline: plan.timeline,
        videoMeta: project.videoMeta, keepOriginals: ph1.keepOriginals,
        exportFrames: ph1.exportFrames,
        onProgress: (d, t, note) => genProg.set(d / t, note),
      });
      project.layoutJson = out.layoutJson;
      warnBox.replaceChildren(...out.avisos.map((a) => el('li', {}, a)));
      genProg.set(1, 'empaquetando ZIP…');
      const zip = await makeZip(out.files, (i, n) => genProg.set(1, `empaquetando ${i}/${n}`));
      download(zip, `${sanitizeLabel(s.out_name || 'hojas')}.zip`, 'application/zip');
      toast(`Listo: ${out.numPages} hoja(s). Imprime al 100 % (sin «ajustar a página»).`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Error al generar: ${e.message ?? e}`, 'err');
    } finally {
      genBtn.disabled = false;
      genProg.hide();
    }
  });

  // ---------- vista previa ----------
  const previewImg = el('img', { alt: 'Vista previa de la hoja', style: 'display:none' });
  previewImg.addEventListener('load', () => { previewImg.style.display = ''; });
  const previewInfo = el('div', { class: 'progress-note', style: 'margin-top:8px; text-align:center' });
  const prevBtn = el('button', { onclick: () => { ph1.previewPage--; refreshPreview(); } }, '‹');
  const nextBtn = el('button', { onclick: () => { ph1.previewPage++; refreshPreview(); } }, '›');
  const pageLabel = el('span', {}, '—');
  const simulateToggle = check('Simular copia azul final', false);
  simulateToggle.input.addEventListener('change', () => { ph1.previewSimulate = simulateToggle.input.checked; refreshPreview(); });
  simulateToggle.label.style.color = 'var(--cian-200)';
  simulateToggle.label.parentElement;

  let previewBusy = false, previewQueued = false, previewTimer = null;
  function refreshPreviewSoon() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 300);
  }
  async function refreshPreview() {
    if (!project.frames.length) return;
    if (previewBusy) { previewQueued = true; return; }
    previewBusy = true;
    try {
      const plan = computePlan();
      if (!plan.printed.length) return;
      ph1.previewPage = Math.max(0, Math.min(ph1.previewPage, plan.numPages - 1));
      const chunk = plan.printed.slice(ph1.previewPage * plan.perPage, (ph1.previewPage + 1) * plan.perPage);
      const settingsPrev = await resolveCyanCurve({ ...s, dpi: Math.min(s.dpi, 150) }, []);
      const items = [];
      for (const p of chunk) {
        const d = await frameImageData(p.frameIdx, false);
        items.push({ data: d.data, w: d.w, h: d.h, hasAlpha: project.frames[p.frameIdx].hasAlpha, origName: project.frames[p.frameIdx].name });
      }
      const { meta, pixels } = packImageData(items);
      const first = project.frames[plan.printed[0].frameIdx];
      const pnum = plan.pageNumbers ? plan.pageNumbers[ph1.previewPage] : (s.page_num_start + ph1.previewPage);
      const res = await run('render_sheet', {
        settings: settingsForCore(settingsPrev),
        firstW: first.w, firstH: first.h, meta, pixels,
        labels: JSON.stringify(chunk.map((p) => p.label)),
        sheetNum: pnum, render: true,
        finish: ph1.previewSimulate ? 'simulate' : 'final',
        response: JSON.stringify(ph1.cyanResponse ?? null),
      }, [pixels.buffer]);
      if (res.png) {
        const old = previewImg.src;
        previewImg.src = pngUrl(res.png);
        if (old) URL.revokeObjectURL(old);
      }
      const info = JSON.parse(await run('compute_layout', { settings: settingsForCore(settingsPrev), firstW: first.w, firstH: first.h }));
      pageLabel.textContent = `hoja ${ph1.previewPage + 1} / ${plan.numPages}`;
      previewInfo.textContent = `${info.landscape ? 'horizontal' : 'vertical'} · cuadrícula ${info.cols}×${info.rows}${info.grid_swapped ? ' (intercambiada por mejor ajuste)' : ''} · ${plan.printed.length} frames en ${plan.numPages} hoja(s)`;
      warnBox.replaceChildren(...(info.avisos ?? []).map((a) => el('li', {}, a)));
    } catch (e) {
      console.error('preview', e);
    } finally {
      previewBusy = false;
      if (previewQueued) { previewQueued = false; refreshPreview(); }
    }
  }

  async function renderThumbs() {
    thumbsGrid.replaceChildren();
    const plan = computePlan();
    const dupSet = new Set();
    if (ph1.dedupOn && ph1.dedupGroups) {
      ph1.dedupGroups.rep_of.forEach((r, i) => { if (r !== i) dupSet.add(i); });
    }
    const max = Math.min(plan.positions.length, 400);
    for (let k = 0; k < max; k++) {
      const idx = plan.positions[k] - 1;
      const c = await ensureThumb(idx);
      const img = el('canvas', { width: c.width, height: c.height });
      img.getContext('2d').drawImage(c, 0, 0);
      thumbsGrid.append(el('div', { class: `thumb${dupSet.has(k) ? ' dup' : ''}` }, img,
        el('div', { class: 'tag' }, plan.rawLabels[k])));
    }
    framesInfo.textContent = `${project.frames.length} fotogramas cargados · ${plan.positions.length} seleccionados · ${plan.printed.length} a imprimir`;
  }

  async function afterFramesChanged() {
    ph1.dedupGroups = null;
    if (ph1.dedupOn && project.frames.length) await computeDedup(dedupStatus);
    await renderThumbs();
    refreshPreview();
  }

  // refrescar listas de perfiles al volver a esta vista
  root.addEventListener('mxm:activated', () => {
    curveSel.replaceChildren(...curveProfiles().map(([v, l]) => el('option', { value: v }, l)));
    inkProfSel.replaceChildren(...inkProfiles().map(([v, l]) => el('option', { value: v }, l)));
    printerSel.replaceChildren(...printerProfiles().map(([v, l]) => el('option', { value: v }, l)));
    refreshPresetList();
  });

  // ---------- montaje ----------
  const paper = el('div', { class: 'paper' },
    el('h2', {}, '① Generar hojas de contacto'),
    el('div', { class: 'hint' }, 'De un video (o imágenes) a hojas imprimibles con marcadores de registro.'),
    dz, videoInfo,
    el('div', { class: 'row tight', style: 'margin-top:8px' },
      field('Inicio (s)', startIn), field('Fin (s)', endIn), field('fps', fpsIn),
    ),
    allFrames.label,
    extractBtn, extractProg.root,

    el('h3', {}, 'Selección y nombres'),
    el('div', { class: 'row' },
      field('Incluir fotogramas', includeIn), field('Excluir', excludeIn),
    ),
    field('Etiquetas', namingSel),
    el('div', { class: 'row' },
      field('Nombre base', bindText('base_name', el('input', { type: 'text' }))),
      field('Separador', bindText('separator', el('input', { type: 'text' }))),
      field('Dígitos', bindNum('leading_zeros', numberInput(3, { min: 1, max: 8 }), { integer: true })),
      field('Desde', bindNum('start_index', numberInput(1, { min: 0 }), { integer: true })),
    ),
    field('Numeración de etiquetas', numberingSel),
    dedupCheck.label, dedupStatus,

    el('h3', {}, 'Hoja y cuadrícula'),
    el('div', { class: 'row' },
      field('Papel', paperSel),
      field('Orientación', bindSel('orientation', select(ORIENTATIONS, s.orientation))),
    ),
    customRow,
    el('div', { class: 'row' },
      field('Columnas', bindNum('cols', numberInput(4, { min: 1, max: 20 }), { integer: true })),
      field('Filas', bindNum('rows', numberInput(5, { min: 1, max: 20 }), { integer: true })),
      field('DPI', bindNum('dpi', numberInput(300, { min: 72, max: 1200 }), { integer: true })),
    ),
    el('div', { class: 'row' },
      field('Margen (mm)', bindNum('margin_mm', numberInput(10, { min: 0 }))),
      field('Espaciado (mm)', bindNum('gutter_mm', numberInput(5, { min: 0 }))),
      field('Fuente (pt)', bindNum('font_size_pt', numberInput(9, { min: 4 }))),
    ),

    el('h3', {}, 'Numerador de hoja'),
    el('div', { class: 'row' },
      field('Posición', bindSel('page_num_corner', select(CORNERS, s.page_num_corner))),
      field('Prefijo', bindText('page_num_prefix', el('input', { type: 'text' }))),
      field('Desde', bindNum('page_num_start', numberInput(1, { min: 0 }), { integer: true })),
    ),
    field('Numeración de hojas', pageNumberingSel),

    el('h3', {}, 'Registro (para escanear de vuelta)'),
    bindCheck('registration_on', check('Marcadores ArUco + QR por fotograma (imprescindible para la fase ②)', s.registration_on)),
    el('div', { class: 'row' },
      field('Marcadores', bindSel('marker_count', select([['4', '4 (esquinas)'], ['8', '8 (recomendado)'], ['12', '12 (máxima tolerancia)']], String(s.marker_count)))),
      field('Tamaño (mm)', bindNum('marker_size_mm', numberInput(8, { min: 4, step: 0.5 }))),
      field('Margen (mm)', bindNum('marker_margin_mm', numberInput(4, { min: 1, step: 0.5 }))),
    ),
    el('div', { class: 'row' },
      field('QR (mm)', bindNum('qr_size_mm', numberInput(10, { min: 6, step: 0.5 }))),
      field('Proyecto (va en los QR)', bindText('project_name', el('input', { type: 'text', placeholder: '= nombre de salida' }))),
    ),
    bindCheck('gray_patch_on', check('Tira de parches de grises (normalizar escáner)', s.gray_patch_on)),

    cyanBox,

    el('h3', {}, 'Impresora'),
    field('Perfil de impresora (fase ③)', printerSel, 'Compensa la escala real medida de tu impresora.'),

    el('h3', {}, 'Salida'),
    el('div', { class: 'row' },
      field('Nombre de salida', bindText('out_name', el('input', { type: 'text' }))),
      field('Hojas a generar', (() => {
        const i = el('input', { type: 'text', placeholder: 'ej. 3, 5-7 (vacío = todas)' });
        i.value = ph1.sheets_include;
        i.addEventListener('change', () => { ph1.sheets_include = i.value; });
        return i;
      })()),
    ),
    (() => { const c = check('Guardar copia de los fotogramas originales (hojas de rescate)', ph1.keepOriginals); c.input.addEventListener('change', () => { ph1.keepOriginals = c.input.checked; }); return c.label; })(),
    (() => { const c = check('Exportar también los fotogramas sueltos', ph1.exportFrames); c.input.addEventListener('change', () => { ph1.exportFrames = c.input.checked; }); return c.label; })(),
    genBtn, genProg.root,
    warnBox,

    el('h3', {}, 'Presets'),
    presetsRow,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Vista previa'),
    el('div', { class: 'preview-holder' },
      el('span', { class: 'preview-corner c1' }), el('span', { class: 'preview-corner c2' }),
      el('span', { class: 'preview-corner c3' }), el('span', { class: 'preview-corner c4' }),
      previewImg,
    ),
    el('div', { class: 'pagenav' }, prevBtn, pageLabel, nextBtn),
    el('div', { style: `display:${String(s.mode).startsWith('cian') ? '' : 'none'}` }, simulateToggle.label),
    previewInfo,
    framesInfo,
    thumbsGrid,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));

  // corrige el tipo de marker_count (select da string)
  const mcSel = paper.querySelectorAll('select');
  ph1._refreshPreview = refreshPreview;
  ph1._afterFramesChanged = afterFramesChanged;
}
