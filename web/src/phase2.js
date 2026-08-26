// Fase ② — Procesar escaneos: de la hoja pintada/expuesta a fotogramas.

import { run, poolSize } from './pool.js';
import { el, toast, download, progressBar, dropzone, field, numberInput, select, check,
         sanitizeLabel, pngUrl } from './ui.js';
import { project } from './project.js';
import { generateSheets, resolveCyanCurve } from './gen.js';
import { makeZip } from './zip.js';

export const ph2 = {
  layout: null,        // objeto layout.json (v1 o v2; el núcleo normaliza)
  layoutName: '',
  results: [],         // resultados por escaneo
  claims: {},          // nº hoja → nombre de escaneo (identificadas por QR)
};

function layoutSummary(layout) {
  const hojas = layout.hojas ?? [];
  let frames = 0;
  for (const h of hojas) frames += Object.keys(h.frames ?? {}).length;
  return `${layout.proyecto ? `“${layout.proyecto}” · ` : ''}mode ${layout.modo ?? 'normal'} · ${hojas.length} sheet(s) · ${frames} expected frames`;
}

function expectedLabels(layout) {
  const out = new Map(); // etiqueta → nº hoja
  for (const h of layout.hojas ?? []) {
    for (const et of Object.keys(h.frames ?? {})) out.set(et, h.numero);
  }
  return out;
}

export function mountPhase2(root) {
  const layoutInfo = el('div', { class: 'hint' }, 'Load the layout.json produced by phase ① (or by the desktop app, v1/v2).');

  const useCurrentBtn = el('button', { class: 'btn ghost small', style: 'margin-top:6px' }, 'Use the current project layout');
  useCurrentBtn.addEventListener('click', () => {
    if (!project.layoutJson) { toast('You have not generated sheets in this session yet.', 'err'); return; }
    ph2.layout = JSON.parse(project.layoutJson);
    ph2.layoutName = 'current project layout';
    layoutInfo.textContent = `✔ ${layoutSummary(ph2.layout)}`;
  });

  const layoutDz = dropzone({
    label: 'Drop the layout.json here',
    accept: '.json,application/json',
    onFiles: async ([f]) => {
      try {
        ph2.layout = JSON.parse(await f.text());
        ph2.layoutName = f.name;
        layoutInfo.textContent = `✔ ${f.name} — ${layoutSummary(ph2.layout)}`;
      } catch (e) {
        toast(`Could not read the layout: ${e.message}`, 'err');
      }
    },
  });

  // opciones
  const bleedIn = numberInput(1.5, { min: 0, max: 20, step: 0.5 });
  const minMarkersIn = numberInput(3, { min: 2, max: 12 });
  const modeSel = select([['auto', 'Automatic (from the layout)'], ['normal', 'Normal'], ['cianotipia', 'Cyanotype']], 'auto');
  const resizeCheck = check('Resize each frame to its original digital size', false);
  const patchesCheck = check('Normalize levels with the gray strip (if the sheet has one)', false);
  const fineCheck = check('Local correction for warped paper (recommended for cyanotype)', true);

  // procesamiento
  const prog = progressBar();
  prog.hide();
  const resultsBox = el('div');
  const framesState = el('div');

  const scansDz = dropzone({
    label: 'Drop your scans here (any order, any orientation)',
    sublabel: 'TIFF / PNG / JPG / WebP — 8 or 16 bit, any resolution. Several at once.',
    accept: '.tif,.tiff,.png,.jpg,.jpeg,.webp,.bmp,image/*',
    multiple: true,
    onFiles: (files) => processScans(files),
  });

  async function processScans(files) {
    if (!ph2.layout) { toast('Load the project layout.json first.', 'err'); return; }
    prog.show();
    const opts = JSON.stringify({
      bleed: (parseFloat(bleedIn.value) || 1.5) / 100,
      min_markers: parseInt(minMarkersIn.value, 10) || 3,
      mode: modeSel.value,
      resize_to_original: resizeCheck.input.checked,
      normalize_patches: patchesCheck.input.checked,
      fine_align: fineCheck.input.checked,
    });
    const layoutStr = JSON.stringify(ph2.layout);
    const singleSheet = (ph2.layout.hojas ?? []).length === 1;
    let done = 0;
    const jobs = files.map((f) => async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await run('scan_process', {
        bytes, name: f.name, layout: layoutStr, opts,
        claims: JSON.stringify(ph2.claims),
      }, [bytes.buffer]);
      const result = JSON.parse(r.result);
      if (result.hoja_numero != null && String(result.via ?? '').startsWith('QR')) {
        ph2.claims[result.hoja_numero] = f.name;
      }
      for (const fr of r.frames) project.processedFrames.set(fr.label, fr.png);
      ph2.results.push({ result, frames: r.frames, sinIdentificar: r.sin_identificar, overlay: r.overlay });
      done++;
      prog.set(done / files.length, `${done}/${files.length} scans`);
      renderResults();
    });
    // en paralelo (varios workers WASM), salvo layouts de una sola hoja
    const width = singleSheet ? 1 : Math.min(poolSize(), 3);
    const queue = [...jobs];
    await Promise.all(Array.from({ length: width }, async () => {
      while (queue.length) {
        const job = queue.shift();
        try { await job(); } catch (e) { toast(`Error in one scan: ${e.message}`, 'err'); done++; }
      }
    }));
    prog.hide();
    renderResults();
    toast('Processing finished. Check the report.', 'ok');
  }

  function renderResults() {
    const rows = [];
    for (const { result: r, frames, sinIdentificar, overlay } of ph2.results) {
      const thumbs = el('div', { class: 'thumbs' });
      if (overlay) {
        thumbs.append(el('div', { class: 'thumb', style: 'grid-column: span 3; aspect-ratio:auto' },
          el('img', { src: URL.createObjectURL(new Blob([overlay], { type: 'image/jpeg' })), alt: 'alignment' }),
          el('div', { class: 'tag' }, 'alignment: green=marker, red=missing, blue=frames, orange=QRs')));
      }
      for (const f of [...frames, ...sinIdentificar].slice(0, 24)) {
        thumbs.append(el('div', { class: 'thumb' },
          el('img', { src: pngUrl(f.png) }), el('div', { class: 'tag' }, f.label)));
      }
      rows.push(el('tr', {},
        el('td', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✔' : '✘'),
        el('td', { class: 'mono' }, r.scan),
        el('td', {}, r.hoja_numero ?? '—'),
        el('td', { class: 'mono' }, `${r.marcadores}/${r.marcadores_total}`),
        el('td', { class: 'mono' }, `${r.residual_mm ? `±${r.residual_mm} mm` : '—'}${r.espejado ? ' · 🪞' : ''}`),
        el('td', {}, String(r.frames ? Object.keys(r.frames).length : (frames?.length ?? 0))),
        el('td', {}, [
          ...(r.advertencias ?? []).map((a) => el('div', { class: 'hint', style: 'color:#D8B04C' }, a)),
          r.error ? el('div', { style: 'color:#E98C77' }, r.error) : null,
        ]),
      ), el('tr', {}, el('td', {}), el('td', { colspan: '6' }, thumbs)));
    }
    const table = el('table', { class: 'report' },
      el('tr', {}, ...['', 'Scan', 'Sheet', 'Markers', 'Alignment', 'Frames', 'Notes'].map((h) => el('th', {}, h))),
      rows);

    // faltantes
    let missingBox = null;
    if (ph2.layout) {
      const expected = expectedLabels(ph2.layout);
      const missing = [...expected.keys()].filter((et) => !project.processedFrames.has(et)).sort();
      if (ph2.results.length) {
        missingBox = missing.length
          ? el('div', { class: 'missing-box' },
              el('strong', {}, `Missing frames (${missing.length}): `),
              missing.join(', '),
              el('div', { style: 'margin-top:6px' }, 'Use “Rescue sheets” below to reprint only these.'))
          : el('div', { class: 'allok-box' }, el('strong', {}, '🎉 No frames missing.'));
        rescueSection.style.display = missing.length ? '' : 'none';
        rescueMissing = missing;
      }
    }
    resultsBox.replaceChildren(
      missingBox ?? '',
      table,
      ph2.results.length ? downloadRow : '',
    );
    framesState.textContent = project.processedFrames.size
      ? `${project.processedFrames.size} recovered frames in memory (ready for phase ④).`
      : '';
  }

  // descarga de resultados
  const downloadRow = el('div', { style: 'margin-top:12px; display:flex; gap:10px; flex-wrap:wrap' },
    el('button', {
      class: 'btn sun', onclick: async () => {
        const files = new Map();
        for (const [label, png] of project.processedFrames) {
          files.set(`frames/${sanitizeLabel(label)}.png`, png);
        }
        for (const { result, sinIdentificar } of ph2.results) {
          for (const f of sinIdentificar ?? []) files.set(`sin_identificar/${sanitizeLabel(f.label)}.png`, f.png);
        }
        const informe = buildInforme();
        files.set('informe.json', new TextEncoder().encode(JSON.stringify(informe, null, 2)));
        files.set('informe.csv', new TextEncoder().encode(informeCsv()));
        const zip = await makeZip(files);
        download(zip, 'processed_frames.zip', 'application/zip');
      },
    }, '⬇ Download frames + report (ZIP)'),
    el('button', {
      class: 'btn ghost-light small', onclick: () => { ph2.results = []; ph2.claims = {}; project.processedFrames.clear(); renderResults(); },
    }, 'Clear results'),
  );

  function buildInforme() {
    const expected = ph2.layout ? expectedLabels(ph2.layout) : new Map();
    const extraidas = [...project.processedFrames.keys()];
    return {
      fecha: new Date().toISOString(),
      modo: ph2.layout?.modo ?? 'normal',
      escaneos_procesados: ph2.results.length,
      escaneos_ok: ph2.results.filter((r) => r.result.ok).length,
      frames_extraidos: extraidas.length,
      frames_esperados: expected.size,
      etiquetas_faltantes: [...expected.keys()].filter((et) => !project.processedFrames.has(et)).sort(),
      resultados: ph2.results.map((r) => r.result),
    };
  }

  function informeCsv() {
    const lines = ['escaneo,ok,hoja,marcadores,estrategia,escala,frames,error,espejado,residual_mm'];
    for (const { result: r, frames } of ph2.results) {
      const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
      lines.push([esc(r.scan), r.ok, r.hoja_numero ?? '', `${r.marcadores}/${r.marcadores_total}`,
        esc(r.estrategia), r.escala, frames.length, esc(r.error), r.espejado, r.residual_mm].join(','));
    }
    return lines.join('\n');
  }

  // ── hojas de rescate ─────────────────────────────────────────
  let rescueMissing = [];
  const rescueOriginals = new Map(); // nombre → File
  const rescueInfo = el('div', { class: 'hint' });
  const rescueDz = dropzone({
    label: 'Drop the project originals folder (…_originales/)',
    sublabel: 'The copies phase ① saved next to the layout. They let you reprint ONLY the failed frames.',
    accept: 'image/*,.tif,.tiff', multiple: true, dark: true,
    onFiles: (files) => {
      for (const f of files) rescueOriginals.set(f.name.replace(/\.[^.]+$/, ''), f);
      rescueInfo.textContent = `${rescueOriginals.size} originals loaded.`;
    },
  });
  const rescueProg = progressBar();
  rescueProg.hide();
  const rescueBtn = el('button', { class: 'btn blue', onclick: async () => {
    if (!ph2.layout?.ajustes) {
      toast('This layout has no generation settings (is it from v1?). Generate the sheets with MXM Studio to use rescue.', 'err');
      return;
    }
    const found = [];
    const sinOriginal = [];
    for (const et of rescueMissing) {
      const safe = sanitizeLabel(et);
      let file = rescueOriginals.get(safe) ?? rescueOriginals.get(et);
      // también: buscar por archivo_original del layout
      if (!file) {
        outer: for (const h of ph2.layout.hojas ?? []) {
          for (const [key, info] of Object.entries(h.frames ?? {})) {
            if ((info.etiqueta ?? key) === et && info.archivo_original) {
              const base = info.archivo_original.split('/').pop().replace(/\.[^.]+$/, '');
              file = rescueOriginals.get(base);
              if (file) break outer;
            }
          }
        }
      }
      if (file) found.push({ label: et, file });
      else sinOriginal.push(et);
    }
    if (sinOriginal.length) {
      toast(`No original copy (cannot be reprinted): ${sinOriginal.join(', ')}`, 'err');
    }
    if (!found.length) { toast('No original copy found for any missing frame.', 'err'); return; }
    rescueBtn.disabled = true;
    rescueProg.show();
    try {
      const ajustes = { ...ph2.layout.ajustes };
      let baseName = ajustes.out_name || 'hojas';
      baseName = baseName.replace(/_rescate$/, '');
      ajustes.out_name = `${baseName}_rescate`;
      ajustes.registration_on = true;
      ajustes.sheets_include = '';
      ajustes.sheets_exclude = '';
      ajustes.page_num_start = 1;
      ajustes.page_num_prefix = (ajustes.page_num_prefix || '') + 'R';
      const frames = [];
      for (const { label, file } of found) {
        const isTiff = /\.(tif|tiff)$/i.test(file.name);
        let getImageData;
        let w = 16, h = 9, hasAlpha = false;
        if (isTiff) {
          const bytesP = file.arrayBuffer().then((b) => new Uint8Array(b));
          const decoded = await run('decode_image', { bytes: await bytesP });
          w = decoded.w; h = decoded.h; hasAlpha = decoded.had_alpha;
          getImageData = async () => ({ data: decoded.rgba, w: decoded.w, h: decoded.h });
        } else {
          const bmp = await createImageBitmap(file);
          w = bmp.width; h = bmp.height;
          hasAlpha = /\.(png|webp)$/i.test(file.name);
          bmp.close();
          getImageData = async () => {
            const b = await createImageBitmap(file);
            const c = new OffscreenCanvas(b.width, b.height);
            c.getContext('2d').drawImage(b, 0, 0);
            b.close();
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
            return { data: new Uint8Array(d.data.buffer), w: c.width, h: c.height };
          };
        }
        frames.push({ name: file.name, blob: file, w, h, hasAlpha, getImageData });
      }
      const settings = await resolveCyanCurve(ajustes, []);
      const out = await generateSheets({
        settings, frames, labels: found.map((f) => f.label),
        timeline: [], videoMeta: ph2.layout.video ?? {},
        keepOriginals: true,
        onProgress: (d, t, note) => rescueProg.set(d / t, note),
      });
      const zip = await makeZip(out.files);
      download(zip, `${ajustes.out_name}.zip`, 'application/zip');
      toast(`Rescue sheets generated with ${found.length} frame(s). Print, paint/expose, scan and process against the rescue layout.`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Rescue failed: ${e.message ?? e}`, 'err');
    } finally {
      rescueBtn.disabled = false;
      rescueProg.hide();
    }
  } }, '🛟 Generate rescue sheets');

  const rescueSection = el('div', { style: 'display:none; margin-top:16px' },
    el('h2', {}, 'Rescue sheets'),
    rescueDz, rescueInfo, rescueBtn, rescueProg.root,
  );

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '② Process scans'),
    el('div', { class: 'hint' }, 'The app straightens each sheet with the markers, identifies it by its QRs and crops every frame. No Photoshop.'),
    layoutDz, useCurrentBtn, layoutInfo,
    el('h3', {}, 'Options'),
    el('div', { class: 'row' },
      field('Bleed (% per side)', bleedIn, 'Perimeter crop to avoid paper edges.'),
      field('Minimum markers', minMarkersIn),
      field('Detection mode', modeSel),
    ),
    resizeCheck.label, patchesCheck.label, fineCheck.label,
    el('h3', {}, 'Scans'),
    scansDz,
    prog.root,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Processing report'),
    framesState,
    resultsBox,
    rescueSection,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
}
