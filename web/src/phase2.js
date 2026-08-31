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
  claims: {},          // nº hoja → nombre de escaneo (ya identificadas)
  assign: {},          // nombre de escaneo → nº de hoja puesto a mano
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

  /** Un layout nuevo es otro proyecto: las hojas que el usuario asignó a mano
   *  se refieren a números del anterior y aquí no significan lo mismo. */
  function setLayout(layout, name, info) {
    ph2.layout = layout;
    ph2.layoutName = name;
    ph2.assign = {};
    layoutInfo.textContent = info;
  }

  const useCurrentBtn = el('button', { class: 'btn ghost small', style: 'margin-top:6px' }, 'Use the current project layout');
  useCurrentBtn.addEventListener('click', () => {
    if (!project.layoutJson) { toast('You have not generated sheets in this session yet.', 'err'); return; }
    const layout = JSON.parse(project.layoutJson);
    setLayout(layout, 'current project layout', `✔ ${layoutSummary(layout)}`);
    renderSummary();
  });

  const layoutDz = dropzone({
    label: 'Drop the layout.json here',
    accept: '.json,application/json',
    onFiles: async ([f]) => {
      try {
        const layout = JSON.parse(await f.text());
        setLayout(layout, f.name, `✔ ${f.name}: ${layoutSummary(layout)}`);
        renderSummary();
      } catch (e) {
        toast(`Could not read the layout: ${e.message}`, 'err');
      }
    },
  });

  // opciones
  const bleedIn = numberInput(1.5, { min: 0, max: 20, step: 0.5 });
  const minMarkersIn = numberInput(3, { min: 2, max: 12 });
  const modeSel = select([['auto', 'Automatic (from the layout)'], ['normal', 'Normal'], ['cyanotype', 'Cyanotype']], 'auto');
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
    clearReport(true); // borra resultados y frames; conserva las hojas puestas a mano
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
      if (processing) {
        // sin esto quedarían retenidos en silencio, sin procesar
        toast('A batch is already running. The new files were added to the loaded list; press Reprocess when it finishes.', 'err');
        return;
      }
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

  /** Opciones de detección comunes a todo el lote. */
  function currentOpts() {
    // Number.isFinite y no ||: el 0 es un valor válido de bleed
    const bleedVal = parseFloat(bleedIn.value);
    const minMarkersVal = parseInt(minMarkersIn.value, 10);
    return {
      bleed: (Number.isFinite(bleedVal) ? bleedVal : 1.5) / 100,
      min_markers: Number.isFinite(minMarkersVal) ? minMarkersVal : 3,
      mode: modeSel.value,
      resize_to_original: resizeCheck.input.checked,
      normalize_patches: patchesCheck.input.checked,
      fine_align: fineCheck.input.checked,
    };
  }

  /** Opciones de UN escaneo: las del lote más la hoja asignada a mano. */
  function optsFor(name, base) {
    const n = ph2.assign[name];
    return JSON.stringify(n == null ? base : { ...base, forced_sheet: n });
  }

  async function makeContext() {
    return { base: currentOpts(), layoutStr: JSON.stringify(ph2.layout), gpu: await getGpuDevice() };
  }

  /** Procesa un escaneo y devuelve su entrada de informe, SIN registrarla:
   *  quien llama decide si se añade al informe o reemplaza a otra. */
  async function runOne(f, ctx) {
    const opts = optsFor(f.name, ctx.base);
    let r = null;
    if (ctx.gpu) {
      let bmp = null;
      try {
        bmp = await decodeForGpu(f);
        // cualquier fallo del camino GPU (canvas demasiado grande, memoria
        // de GPU, etc.) cae al camino todo-en-WASM en vez de perder el escaneo
        if (bmp) r = await processViaGpu(f, bmp, ctx.layoutStr, opts);
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
        bytes, name: f.name, layout: ctx.layoutStr, opts,
        claims: JSON.stringify(ph2.claims),
      }, [bytes.buffer]);
    }
    const asBlob = (u8, type) => new Blob([u8], { type });
    return {
      result: JSON.parse(r.result),
      frames: (r.frames ?? []).map((fr) => ({ label: fr.label, png: asBlob(fr.png, 'image/png') })),
      sinIdentificar: (r.sin_identificar ?? []).map((fr) => ({ label: fr.label, png: asBlob(fr.png, 'image/png') })),
      overlay: r.overlay ? asBlob(r.overlay, 'image/jpeg') : null,
    };
  }

  /** Escaneos que dicen ser la MISMA hoja: sus recortes comparten etiqueta y
   *  solo puede quedar uno. Se recalcula con el informe, no se avisa y se
   *  olvida: mientras el conflicto siga ahí, hay que verlo. */
  let sheetConflicts = [];

  /** Los fotogramas recuperados y las identidades se DERIVAN del informe: se
   *  rehacen enteros a partir de ph2.results, en orden.
   *
   *  Llevarlos a mano (sumar al añadir un resultado, restar al quitarlo) se
   *  equivocaba en cuanto dos escaneos compartían etiquetas: al soltar uno se
   *  llevaba por delante los fotogramas del otro, que seguía en el informe
   *  con sus recortes intactos, y la fase ③ armaba el video sin ellos. */
  function rebuildFromResults() {
    project.processedFrames.clear();
    ph2.claims = {};
    const byNumber = new Map(); // nº hoja → escaneos que la reclaman
    for (const e of ph2.results) {
      const r = e.result;
      const via = String(r.via ?? '');
      if (r.hoja_numero != null && /^(QR|marker|assigned)/.test(via)) {
        ph2.claims[r.hoja_numero] = r.scan;
        const list = byNumber.get(r.hoja_numero) ?? [];
        list.push(r.scan);
        byNumber.set(r.hoja_numero, list);
      }
      // el último resultado de la lista es el que se queda con la etiqueta,
      // igual que en la tabla
      for (const fr of e.frames) project.processedFrames.set(fr.label, fr.png);
    }
    sheetConflicts = [...byNumber.entries()]
      .filter(([, scans]) => scans.length > 1)
      .map(([numero, scans]) => ({ numero, scans }));
  }

  function describeMachine(gpu, width) {
    const ram = machineRam();
    const ramTxt = ram.manual ? `${ram.gb} GB RAM (set by you)`
      : navigator.deviceMemory ? `${navigator.deviceMemory}+ GB RAM (browser estimate)`
      : 'RAM not reported (assuming 4 GB; set yours in Options)';
    specsInfo.textContent = `This machine: ${navigator.hardwareConcurrency || '?'} cores, ${ramTxt}, GPU straightening ${gpu ? 'on' : 'off'}. Processing ${width} scan${width > 1 ? 's' : ''} at a time to stay inside memory.`;
  }

  async function processScans(files) {
    if (!ph2.layout) { toast('Load the project layout.json first.', 'err'); return; }
    if (processing) { toast('Wait for the current batch to finish.', 'err'); return; }
    processing = true;
    reprocessBtn.disabled = true;
    prog.show();
    try {
      const ctx = await makeContext();
      const singleSheet = (ph2.layout.hojas ?? []).length === 1;
      const width = pickConcurrency(files, !!ctx.gpu, singleSheet);
      describeMachine(ctx.gpu, width);
      let done = 0;
      const queue = [...files];
      await Promise.all(Array.from({ length: width }, async () => {
        while (queue.length) {
          const f = queue.shift();
          try {
            addResult(await runOne(f, ctx));
          } catch (e) {
            toast(`Error in one scan: ${e.message}`, 'err');
          }
          done++;
          prog.set(done / files.length, `${done}/${files.length} scans`);
        }
      }));
      recycleIdle(); // liberar la memoria WASM que infló el lote
      renderSummary();
      toast('Processing finished. Check the report.', 'ok');
    } catch (e) {
      // la zona de soltar y el botón de reprocesar lanzan el lote sin await:
      // lo que falle al preparar el contexto (GPU, layout) no lo ve nadie más
      console.error(e);
      toast(`Could not process the scans: ${e.message ?? e}`, 'err');
    } finally {
      prog.hide();
      processing = false;
      reprocessBtn.disabled = false;
      refreshReprocess();
    }
  }

  /** Vuelve a procesar UN escaneo (tras asignarle una hoja a mano) y cambia
   *  su fila en el sitio, sin tocar el resto del informe.
   *
   *  Devuelve si el reprocesado LLEGÓ A CORRER: quien llama deshace la
   *  asignación cuando no. Que el escaneo siga sin hoja no cuenta como
   *  fallo — es un resultado, y el aviso ya lo dice —; deshacerlo también
   *  impediría volver a “automatic” justamente en los escaneos que nadie
   *  identifica solo, que es lo que pide la caja de conflictos. */
  async function reprocessOne(name) {
    const f = loadedScans.get(name);
    if (!f) { toast(`“${name}” is no longer loaded: drop it again to reprocess it.`, 'err'); return false; }
    if (!ph2.layout) { toast('Load the project layout.json first.', 'err'); return false; }
    if (processing) { toast('Wait for the current batch to finish.', 'err'); return false; }
    processing = true;
    reprocessBtn.disabled = true;
    prog.show();
    prog.set(0.35, `reprocessing ${name}…`);
    let ran = false;
    try {
      const ctx = await makeContext();
      describeMachine(ctx.gpu, 1);
      // el informe solo cambia cuando el nuevo resultado ya existe: si esto
      // falla, se queda como estaba en vez de perder sus fotogramas
      const entry = await runOne(f, ctx);
      addResult(entry); // reemplaza la fila anterior de este mismo archivo
      prog.set(1, '');
      recycleIdle();
      ran = true;
      const n = entry.result.hoja_numero;
      toast(n != null
        ? `“${name}” → sheet ${n}: ${entry.frames.length} frame(s) cropped.`
        : `“${name}” still has no sheet: ${entry.result.error || 'check the alignment overlay.'}`,
        n != null ? 'ok' : 'err');
    } catch (e) {
      console.error(e);
      toast(`Could not reprocess “${name}”: ${e.message ?? e}`, 'err');
    } finally {
      prog.hide();
      processing = false;
      reprocessBtn.disabled = false;
      refreshReprocess();
    }
    return ran;
  }

  // La tabla del informe se construye INCREMENTALMENTE: cada resultado crea
  // sus filas (y sus URLs de miniaturas) UNA sola vez. Reconstruir todo el
  // informe tras cada escaneo redecodificaba todas las miniaturas anteriores
  // y filtraba URLs sin liberar: por eso el final del lote se arrastraba.
  // Cada entrada guarda ADEMÁS sus propias filas y URLs, para poder cambiar
  // una sola cuando se le asigna la hoja a mano.
  const reportHeader = el('tr', {}, ...['', 'Scan', 'Sheet', 'Assign', 'Markers', 'Alignment', 'Frames', 'Notes'].map((h) => el('th', {}, h)));
  const reportTable = el('table', { class: 'report' }, reportHeader);
  // La tabla se desplaza DENTRO de su caja. Son ocho columnas y cuatro de
  // ellas las ensancha el rótulo de la cabecera, no el dato, así que en un
  // móvil no caben por mucho que se estrechen: sin este envoltorio su ancho
  // mínimo estiraba la página entera —cabecera y pie incluidos— a 760 px en
  // una pantalla de 430.
  const reportScroll = el('div', { class: 'table-scroll' }, reportTable);
  const missingSlot = el('div');
  const assignSlot = el('div');
  const conflictSlot = el('div');

  /** Las hojas del layout como opciones legibles: número + qué fotogramas
   *  lleva, que es lo que deja reconocerla en las miniaturas. */
  function sheetChoices(forScan) {
    const out = [['', 'automatic']];
    for (const h of ph2.layout?.hojas ?? []) {
      const labels = Object.keys(h.frames ?? {}).sort();
      const range = labels.length > 1 ? ` · ${labels[0]} → ${labels[labels.length - 1]}`
        : labels.length === 1 ? ` · ${labels[0]}` : '';
      const taken = ph2.claims[h.numero];
      const busy = taken && taken !== forScan ? ` · already taken by ${taken}` : '';
      out.push([String(h.numero), `Sheet ${h.numero}${range}${busy}`]);
    }
    return out;
  }

  /** Selector “esta hoja es la N”: al elegir, reprocesa ESE escaneo. */
  function assignControl(scanName) {
    const cur = ph2.assign[scanName];
    const sel = select(sheetChoices(scanName), cur == null ? '' : String(cur));
    sel.className = 'assign-sel';
    sel.title = 'Tell the app which sheet this scan is';
    sel.disabled = !ph2.layout || !loadedScans.has(scanName);
    sel.addEventListener('change', async () => {
      const previous = ph2.assign[scanName];
      if (sel.value === '') delete ph2.assign[scanName];
      else ph2.assign[scanName] = parseInt(sel.value, 10);
      // si el reprocesado no llegó a correr (otro lote en marcha, el archivo
      // ya no está cargado, el escaneo falló), el desplegable no debe quedarse
      // mostrando una hoja que nadie aplicó, ni ph2.assign guardarla para
      // reaplicarla en el siguiente lote
      if (!(await reprocessOne(scanName))) {
        if (previous == null) delete ph2.assign[scanName];
        else ph2.assign[scanName] = previous;
        sel.value = previous == null ? '' : String(previous);
      }
    });
    return sel;
  }

  /** Todas las imágenes del informe en orden, para recorrerlas con ← →. */
  function galleryItems() {
    const items = [];
    for (const e of ph2.results) {
      if (e.overlay) {
        items.push({ data: e.overlay, caption: `${e.result.scan}: green = marker found, red = missing, blue = frames, orange = QRs` });
      }
      for (const f of e.shown ?? []) items.push({ data: f.png, caption: `${e.result.scan} · ${f.label}` });
    }
    return items;
  }

  function openInGallery(blob, caption) {
    const items = galleryItems();
    const index = items.findIndex((it) => it.data === blob);
    if (index < 0) { lightbox(blob, caption); return; }
    lightbox(blob, caption, { items, index });
  }

  function buildResultRows(entry) {
    const { result: r, frames, sinIdentificar, overlay } = entry;
    entry.urls = [];
    const trackUrl = (u) => { entry.urls.push(u); return u; };
    // miniaturas pequeñas; un clic abre la imagen a tamaño completo
    const shown = [...frames, ...sinIdentificar].slice(0, 60);
    entry.shown = shown;
    const thumbs = el('div', { class: 'thumbs report-thumbs' });
    if (overlay) {
      const t = el('div', { class: 'thumb clickable', title: 'View the alignment overlay' },
        el('img', { src: trackUrl(URL.createObjectURL(overlay)), alt: 'alignment' }),
        el('div', { class: 'tag' }, 'alignment'));
      t.addEventListener('click', () => openInGallery(overlay, r.scan));
      thumbs.append(t);
    }
    for (const f of shown) {
      const t = el('div', { class: 'thumb clickable', title: 'View at full size (← → to move between frames, Esc to close)' },
        el('img', { src: trackUrl(pngUrl(f.png)) }), el('div', { class: 'tag' }, f.label));
      t.addEventListener('click', () => openInGallery(f.png, f.label));
      thumbs.append(t);
    }
    const manual = ph2.assign[r.scan] != null;
    const rows = [el('tr', {},
      el('td', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✔' : '✘'),
      el('td', { class: 'mono' }, r.scan),
      // el selector va en su propia columna: metido en la celda de la hoja
      // estiraba esa columna a media tabla y empujaba el número a otro renglón
      el('td', { class: 'sheet-cell' },
        String(r.hoja_numero ?? '—'), manual ? el('span', { class: 'byhand' }, 'by hand') : null),
      el('td', { class: 'assign-cell' }, assignControl(r.scan)),
      el('td', { class: 'mono' }, `${r.marcadores}/${r.marcadores_total}`),
      el('td', { class: 'mono' }, `${r.residual_mm ? `±${r.residual_mm} mm` : '—'}${r.espejado ? ' · mirrored' : ''}`),
      el('td', {}, String(frames?.length ?? 0)),
      el('td', {}, [
        ...(r.advertencias ?? []).map((a) => el('div', { class: 'hint warn' }, a)),
        r.error ? el('div', { class: 'hint err' }, r.error) : null,
      ]),
    ), el('tr', {}, el('td', {}), el('td', { colspan: '7' }, thumbs))];
    entry.rows = rows;
    return rows;
  }

  /** Añade un resultado, o reemplaza el que ya hubiera para ese mismo
   *  archivo: `ph2.assign` y el reprocesado individual buscan por nombre de
   *  escaneo, así que dos filas con el mismo nombre harían que editar una
   *  cambiara la otra. Un archivo, una fila. */
  function addResult(entry) {
    const dup = ph2.results.find((e) => e.result.scan === entry.result.scan);
    if (dup) { replaceResult(dup, entry); return; }
    ph2.results.push(entry);
    reportTable.append(...buildResultRows(entry));
    rebuildFromResults();
    renderSummary();
  }

  /** Suelta las filas y las URLs de una entrada (sus Blobs siguen vivos si
   *  otro resultado los usa; las URLs no). */
  function dropRows(entry) {
    for (const row of entry.rows ?? []) row.remove();
    for (const u of entry.urls ?? []) URL.revokeObjectURL(u);
    entry.rows = null;
    entry.urls = [];
  }

  function replaceResult(oldEntry, entry) {
    const i = ph2.results.indexOf(oldEntry);
    const anchor = oldEntry.rows?.[0] ?? null;
    if (i >= 0) ph2.results[i] = entry; else ph2.results.push(entry);
    const rows = buildResultRows(entry);
    if (anchor) anchor.before(...rows); else reportTable.append(...rows);
    dropRows(oldEntry);
    rebuildFromResults();
    renderSummary();
  }

  /** `keepAssign`: al reprocesar el lote con otras opciones, las hojas que el
   *  usuario asignó a mano deben sobrevivir; el botón “Clear results” no. */
  function clearReport(keepAssign = false) {
    for (const e of ph2.results) dropRows(e);
    ph2.results = [];
    if (!keepAssign) ph2.assign = {};
    reportTable.replaceChildren(reportHeader);
    rebuildFromResults();
    renderSummary();
  }

  /** Dónde imprimió ESTE proyecto el número de hoja: es lo primero que hay
   *  que mirar para saber qué hoja es un escaneo sin identificar. */
  function whereTheSheetNumberIs() {
    const aj = ph2.layout?.ajustes;
    if (!aj) return 'Look for the sheet number printed on the page';
    if (aj.page_num_on === false) return 'This project printed no sheet number, so go by the drawings';
    const corner = String(aj.page_num_corner ?? 'Bottom right').toLowerCase();
    const edge = corner.includes('top') || corner.includes('superior') ? 'top' : 'bottom';
    const side = corner.includes('left') || corner.includes('izquierda') ? 'left' : 'right';
    return `Read the sheet number this project printed on the ${edge} ${side} of the page`;
  }

  /** Caja de asignación manual: los escaneos que se enderezaron bien pero
   *  cuya hoja nadie pudo nombrar. */
  function renderAssignBox() {
    assignSlot.replaceChildren();
    const pending = ph2.results.filter((e) => e.result.hoja_numero == null);
    if (!ph2.layout || !pending.length) return;
    assignSlot.append(el('div', { class: 'assign-box' },
      el('strong', {}, `${pending.length} scan${pending.length > 1 ? 's' : ''} with no sheet identified`),
      el('div', { class: 'hint assign-hint' },
        'The markers straightened the sheet, but nothing said WHICH sheet it is: the QR is painted over, '
        + 'unreadable, or the project identifies sheets by QR only. '
        + `${whereTheSheetNumberIs()}, or recognise the drawings in the thumbnails below, and pick the sheet here. `
        + 'The scan is reprocessed on the spot and its frames come out with their real labels.'),
      ...pending.map((e) => el('div', { class: 'assign-row' },
        el('span', { class: 'mono' }, e.result.scan),
        assignControl(e.result.scan))),
    ));
  }

  function renderConflicts() {
    conflictSlot.replaceChildren();
    if (!sheetConflicts.length) return;
    conflictSlot.append(el('div', { class: 'missing-box' },
      el('strong', {}, `Two scans claim the same sheet:`),
      ...sheetConflicts.map(({ numero, scans }) => el('div', { style: 'margin-top:4px' },
        `Sheet ${numero}: ${scans.join(', ')} — only the frames of the last one are kept.`)),
      el('div', { style: 'margin-top:6px' },
        'Send the wrong one to another sheet with its selector, or set it back to automatic.'),
    ));
  }

  function renderSummary() {
    const any = ph2.results.length > 0;
    reportTable.style.display = any ? '' : 'none';
    downloadRow.style.display = any ? '' : 'none';
    renderConflicts();
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
    renderAssignBox();
    framesState.textContent = project.processedFrames.size
      ? `${project.processedFrames.size} recovered frames in memory (ready for the Video phase).`
      : '';
  }

  // descarga de resultados
  const downloadRow = el('div', { class: 'btn-row' },
    el('button', {
      class: 'btn sun', onclick: async () => {
        try {
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
        } catch (e) {
          // un ZIP de cientos de fotogramas puede quedarse sin memoria: sin
          // esto, el botón simplemente no hacía nada
          console.error(e);
          toast(`Could not build the ZIP: ${e.message ?? e}`, 'err');
        }
      },
    }, 'Download frames + report (ZIP)'),
    el('button', {
      class: 'btn ghost-light small', onclick: () => clearReport(),
    }, 'Clear results'),
  );
  resultsBox.append(assignSlot, conflictSlot, missingSlot, reportScroll, downloadRow);
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
    label: 'Drop the project originals folder (…_originals/)',
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
    rescueDz, rescueInfo, el('div', { class: 'btn-row' }, rescueBtn), rescueProg.root,
  );

  // ── escaneos de demostración ─────────────────────────────────
  /** Convierte una hoja recién generada en un “escaneo”: la pega girada 2°
   *  sobre un fondo mayor, como saldría de un escáner de mesa. Recorre el
   *  circuito ①→②→③ entero sin imprimir ni escanear nada. */
  async function simulateScan(blob, name) {
    const bmp = await createImageBitmap(blob);
    const w = Math.round(bmp.width * 1.08);
    const h = Math.round(bmp.height * 1.08);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#B6B4AE'; // tapa del escáner
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((2 * Math.PI) / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    bmp.close();
    const png = await c.convertToBlob({ type: 'image/png' });
    return new File([png], `${name.replace(/\.png$/i, '')}_scan.png`, { type: 'image/png' });
  }

  const demoBtn = el('button', { class: 'btn ghost small', style: 'display:none; margin-top:6px' },
    'No scans yet? Simulate them from this session’s sheets');
  demoBtn.addEventListener('click', async () => {
    if (!project.sheetImages.size) { toast('Generate the sheets in phase ① first.', 'err'); return; }
    if (!ph2.layout) {
      if (!project.layoutJson) { toast('Generate the sheets in phase ① first.', 'err'); return; }
      const layout = JSON.parse(project.layoutJson);
      setLayout(layout, 'current project layout', `✔ ${layoutSummary(layout)}`);
    }
    demoBtn.disabled = true;
    try {
      const files = [];
      for (const [name, blob] of project.sheetImages) files.push(await simulateScan(blob, name));
      for (const f of files) loadedScans.set(f.name, f);
      refreshReprocess();
      toast(`${files.length} simulated scan(s): your sheets, printed and scanned back crooked.`, 'ok');
      await processScans(files);
    } catch (e) {
      console.error(e);
      toast(`Could not simulate the scans: ${e.message ?? e}`, 'err');
    } finally {
      demoBtn.disabled = false;
    }
  });
  function refreshDemo() {
    demoBtn.style.display = project.sheetImages.size ? '' : 'none';
  }
  root.addEventListener('mxm:activated', refreshDemo);
  refreshDemo();

  const paper = el('div', { class: 'paper' },
    el('h2', {}, '② Process scans'),
    el('div', { class: 'hint' }, 'The app straightens each sheet with the markers, identifies it by its marker IDs (or its QRs, on older projects) and crops every frame. If nothing identifies a sheet, you can tell the app which one it is in the report. No Photoshop.'),
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
    demoBtn,
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
