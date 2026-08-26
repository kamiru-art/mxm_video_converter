// Motor de generación de hojas: comparte la fase ① y las hojas de rescate.
// Orquesta al núcleo WASM página a página para no cargar todos los
// fotogramas a resolución completa a la vez.

import { run, run0 } from './pool.js';
import { sanitizeLabel, selectIndices } from './ui.js';

const NUM_FIELDS = [
  'dpi', 'custom_w_mm', 'custom_h_mm', 'margin_mm', 'gutter_mm', 'alpha_border_mm',
  'cols', 'rows', 'leading_zeros', 'start_index', 'font_size_pt', 'label_gap_mm',
  'page_num_start', 'page_num_zeros', 'page_num_size_pt', 'marker_count',
  'marker_size_mm', 'marker_margin_mm', 'qr_size_mm', 'cyan_curve_strength',
  'cyan_adaptive', 'cyan_clarity', 'cyan_halo_mm', 'cyan_frame_border_mm',
  'print_scale_x', 'print_scale_y',
];
const INT_FIELDS = new Set(['dpi', 'cols', 'rows', 'leading_zeros', 'start_index',
  'page_num_start', 'page_num_zeros', 'marker_count']);

/** Serializa los ajustes para el núcleo (misma forma que el snapshot),
 *  coercionando números que la interfaz pudo dejar como strings. */
export function settingsForCore(s) {
  const out = { ...s };
  for (const k of NUM_FIELDS) {
    if (out[k] !== undefined && out[k] !== null) {
      const v = Number(out[k]);
      out[k] = INT_FIELDS.has(k) ? Math.round(v) : v;
    }
  }
  return JSON.stringify(out);
}

function zfill(n, digits) {
  let out = String(n);
  while (out.length < digits) out = '0' + out;
  return out;
}

/**
 * Resuelve la curva efectiva de cianotipia UNA vez por generación (fuerza +
 * adaptación al contenido) y devuelve ajustes listos con la curva cocinada.
 */
export async function resolveCyanCurve(settings, thumbFrames) {
  const s = { ...settings };
  if (!String(s.mode).startsWith('cian')) return s;
  let hist = 'null';
  if ((s.cyan_adaptive ?? 0) > 0 && thumbFrames?.length) {
    const { meta, pixels } = packThumbs(thumbFrames.slice(0, 200));
    hist = await run('content_histogram', { meta, pixels }, [pixels.buffer]);
  }
  const lut = await run('effective_curve', {
    lut: JSON.stringify(s.cyan_curve ?? null),
    strength: s.cyan_curve_strength ?? 100,
    adapt: s.cyan_adaptive ?? 0,
    hist,
  });
  s.cyan_curve = JSON.parse(lut);
  s.cyan_curve_strength = 100.0;
  s.cyan_adaptive = 0.0;
  return s;
}

/** Empaqueta miniaturas (OffscreenCanvas) como buffer RGBA + meta JSON. */
export function packThumbs(canvases) {
  let total = 0;
  const metas = [];
  const datas = [];
  for (const c of canvases) {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height);
    metas.push({ w: c.width, h: c.height, has_alpha: false, orig_name: '', offset: total });
    datas.push(d.data);
    total += d.data.byteLength;
  }
  const pixels = new Uint8Array(total);
  let off = 0;
  for (const d of datas) {
    pixels.set(d, off);
    off += d.byteLength;
  }
  return { meta: JSON.stringify(metas), pixels };
}

/** Empaqueta ImageData ya decodificados. metaExtra opcional por frame. */
export function packImageData(items) {
  // items: [{data: Uint8ClampedArray|null, w, h, hasAlpha, origName, origFile}]
  let total = 0;
  const metas = [];
  for (const it of items) {
    metas.push({
      w: it.w, h: it.h, has_alpha: !!it.hasAlpha,
      orig_name: it.origName ?? '', orig_file: it.origFile ?? null,
      offset: it.data ? total : -1,
    });
    if (it.data) total += it.data.byteLength;
  }
  const pixels = new Uint8Array(total);
  let off = 0;
  for (const it of items) {
    if (it.data) {
      pixels.set(it.data, off);
      off += it.data.byteLength;
    }
  }
  return { meta: JSON.stringify(metas), pixels };
}

/**
 * Genera todas las hojas.
 * frames: [{ getImageData: async (fullRes) => {data,w,h,hasAlpha}, name, w, h, hasAlpha, blob? }]
 *   — solo los fotogramas A IMPRIMIR (representantes), en orden.
 * labels: etiquetas paralelas.
 * pageNumbers: número de hoja por página (o null = continuo).
 * timeline / videoMeta: para el layout.json.
 * onProgress(done, total, note)
 * Devuelve { files: Map<nombre, Uint8Array|Blob>, layoutJson, avisos, numPages }
 */
export async function generateSheets({
  settings, frames, labels, pageNumbers = null, timeline = [], videoMeta = {},
  keepOriginals = true, exportFrames = false, onProgress = () => {},
}) {
  const s = { ...settings };
  const safeName = sanitizeLabel(s.out_name || 'hojas');
  const perPage = Math.max(1, s.cols * s.rows);
  const numPages = Math.max(1, Math.ceil(frames.length / perPage));
  const firstW = frames[0]?.w ?? 16;
  const firstH = frames[0]?.h ?? 9;

  const files = new Map();
  const originalesDir = s.registration_on && keepOriginals ? `${safeName}_originales` : '';

  // copiar originales (para hojas de rescate)
  if (originalesDir) {
    const usados = new Set();
    for (let i = 0; i < frames.length; i++) {
      let base = sanitizeLabel(labels[i]);
      let cand = base, n = 1;
      while (usados.has(cand)) { n += 1; cand = `${base}_${n}`; }
      usados.add(cand);
      const ext = (frames[i].name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
      const blob = frames[i].blob ?? null;
      if (blob) {
        files.set(`${originalesDir}/${cand}${ext}`, blob);
        frames[i]._origFile = `${originalesDir}/${cand}${ext}`;
      }
    }
  }
  if (exportFrames) {
    const dir = `${safeName}_frames`;
    const usados = new Set();
    for (let i = 0; i < frames.length; i++) {
      let base = sanitizeLabel(labels[i]);
      let cand = base, n = 1;
      while (usados.has(cand)) { n += 1; cand = `${base}_${n}`; }
      usados.add(cand);
      if (frames[i].blob) files.set(`${dir}/${cand}.png`, frames[i].blob);
    }
  }

  // hojas seleccionadas
  const pagesSelected = new Set(selectIndices(numPages, s.sheets_include ?? '', s.sheets_exclude ?? ''));
  const pnumOf = (k) => (pageNumbers && k < pageNumbers.length ? pageNumbers[k] : (s.page_num_start ?? 1) + k);
  const maxPnum = Math.max(1, ...Array.from({ length: numPages }, (_, k) => pnumOf(k)));
  const fileDigits = Math.max(s.page_num_zeros ?? 1, String(maxPnum).length);

  if (s.fmt_pdf) await run0('pdf_new', { dpi: s.dpi });

  const records = [];
  let done = 0;
  const totalSel = Math.max(1, pagesSelected.size);
  const coreSettings = settingsForCore(s);

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const chunk = frames.slice(pageIdx * perPage, (pageIdx + 1) * perPage);
    const chunkLabels = labels.slice(pageIdx * perPage, (pageIdx + 1) * perPage);
    const selected = pagesSelected.has(pageIdx + 1);
    const pnum = pnumOf(pageIdx);
    const pageBase = `${safeName}_p${zfill(pnum, fileDigits)}`;

    const items = [];
    for (const f of chunk) {
      if (selected) {
        const d = await f.getImageData(true);
        items.push({ data: d.data, w: d.w, h: d.h, hasAlpha: f.hasAlpha, origName: f.name, origFile: f._origFile });
      } else {
        items.push({ data: null, w: f.w, h: f.h, hasAlpha: f.hasAlpha, origName: f.name, origFile: f._origFile });
      }
    }
    const { meta, pixels } = packImageData(items);
    const res = await run('render_sheet', {
      settings: coreSettings, firstW, firstH, meta, pixels,
      labels: JSON.stringify(chunkLabels), sheetNum: pnum,
      render: selected, finish: 'final',
    }, [pixels.buffer]);

    const record = JSON.parse(res.record);
    if (record && typeof record === 'object') {
      record.archivo_hoja = `${pageBase}.png`;
      record.generada = selected;
      records.push(record);
    }
    if (selected && res.png) {
      files.set(`${pageBase}.png`, res.png);
      if (s.fmt_pdf) await run0('pdf_add', { png: res.png });
      done++;
      onProgress(done, totalSel, `hoja ${pnum} lista`);
    }
  }

  if (s.fmt_pdf) {
    const pdf = await run0('pdf_finish', {});
    files.set(`${safeName}.pdf`, pdf);
  }

  let layoutJson = null;
  if (s.registration_on && records.length) {
    layoutJson = await run('assemble_layout', {
      settings: coreSettings, firstW, firstH,
      records: JSON.stringify(records),
      timeline: JSON.stringify(timeline),
      video: JSON.stringify(videoMeta),
      originalesDir,
    });
    files.set(`${safeName}_layout.json`, new TextEncoder().encode(layoutJson));
  }

  const layoutInfo = JSON.parse(await run('compute_layout', { settings: coreSettings, firstW, firstH }));
  return { files, layoutJson, avisos: layoutInfo.avisos ?? [], numPages, layoutInfo };
}
