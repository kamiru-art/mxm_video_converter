// Fase ② — Procesar escaneos: de la hoja pintada/expuesta a fotogramas.

import { run, recycleIdle, poolSize } from './pool.js';
import { el, toast, download, progressBar, dropzone, field, numberInput, select, check,
         sanitizeLabel, pngUrl, lightbox } from './ui.js';
import { project } from './project.js';
import { generateSheets, resolveCyanCurve } from './gen.js';
import { makeZip } from './zip.js';
import { getGpuDevice, gpuWarpPerspective } from './webgpu.js';

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
        layoutInfo.textContent = `✔ ${f.name}: ${layoutSummary(ph2.layout)}`;
      } catch (e) {
        toast(`Could not read the layout: ${e.message}`, 'err');
      }
    },
  });

  // opciones
  const bleedIn = numberInput(1.5, { min: 0, max: 20, step: 0.5 });
  const minMarkersIn = numberInput(3, { min: 2, max: 12 });
  const modeSel = select([['auto', 'Automatic (from the layout)'], ['normal', 'Normal'], ['cianotipia', 'Cyanotype']], 'auto');
  // los navegadores informan la RAM a medias (Chrome la limita a 8 GB;
  // Safari/Firefox no la informan): el usuario puede declararla
  const ramIn = numberInput(localStorage.getItem('mxm_ram_gb') ?? '', { min: 1, max: 2048 });
  ramIn.placeholder = navigator.deviceMemory ? `detected: ${navigator.deviceMemory}+` : 'not detected';
  ramIn.addEventListener('change', () => {
    const v = parseFloat(ramIn.value);
    if (Number.isFinite(v) && v > 0) localStorage.setItem('mxm_ram_gb', String(v));
    else { ramIn.value = ''; localStorage.removeItem('mxm_ram_gb'); }
  });
  function machineRam() {
    const manual = parseFloat(ramIn.value);
    if (Number.isFinite(manual) && manual > 0) return { gb: manual, manual: true };
    return { gb: navigator.deviceMemory || 4, manual: false };
  }
  const resizeCheck = check('Resize each frame to its original digital size', false);
  const patchesCheck = check('Normalize levels with the gray strip (if the sheet has one)', false);
  const fineCheck = check('Local correction for warped paper (recommended for cyanotype)', true);

  // procesamiento
  const prog = progressBar();
  prog.hide();
  const specsInfo = el('div', { class: 'hint' });
  const resultsBox = el('div');
  const framesState = el('div');

  // los archivos cargados se retienen para poder reprocesarlos con otras
  // opciones sin volver a soltarlos
  const loadedScans = new Map(); // nombre → File
  const reprocessBtn = el('button', { class: 'btn ghost small', style: 'display:none; margin-top:6px' });
  function refreshReprocess() {
    reprocessBtn.style.display = loadedScans.size ? '' : 'none';
    reprocessBtn.textContent = `Reprocess the ${loadedScans.size} loaded scan(s) with the current options`;
  }
  reprocessBtn.addEventListener('click', () => {
    if (!loadedScans.size) return;
    clearReport(); // borra resultados, claims y frames de la pasada anterior
    processScans([...loadedScans.values()]);
  });

  const scansDz = dropzone({
    label: 'Drop your scans here (any order, any orientation)',
    sublabel: 'TIFF / PNG / JPG / WebP, 8 or 16 bit, any resolution. Several at once.',
    accept: '.tif,.tiff,.png,.jpg,.jpeg,.webp,.bmp,image/*',
    multiple: true,
    onFiles: (files) => {
      for (const f of files) loadedScans.set(f.name, f);
      refreshReprocess();
      processScans(files);
    },
  });

  /** Profundidad de bits de un PNG (byte 24 del IHDR). */
  async function pngBitDepth(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 26).arrayBuffer());
      return head[24] ?? 8;
    } catch { return 8; }
  }

  /** ImageBitmap si el navegador puede decodificar SIN perder profundidad. */
  async function decodeForGpu(f) {
    const name = f.name.toLowerCase();
    if (/\.(tif|tiff)$/.test(name)) return null;              // decodifica WASM
    if (/\.png$/.test(name) && (await pngBitDepth(f)) > 8) return null; // 16 bits
    try { return await createImageBitmap(f); } catch { return null; }
  }

  /** Camino acelerado: detectar en WASM → enderezar en la GPU → recortar en
   *  WASM. La memoria WASM nunca ve entrada y salida a la vez. */
  async function processViaGpu(f, bmp, layoutStr, opts) {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const rgba = new Uint8Array(d.data.buffer);
    const det = JSON.parse(await run('scan_detect', {
      rgba, w: bmp.width, h: bmp.height, name: f.name, layout: layoutStr, opts,
    }, [rgba.buffer]));
    if (!det.ok) {
      return { result: JSON.stringify(det.res), frames: [], sin_identificar: [], overlay: null };
    }
    const warped = await gpuWarpPerspective(bmp, det.m, det.flipped, det.out_w, det.out_h);
    if (!warped) return null; // la GPU no pudo con este tamaño: camino WASM
    const state = JSON.stringify({ res: det.res, s: det.s, refined_ids: det.refined_ids, local: det.local });
    return run('scan_finish', {
      rgba: warped, w: det.out_w, h: det.out_h, name: f.name,
      layout: layoutStr, opts, claims: JSON.stringify(ph2.claims), state,
    }, [warped.buffer]);
  }

  /** Pico de memoria estimado de un escaneo, a partir del tamaño del archivo.
   *  Con GPU la memoria WASM nunca ve entrada y salida a la vez. */
  function estimatePeakBytes(f, gpu) {
    const name = f.name.toLowerCase();
    const ratio = /\.(jpe?g|webp)$/.test(name) ? 12 : /\.(tif|tiff)$/.test(name) ? 2.5 : 5;
    return f.size * ratio * (gpu ? 2.2 : 3.5);
  }

  /** Cuántos escaneos procesar a la vez, según la RAM y la GPU del equipo.
   *  La RAM declarada por el usuario manda; si no, navigator.deviceMemory. */
  function pickConcurrency(files, gpu, singleSheet) {
    if (singleSheet) return 1; // una sola hoja: evitar carreras de identidad
    const ram = machineRam();
    const budget = ram.gb * 1e9 * 0.3;
    const worst = Math.max(1, ...files.map((f) => estimatePeakBytes(f, gpu)));
    const byRam = Math.max(1, Math.floor(budget / worst));
    // el tope conservador de 3 solo aplica cuando la RAM es una suposición
    return Math.min(byRam, poolSize(), files.length, ram.manual ? poolSize() : 3);
  }

  let processing = false;
  async function processScans(files) {
    if (!ph2.layout) { toast('Load the project layout.json first.', 'err'); return; }
    if (processing) { toast('Wait for the current batch to finish.', 'err'); return; }
    processing = true;
    reprocessBtn.disabled = true;
    prog.show();
    try {
    // Number.isFinite y no ||: el 0 es un valor válido de bleed
    const bleedVal = parseFloat(bleedIn.value);
    const minMarkersVal = parseInt(minMarkersIn.value, 10);
    const opts = JSON.stringify({
      bleed: (Number.isFinite(bleedVal) ? bleedVal : 1.5) / 100,
      min_markers: Number.isFinite(minMarkersVal) ? minMarkersVal : 3,
      mode: modeSel.value,
      resize_to_original: resizeCheck.input.checked,
      normalize_patches: patchesCheck.input.checked,
      fine_align: fineCheck.input.checked,
    });
    const layoutStr = JSON.stringify(ph2.layout);
    const gpu = await getGpuDevice();
    const singleSheet = (ph2.layout.hojas ?? []).length === 1;
    const width = pickConcurrency(files, !!gpu, singleSheet);
    const ram = machineRam();
    const ramTxt = ram.manual ? `${ram.gb} GB RAM (set by you)`
      : navigator.deviceMemory ? `${navigator.deviceMemory}+ GB RAM (browser estimate)`
      : 'RAM not reported (assuming 4 GB; set yours in Options)';
    specsInfo.textContent = `This machine: ${navigator.hardwareConcurrency || '?'} cores, ${ramTxt}, GPU straightening ${gpu ? 'on' : 'off'}. Processing ${width} scan${width > 1 ? 's' : ''} at a time to stay inside memory.`;
    let done = 0;

    const processOne = async (f) => {
      let r = null;
      if (gpu) {
        let bmp = null;
        try {
          bmp = await decodeForGpu(f);
          // cualquier fallo del camino GPU (canvas demasiado grande, memoria
          // de GPU, etc.) cae al camino todo-en-WASM en vez de perder el escaneo
          if (bmp) r = await processViaGpu(f, bmp, layoutStr, opts);
        } catch (e) {
          console.warn('[scan] GPU path failed, falling back to WASM:', e);
          r = null;
        } finally {
          bmp?.close?.();
        }
      }
      if (!r) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        r = await run('scan_process', {
          bytes, name: f.name, layout: layoutStr, opts,
          claims: JSON.stringify(ph2.claims),
        }, [bytes.buffer]);
      }
      const result = JSON.parse(r.result);
      const via = String(result.via ?? '');
      if (result.hoja_numero != null && (via.startsWith('QR') || via.startsWith('marker'))) {
        ph2.claims[result.hoja_numero] = f.name;
      }
      const asBlob = (u8, type) => new Blob([u8], { type });
      const frames = (r.frames ?? []).map((fr) => ({ label: fr.label, png: asBlob(fr.png, 'image/png') }));
      const sinIdentificar = (r.sin_identificar ?? []).map((fr) => ({ label: fr.label, png: asBlob(fr.png, 'image/png') }));
      for (const fr of frames) project.processedFrames.set(fr.label, fr.png);
      addResult({
        result, frames, sinIdentificar,
        overlay: r.overlay ? asBlob(r.overlay, 'image/jpeg') : null,
      });
    };

    const queue = [...files];
    await Promise.all(Array.from({ length: width }, async () => {
      while (queue.length) {
        const f = queue.shift();
        try { await processOne(f); } catch (e) { toast(`Error in one scan: ${e.message}`, 'err'); }
        done++;
        prog.set(done / files.length, `${done}/${files.length} scans`);
      }
    }));
    recycleIdle(); // liberar la memoria WASM que infló el lote
    renderSummary();
    toast('Processing finished. Check the report.', 'ok');
    } finally {
      prog.hide();
      processing = false;
      reprocessBtn.disabled = false;
      refreshReprocess();
    }
  }

  // La tabla del informe se construye INCREMENTALMENTE: cada resultado crea
  // sus filas (y sus URLs de miniaturas) UNA sola vez. Reconstruir todo el
  // informe tras cada escaneo redecodificaba todas las miniaturas anteriores
  // y filtraba URLs sin liberar: por eso el final del lote se arrastraba.
  const reportHeader = el('tr', {}, ...['', 'Scan', 'Sheet', 'Markers', 'Alignment', 'Frames', 'Notes'].map((h) => el('th', {}, h)));
  const reportTable = el('table', { class: 'report' }, reportHeader);
  const missingSlot = el('div');
  const reportUrls = []; // object URLs de las miniaturas, para revocarlas al limpiar

  function trackUrl(u) {
    reportUrls.push(u);
    return u;
  }

  function buildResultRows({ result: r, frames, sinIdentificar, overlay }) {
    // miniaturas pequeñas; un clic abre la imagen a tamaño completo
    const thumbs = el('div', { class: 'thumbs report-thumbs' });
    if (overlay) {
      const t = el('div', { class: 'thumb clickable', title: 'View the alignment overlay' },
        el('img', { src: trackUrl(URL.createObjectURL(overlay)), alt: 'alignment' }),
        el('div', { class: 'tag' }, 'alignment'));
      t.addEventListener('click', () => lightbox(overlay, `${r.scan}: green = marker found, red = missing, blue = frames, orange = QRs`));
      thumbs.append(t);
    }
    for (const f of [...frames, ...sinIdentificar].slice(0, 60)) {
      const t = el('div', { class: 'thumb clickable', title: 'View at full size' },
        el('img', { src: trackUrl(pngUrl(f.png)) }), el('div', { class: 'tag' }, f.label));
      t.addEventListener('click', () => lightbox(f.png, f.label));
      thumbs.append(t);
    }
    return [el('tr', {},
      el('td', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✔' : '✘'),
      el('td', { class: 'mono' }, r.scan),
      el('td', {}, r.hoja_numero ?? '—'),
      el('td', { class: 'mono' }, `${r.marcadores}/${r.marcadores_total}`),
      el('td', { class: 'mono' }, `${r.residual_mm ? `±${r.residual_mm} mm` : '—'}${r.espejado ? ' · mirrored' : ''}`),
      el('td', {}, String(frames?.length ?? 0)),
      el('td', {}, [
        ...(r.advertencias ?? []).map((a) => el('div', { class: 'hint', style: 'color:#D8B04C' }, a)),
        r.error ? el('div', { style: 'color:#E98C77' }, r.error) : null,
      ]),
    ), el('tr', {}, el('td', {}), el('td', { colspan: '6' }, thumbs))];
  }

  function addResult(entry) {
    ph2.results.push(entry);
    reportTable.append(...buildResultRows(entry));
    renderSummary();
  }

  function clearReport() {
    ph2.results = [];
    ph2.claims = {};
    project.processedFrames.clear();
    reportTable.replaceChildren(reportHeader);
    for (const u of reportUrls) URL.revokeObjectURL(u); // soltar los Blobs
    reportUrls.length = 0;
    renderSummary();
  }

  function renderSummary() {
    const any = ph2.results.length > 0;
    reportTable.style.display = any ? '' : 'none';
    downloadRow.style.display = any ? '' : 'none';
    missingSlot.replaceChildren();
    if (ph2.layout && any) {
      const expected = expectedLabels(ph2.layout);
      const missing = [...expected.keys()].filter((et) => !project.processedFrames.has(et)).sort();
      missingSlot.append(missing.length
        ? el('div', { class: 'missing-box' },
            el('strong', {}, `Missing frames (${missing.length}): `),
            missing.join(', '),
            el('div', { style: 'margin-top:6px' }, 'Use “Rescue sheets” below to reprint only these.'))
        : el('div', { class: 'allok-box' }, el('strong', {}, 'No frames missing.')));
      rescueSection.style.display = missing.length ? '' : 'none';
      rescueMissing = missing;
    }
    framesState.textContent = project.processedFrames.size
      ? `${project.processedFrames.size} recovered frames in memory (ready for the Video phase).`
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
    }, 'Download frames + report (ZIP)'),
    el('button', {
      class: 'btn ghost-light small', onclick: clearReport,
    }, 'Clear results'),
  );
  resultsBox.append(missingSlot, reportTable, downloadRow);
  renderSummary();

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
  } }, 'Generate rescue sheets');

  const rescueSection = el('div', { style: 'display:none; margin-top:16px' },
    el('h2', {}, 'Rescue sheets'),
    rescueDz, rescueInfo, rescueBtn, rescueProg.root,
  );

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '② Process scans'),
    el('div', { class: 'hint' }, 'The app straightens each sheet with the markers, identifies it by its marker IDs (or its QRs, on older projects) and crops every frame. No Photoshop.'),
    layoutDz, useCurrentBtn, layoutInfo,
    el('h3', {}, 'Options'),
    // campos apilados: con hints de largos distintos, en fila quedaban
    // desalineados en altura
    field('Bleed (% per side)', bleedIn, 'Perimeter crop to avoid paper edges.'),
    field('Minimum markers', minMarkersIn),
    field('Detection mode', modeSel),
    field('Machine RAM (GB)', ramIn, 'Browsers cap what they report at 8 GB. Your real value lets more scans run in parallel.'),
    resizeCheck.label, patchesCheck.label, fineCheck.label,
    el('h3', {}, 'Scans'),
    scansDz,
    reprocessBtn,
    specsInfo,
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
