// Fase ① — Generar hojas de contacto.

import { run } from './pool.ts';
import { el, toast, download, progressBar, dropzone, field, numberInput, select, setOptions, check,
         selectIndices, uniquifyLabels, originalPageNumbers, sanitizeLabel, pngUrl, context2d } from './ui.ts';
import type { SelectOption } from './ui.ts';
import { project, clearFrames, frameImageData, ensureThumb } from './project.ts';
import { extractFrames, probeVideo } from './video.ts';
import { generateSheets, resolveCyanCurve, packThumbs, packImageData, settingsForCore } from './gen.ts';
import type { GenFrame, PackItem } from './gen.ts';
import * as store from './store.ts';
import { makeZip } from './zip.ts';
import { defaultSettings, normalizeSettings, isCyanotype } from './settings.ts';
import { errMsg } from './errors.ts';
import type {
  Settings, DedupGroups, LayoutInfo, Phase1Persist,
  NumberKeys, StringKeys, BooleanKeys,
} from './types.ts';

const PAPERS = ['A4', 'A3', 'A5', 'A6', 'B4', 'B5', 'Letter', 'Legal', 'Tabloid', 'Custom'];
const ORIENTATIONS: SelectOption[] = [['auto', 'Best fit (automatic)'], ['portrait', 'Portrait'], ['landscape', 'Landscape']];
const CORNERS = ['Bottom right', 'Bottom left', 'Top right', 'Top left'];

/** Lo mismo que normalizeSettings para el estado de la fase (numeración de
 *  etiquetas y de hojas). */
function normalizePhase(fase: Partial<Phase1Persist>): Partial<Phase1Persist> {
  const out: Partial<Phase1Persist> = { ...fase };
  for (const k of ['numbering', 'pageNumbering'] as const) {
    if ((out[k] as string | undefined) === 'continua') out[k] = 'sequential';
  }
  return out;
}

export interface Phase1State {
  settings: Settings;
  include: string;
  exclude: string;
  naming: 'auto' | 'original';           // auto | original (nombre de archivo)
  numbering: 'sequential' | 'original';  // sequential | original
  pageNumbering: 'sequential' | 'original';
  dedupOn: boolean;
  dedupThreshold: number;
  dedupGroups: DedupGroups | null;       // {reps, rep_of} sobre la selección actual
  keepOriginals: boolean;
  exportFrames: boolean;
  sheets_include: string;
  sheets_exclude: string;
  previewPage: number;
  previewSimulate: boolean;
  cyanResponse: [number, number][] | null; // respuesta medida del perfil (soft-proof)
}

// estado de la fase (persistido en localStorage)
export const ph1: Phase1State = {
  settings: normalizeSettings({ ...defaultSettings(), ...(store.loadSettings() ?? {}) }),
  include: '', exclude: '',
  naming: 'auto',
  numbering: 'sequential',
  pageNumbering: 'sequential',
  dedupOn: false, dedupThreshold: 4,
  dedupGroups: null,
  keepOriginals: true, exportFrames: false,
  sheets_include: '', sheets_exclude: '',
  previewPage: 0, previewSimulate: false,
  cyanResponse: null,
};

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function formatLabel(s: Settings, num: number): string {
  let str = String(num);
  while (str.length < (s.leading_zeros ?? 1)) str = `0${str}`;
  return s.base_name ? `${s.base_name}${s.separator}${str}` : str;
}

export interface PrintedFrame {
  frameIdx: number;
  label: string;
  pos: number;
}

export interface Plan {
  positions: number[];
  rawLabels: string[];
  printed: PrintedFrame[];
  timeline: { pos: number; etiqueta: string; rep: string }[];
  pageNumbers: number[] | null;
  numPages: number;
  perPage: number;
}

/** Plan de impresión completo (selección → dedup → etiquetas → timeline). */
export function computePlan(): Plan {
  const s = ph1.settings;
  const N = project.frames.length;
  const positions = selectIndices(N, ph1.include, ph1.exclude);
  let rawLabels = positions.map((pos, k) => {
    if (ph1.naming === 'original') {
      const f = project.frames[pos - 1];
      // frames extraídos de un video no tienen archivo original: se nombran
      // con el video + el número, respetando el control de dígitos
      if (f.videoStem != null) {
        let n = String((f.seq ?? 0) + 1);
        while (n.length < (s.leading_zeros ?? 1)) n = `0${n}`;
        return `${f.videoStem}${s.separator}${n}`;
      }
      return stem(f.name);
    }
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
  const printed: PrintedFrame[] = reps.map((k) => ({
    frameIdx: positions[k] - 1,
    label: rawLabels[k],
    pos: positions[k],
  }));
  const timeline = positions.map((_pos, k) => ({
    pos: k + 1, etiqueta: rawLabels[k], rep: rawLabels[repOf[k]],
  }));
  const perPage = Math.max(1, s.cols * s.rows);
  const pageNumbers = ph1.pageNumbering === 'original'
    ? originalPageNumbers(printed.map((p) => p.pos), perPage, s.page_num_start)
    : null;
  const numPages = Math.max(printed.length ? 1 : 0, Math.ceil(printed.length / perPage));
  return { positions, rawLabels, printed, timeline, pageNumbers, numPages, perPage };
}

async function computeDedup(statusEl: HTMLElement): Promise<void> {
  const positions = selectIndices(project.frames.length, ph1.include, ph1.exclude);
  if (!positions.length) { ph1.dedupGroups = null; return; }
  statusEl.textContent = 'analyzing repeated drawings…';
  const thumbs: OffscreenCanvas[] = [];
  for (const pos of positions) thumbs.push(await ensureThumb(pos - 1));
  const { meta, pixels } = packThumbs(thumbs);
  const hashes = await run('dedup_hashes', { meta, pixels }, [pixels.buffer]);
  const groups = JSON.parse(await run('group_duplicates', { hashes, threshold: ph1.dedupThreshold })) as DedupGroups;
  ph1.dedupGroups = groups;
  const dups = groups.rep_of.filter((r, i) => r !== i).length;
  statusEl.textContent = dups
    ? `${dups} repeated frame(s): printed once and reused when the video is rebuilt.`
    : 'no repeated drawings in the selection.';
}

// ── Interfaz ──────────────────────────────────────────────────

export function mountPhase1(root: HTMLElement): void {
  const s = ph1.settings;

  // ---------- panel de origen ----------
  const framesInfo = el('div', { class: 'hint' }, 'No frames yet.');
  const thumbsGrid = el('div', { class: 'thumbs' });
  const extractProg = progressBar();
  extractProg.hide();

  const startIn = numberInput(0, { min: 0, step: 0.1 });
  const endIn = el('input', { type: 'number', min: 0, step: 0.1, placeholder: 'end' });
  const fpsIn = el('input', { type: 'number', min: 0, step: 0.1, value: 4, placeholder: 'fps' });
  const allFrames = check('ALL frames (frame by frame)', false);
  // con TODOS los frames el fps no aplica: se apaga para que se entienda
  allFrames.input.addEventListener('change', () => {
    fpsIn.disabled = allFrames.input.checked;
  });

  let pendingVideo: File | null = null;
  const videoInfo = el('div', { class: 'hint' });

  const extractBtn = el('button', { class: 'btn blue small', disabled: '' }, 'Extract frames');
  extractBtn.addEventListener('click', async () => {
    if (!pendingVideo) return;
    const video = pendingVideo;
    extractBtn.disabled = true;
    extractProg.show();
    clearFrames();
    try {
      const meta = await extractFrames(video, {
        start: parseFloat(startIn.value) || 0,
        end: endIn.value ? parseFloat(endIn.value) : undefined,
        fps: allFrames.input.checked ? null : (parseFloat(fpsIn.value) || null),
        onFrame: async (blob, thumb, _t, i, w, h) => {
          // se guarda el origen (video + posición): la etiqueta "Original
          // file name" se construye después con el control de dígitos
          const videoStem = video.name.replace(/\.[^.]+$/, '');
          project.frames.push({
            name: `${videoStem}_${String(i + 1).padStart(6, '0')}.png`,
            videoStem, seq: i,
            blob, thumb, w, h, hasAlpha: false,
          });
        },
        onProgress: (i, est) => extractProg.set(est ? i / est : 0.5, `frame ${i}${est ? ` of ~${est}` : ''}`),
      });
      project.videoMeta = { fps_extraccion: meta.fps, origen: meta.origen };
      toast(`${meta.count} frames extracted losslessly (PNG).`, 'ok');
      // sin await, un fallo del refresco escapaba del try y no se veía; y
      // dentro del catch de abajo se anunciaría como "Extraction failed",
      // que es justo lo contrario de lo que pasó
      try {
        await afterFramesChanged();
      } catch (e) {
        console.error(e);
        toast(`The frames extracted, but the preview failed: ${errMsg(e)}`, 'err');
      }
    } catch (e) {
      toast(`Extraction failed: ${errMsg(e)}`, 'err');
    } finally {
      extractBtn.disabled = false;
      extractProg.hide();
    }
  });

  const dz = dropzone({
    label: 'Drop your video or a folder of images here',
    sublabel: 'MP4 / MOV / WebM / MKV / AVI / MPG / WMV, or PNG, JPG, TIFF, WebP (16-bit too). Nothing is uploaded.',
    accept: 'video/*,image/*,.tif,.tiff,.avi,.mpg,.mpeg,.wmv,.flv,.3gp',
    multiple: true,
    onFiles: async (fileList) => {
      const videos = fileList.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi|mpg|mpeg|wmv|flv|3gp)$/i.test(f.name));
      const images = fileList.filter((f) => !videos.includes(f));
      if (videos.length) {
        pendingVideo = videos[0];
        try {
          videoInfo.textContent = 'Reading the video…';
          const p = await probeVideo(pendingVideo);
          const via = p.fallback ? ' (decoded with the built-in converter)' : '';
          videoInfo.textContent = `${pendingVideo.name}: ${p.width}×${p.height}, ${p.duration.toFixed(1)} s${p.fps ? `, ${p.fps.toFixed(2)} fps` : ''}${via}. Pick range/fps and press “Extract”.`;
          endIn.value = p.duration.toFixed(1);
          extractBtn.disabled = false;
        } catch (e) {
          videoInfo.textContent = '';
          toast(errMsg(e), 'err');
        }
      } else if (images.length) {
        // una carpeta entra entera: si un archivo no se deja decodificar, el
        // usuario tiene que enterarse de CUÁL y quedarse con el resto, no ver
        // una carga a medias sin explicación
        clearFrames();
        images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const rejected: string[] = [];
        for (const f of images) {
          const needsWasmDecode = /\.(tif|tiff)$/i.test(f.name);
          let w = 0, h = 0, hasAlpha = false;
          try {
            if (!needsWasmDecode) {
              const bmp = await createImageBitmap(f);
              w = bmp.width; h = bmp.height; bmp.close();
              hasAlpha = /\.png$/i.test(f.name) || /\.webp$/i.test(f.name);
            } else {
              const bytes = new Uint8Array(await f.arrayBuffer());
              const r = await run('decode_image', { bytes }, [bytes.buffer]);
              w = r.w; h = r.h; hasAlpha = r.had_alpha;
            }
          } catch { rejected.push(f.name); continue; }
          project.frames.push({ name: f.name, blob: f, thumb: null, w, h, hasAlpha, needsWasmDecode });
        }
        project.videoMeta = { origen: 'images', fps_extraccion: 12 };
        if (rejected.length) {
          toast(`${rejected.length} file(s) could not be read and were left out: ${rejected.slice(0, 8).join(', ')}${rejected.length > 8 ? '…' : ''}`, 'err');
        }
        // aunque no quede ninguno hay que refrescar: clearFrames ya vació el
        // proyecto y las miniaturas en pantalla serían de otro
        toast(project.frames.length
          ? `${project.frames.length} images loaded.`
          : 'None of those files could be read as an image.',
          project.frames.length ? 'ok' : 'err');
        try {
          await afterFramesChanged();
        } catch (e) {
          console.error(e);
          toast(`The frames loaded, but the preview failed: ${errMsg(e)}`, 'err');
        }
      }
    },
  });

  // ---------- selección, nombres, dedup ----------
  // Refrescar la tira decodifica fotogramas, así que puede fallar (un archivo
  // ilegible, el núcleo sin memoria). Estos manejadores no los espera nadie:
  // sin catch, el cambio se quedaba a medias y en silencio.
  const reportRefreshFailure = (e: unknown): void => {
    console.error(e);
    toast(`Could not refresh the frames: ${errMsg(e)}`, 'err');
  };
  const refreshFrames = (): Promise<void> => afterFramesChanged().catch(reportRefreshFailure);

  const includeIn = el('input', { type: 'text', placeholder: 'e.g. 1, 3-5 (empty = all)' });
  const excludeIn = el('input', { type: 'text', placeholder: 'e.g. 8, 12' });
  includeIn.addEventListener('change', () => { ph1.include = includeIn.value; void refreshFrames(); });
  excludeIn.addEventListener('change', () => { ph1.exclude = excludeIn.value; void refreshFrames(); });

  const namingSel = select([['auto', 'Auto-increment (abc_001…)'], ['original', 'Original file name']], ph1.naming);
  const numberingSel = select([['sequential', 'Sequential (1, 2, 3…)'], ['original', 'Original (position in the video)']], ph1.numbering);
  const pageNumberingSel = select([['sequential', 'Sequential (1, 2, 3…)'], ['original', 'Original (based on the frames)']], ph1.pageNumbering);
  // los tres cambian las etiquetas visibles: refrescar también las miniaturas
  const relabel = (): Promise<void> => renderThumbs().then(() => refreshPreview()).catch(reportRefreshFailure);
  namingSel.addEventListener('change', () => { ph1.naming = namingSel.value === 'original' ? 'original' : 'auto'; void relabel(); });
  numberingSel.addEventListener('change', () => { ph1.numbering = numberingSel.value === 'original' ? 'original' : 'sequential'; void relabel(); });
  pageNumberingSel.addEventListener('change', () => { ph1.pageNumbering = pageNumberingSel.value === 'original' ? 'original' : 'sequential'; void refreshPreview(); });

  const dedupCheck = check('Detect repeated drawings (print each only once)', ph1.dedupOn);
  const dedupStatus = el('div', { class: 'hint' });
  dedupCheck.input.addEventListener('change', async () => {
    ph1.dedupOn = dedupCheck.input.checked;
    try {
      if (ph1.dedupOn) await computeDedup(dedupStatus);
      else dedupStatus.textContent = '';
      void refreshPreview();
      await renderThumbs();
    } catch (e) {
      console.error(e);
      dedupStatus.textContent = ''; // no dejar colgado el "analyzing…"
      toast(`Could not analyze the repeated drawings: ${errMsg(e)}`, 'err');
    }
  });

  // ---------- ajustes de hoja (enlace genérico) ----------
  const binds: (() => void)[] = [];
  function bindNum(key: NumberKeys<Settings>, input: HTMLInputElement, { integer = false }: { integer?: boolean } = {}): HTMLInputElement {
    input.value = String(s[key]);
    input.addEventListener('change', () => {
      const v = integer ? parseInt(input.value, 10) : parseFloat(input.value);
      if (!Number.isNaN(v)) s[key] = v;
      persist(); void refreshPreview();
    });
    binds.push(() => { input.value = String(s[key]); });
    return input;
  }
  function bindText(key: StringKeys<Settings>, input: HTMLInputElement): HTMLInputElement {
    input.value = s[key] ?? '';
    input.addEventListener('change', () => { s[key] = input.value; persist(); void refreshPreview(); });
    binds.push(() => { input.value = s[key] ?? ''; });
    return input;
  }
  function bindSel(key: StringKeys<Settings>, input: HTMLSelectElement): HTMLSelectElement {
    input.value = s[key];
    input.addEventListener('change', () => { s[key] = input.value; persist(); void refreshPreview(); });
    binds.push(() => { input.value = s[key]; });
    return input;
  }
  function bindCheck(key: BooleanKeys<Settings>, c: { input: HTMLInputElement; label: HTMLLabelElement }): HTMLLabelElement {
    c.input.checked = !!s[key];
    c.input.addEventListener('change', () => { s[key] = c.input.checked; persist(); void refreshPreview(); });
    binds.push(() => { c.input.checked = !!s[key]; });
    return c.label;
  }
  function bindColor(key: StringKeys<Settings>, input: HTMLInputElement): HTMLInputElement {
    input.value = s[key] ?? '#000000';
    input.addEventListener('input', () => { s[key] = input.value.toUpperCase(); persist(); refreshPreviewSoon(); });
    binds.push(() => { input.value = s[key] ?? '#000000'; });
    return input;
  }
  // Los ajustes se guardan por comodidad entre sesiones, así que un
  // almacenamiento lleno o bloqueado no puede cortar el manejador que lo
  // llamó (se quedaría sin refrescar la vista previa). Se avisa UNA vez: por
  // aquí pasa cada cambio de cada control.
  let persistWarned = false;
  function persist(): void {
    try {
      store.saveSettings(s);
    } catch (e) {
      if (persistWarned) return;
      persistWarned = true;
      toast(`Your settings will not be remembered for the next session. ${errMsg(e)}`, 'err');
    }
  }

  const customRow = el('div', { class: 'row' },
    field('Width (mm)', bindNum('custom_w_mm', numberInput(210, { min: 30 }))),
    field('Height (mm)', bindNum('custom_h_mm', numberInput(297, { min: 30 }))),
  );
  const paperSel = bindSel('paper', select(PAPERS, s.paper));
  const syncCustom = (): void => { customRow.style.display = paperSel.value === 'Custom' ? '' : 'none'; };
  paperSel.addEventListener('change', syncCustom);
  syncCustom();

  // ---------- cianotipia ----------
  const modeCheck = check('CYANOTYPE MODE: generate negatives for transparency film', isCyanotype(s));
  const cyanBox = el('fieldset', {}, el('legend', {}, 'Cyanotype'));
  modeCheck.input.addEventListener('change', () => {
    s.mode = modeCheck.input.checked ? 'cyanotype' : 'normal';
    cyanBody.style.display = modeCheck.input.checked ? '' : 'none';
    const holder = simulateToggle.label.parentElement;
    if (holder) holder.style.display = modeCheck.input.checked ? '' : 'none';
    persist(); void refreshPreview();
  });

  const curveProfiles = (): SelectOption[] => [['', '(no curve: linear)'], ...store.listProfiles('cianotipia').map((n): SelectOption => [n, n])];
  const curveSel = select(curveProfiles(), '');
  curveSel.addEventListener('change', () => {
    const p = curveSel.value ? store.loadProfile('cianotipia', curveSel.value) : null;
    s.cyan_curve = p?.lut ?? null;
    ph1.cyanResponse = p?.respuesta ?? null;
    if (p?.ink && p.ink !== s.cyan_ink && !s.cyan_ink_stops) {
      toast(`Heads up: this curve was measured with ink ${p.ink} and you are now using ${s.cyan_ink}.`);
    }
    persist(); void refreshPreview();
  });
  const inkProfiles = (): SelectOption[] => [['', '(plain ink)'], ...store.listProfiles('cianotipia_color').map((n): SelectOption => [n, n])];
  const inkProfSel = select(inkProfiles(), '');
  inkProfSel.addEventListener('change', () => {
    const p = inkProfSel.value ? store.loadProfile('cianotipia_color', inkProfSel.value) : null;
    if (p) {
      s.cyan_ink_stops = p.stops ?? null;
      s.cyan_ink = p.mejor_color ?? s.cyan_ink;
      if (p.mejor_color) s.cyan_block_color = p.mejor_color;
      toast(`ColorBlocker gradient applied (${p.mejor_color ?? ''}).`, 'ok');
    } else {
      s.cyan_ink_stops = null;
    }
    persist(); void refreshPreview();
  });

  const cyanBody = el('div', {},
    bindCheck('cyan_mirror', check('Mirror (emulsion-to-emulsion printing)', s.cyan_mirror)),
    el('div', { class: 'row' },
      field('Ink color', bindColor('cyan_ink', el('input', { type: 'color' }))),
      field('Ink color profile (ColorBlocker)', inkProfSel),
    ),
    field('Compensation curve (cyanotype profile)', curveSel,
      'Measured in Calibration. Without a curve, density follows the original brightness.'),
    el('div', { class: 'row' },
      field('Curve strength (%)', bindNum('cyan_curve_strength', numberInput(100, { min: 0, max: 100 })),
        'How much of the calibrated curve to apply. 0 = none.'),
      field('Micro-contrast (%)', bindNum('cyan_clarity', numberInput(0, { min: 0, max: 100 })),
        'Local contrast. Brings out pencil lines.'),
    ),
    field('Content adaptation (%)', bindNum('cyan_adaptive', numberInput(0, { min: 0, max: 100 })),
      'Spends the ink range on the tones the drawings use instead of the whole scale. Useful when everything '
      + 'sits in the mid-greys. 0 prints the curve as calibrated.'),
    field('Negative background', bindSel('cyan_bg', select([['saving', 'INK-SAVING (inked halos only)'], ['full', 'Full (entire background inked)']], s.cyan_bg))),
    el('div', { class: 'row' },
      field('Inked halo (mm)', bindNum('cyan_halo_mm', numberInput(5, { min: 0, step: 0.5 }))),
      field('Blocking border (mm)', bindNum('cyan_frame_border_mm', numberInput(0.8, { min: 0, step: 0.1 }))),
    ),
  );
  cyanBody.style.display = isCyanotype(s) ? '' : 'none';
  cyanBox.append(modeCheck.label, cyanBody);

  // ---------- perfil de impresora ----------
  const printerProfiles = (): SelectOption[] => [['', '(no compensation)'], ...store.listProfiles('impresora').map((n): SelectOption => [n, n])];
  const printerSel = select(printerProfiles(), '');
  printerSel.addEventListener('change', () => {
    const p = printerSel.value ? store.loadProfile('impresora', printerSel.value) : null;
    s.print_scale_x = p?.scale_x ?? 1;
    s.print_scale_y = p?.scale_y ?? 1;
    if (p?.marker_recomendado_mm) s.marker_size_mm = Math.max(s.marker_size_mm, p.marker_recomendado_mm);
    if (p?.qr_recomendado_mm) s.qr_size_mm = Math.max(s.qr_size_mm, p.qr_recomendado_mm);
    for (const b of binds) b();
    persist(); void refreshPreview();
    if (p) toast(`Printer profile applied (scale ${(p.scale_x * 100).toFixed(1)} % × ${(p.scale_y * 100).toFixed(1)} %).`, 'ok');
  });

  // ---------- presets ----------
  const presetOptions = (): SelectOption[] => [['', '(choose a preset…)'], ...store.listProfiles('presets').map((n): SelectOption => [n, n])];
  const presetSel = select(presetOptions(), '');
  const presetName = el('input', { type: 'text', placeholder: 'preset name' });
  const refreshPresetList = (): void => { setOptions(presetSel, presetOptions()); };
  const presetsRow = el('div', {},
    el('div', { class: 'row tight' },
      field('Saved presets', presetSel),
      el('button', {
        class: 'btn ghost small', onclick: () => {
          if (!presetSel.value) return;
          const p = store.loadProfile('presets', presetSel.value);
          if (p?.settings) {
            Object.assign(s, normalizeSettings(p.settings));
            Object.assign(ph1, normalizePhase(p.fase ?? {}));
            for (const b of binds) b();
            persist(); void refreshPreview();
            toast(`Preset “${presetSel.value}” loaded.`, 'ok');
          }
        },
      }, 'Load'),
      el('button', {
        class: 'btn danger small', onclick: () => {
          if (!presetSel.value) return;
          try {
            store.deleteProfile('presets', presetSel.value);
          } catch (e) {
            toast(`Preset “${presetSel.value}” was NOT deleted. ${errMsg(e)}`, 'err');
            return;
          }
          refreshPresetList();
        },
      }, 'Delete'),
    ),
    el('div', { class: 'row tight' },
      field('Save current settings as', presetName),
      el('button', {
        class: 'btn ghost small', onclick: () => {
          const name = presetName.value.trim();
          if (!name) return;
          try {
            store.saveProfile('presets', name, {
              settings: s,
              fase: { naming: ph1.naming, numbering: ph1.numbering, pageNumbering: ph1.pageNumbering, dedupOn: ph1.dedupOn },
            });
          } catch (e) {
            toast(`Preset “${name}” was NOT saved. ${errMsg(e)}`, 'err');
            return;
          }
          refreshPresetList();
          toast(`Preset “${name}” saved.`, 'ok');
        },
      }, 'Save'),
    ),
  );

  // ---------- generación ----------
  const genProg = progressBar();
  genProg.hide();
  const warnBox = el('ul', { class: 'warnlist' });
  const genBtn = el('button', { class: 'btn sun', style: 'width:100%; margin-top:8px' }, 'Generate sheets (ZIP)');
  genBtn.addEventListener('click', async () => {
    const plan = computePlan();
    if (!plan.printed.length) { toast('There are no frames to print.', 'err'); return; }
    genBtn.disabled = true;
    genProg.show();
    try {
      const thumbs: OffscreenCanvas[] = [];
      if (isCyanotype(s) && (s.cyan_adaptive ?? 0) > 0) {
        for (const p of plan.printed) thumbs.push(await ensureThumb(p.frameIdx));
      }
      const settings = await resolveCyanCurve({ ...s, sheets_include: ph1.sheets_include, sheets_exclude: ph1.sheets_exclude }, thumbs);
      const frames: GenFrame[] = plan.printed.map((p) => {
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
      project.sheetImages = out.sheetImages;
      warnBox.replaceChildren(...out.avisos.map((a) => el('li', {}, a)));
      genProg.set(1, 'packing ZIP…');
      const zip = await makeZip(out.files, (i, n) => genProg.set(1, `packing ${i}/${n}`));
      download(zip, `${sanitizeLabel(s.out_name || 'hojas')}.zip`, 'application/zip');
      toast(`Done: ${out.numPages} sheet(s). Print at 100 % (no “fit to page”).`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Generation failed: ${errMsg(e)}`, 'err');
    } finally {
      genBtn.disabled = false;
      genProg.hide();
    }
  });

  // ---------- vista previa ----------
  const previewImg = el('img', { alt: 'Sheet preview', style: 'display:none' });
  previewImg.addEventListener('load', () => { previewImg.style.display = ''; });
  const previewInfo = el('div', { class: 'progress-note', style: 'margin-top:8px; text-align:center' });
  const prevBtn = el('button', { onclick: () => { ph1.previewPage--; void refreshPreview(); } }, '‹');
  const nextBtn = el('button', { onclick: () => { ph1.previewPage++; void refreshPreview(); } }, '›');
  const pageLabel = el('span', {}, '—');
  const simulateToggle = check('Simulate final blue print', false);
  simulateToggle.input.addEventListener('change', () => { ph1.previewSimulate = simulateToggle.input.checked; void refreshPreview(); });
  simulateToggle.label.style.color = 'var(--cian-200)';

  let previewBusy = false, previewQueued = false;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshPreviewSoon(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 300);
  }
  /** Actualiza solo el texto de las etiquetas de las miniaturas (barato):
   *  cambiar dígitos, nombre base o separador se refleja al instante. */
  function updateThumbLabels(): void {
    const plan = computePlan();
    thumbsGrid.querySelectorAll('.tag').forEach((tag, k) => {
      if (plan.rawLabels[k] != null) tag.textContent = plan.rawLabels[k];
    });
  }

  async function refreshPreview(): Promise<void> {
    if (!project.frames.length) return;
    updateThumbLabels();
    if (previewBusy) { previewQueued = true; return; }
    previewBusy = true;
    try {
      const plan = computePlan();
      if (!plan.printed.length) return;
      ph1.previewPage = Math.max(0, Math.min(ph1.previewPage, plan.numPages - 1));
      const chunk = plan.printed.slice(ph1.previewPage * plan.perPage, (ph1.previewPage + 1) * plan.perPage);
      const settingsPrev = await resolveCyanCurve({ ...s, dpi: Math.min(s.dpi, 150) }, []);
      const items: PackItem[] = [];
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
      const info = JSON.parse(await run('compute_layout', { settings: settingsForCore(settingsPrev), firstW: first.w, firstH: first.h })) as LayoutInfo;
      pageLabel.textContent = `sheet ${ph1.previewPage + 1} / ${plan.numPages}`;
      previewInfo.textContent = `${info.landscape ? 'landscape' : 'portrait'} · grid ${info.cols}×${info.rows}${info.grid_swapped ? ' (swapped by best fit)' : ''} · ${plan.printed.length} frames on ${plan.numPages} sheet(s)`;
      const avisos = [...(info.avisos ?? [])];
      if (info.marker_capacity && plan.numPages > info.marker_capacity) {
        avisos.push(`${plan.numPages} sheets exceed the ${info.marker_capacity} that marker identity can distinguish. Enable "Add a QR code per frame" in Registration: QRs identify any number of sheets.`);
      }
      warnBox.replaceChildren(...avisos.map((a) => el('li', {}, a)));
    } catch (e) {
      console.error('preview', e);
    } finally {
      previewBusy = false;
      if (previewQueued) { previewQueued = false; void refreshPreview(); }
    }
  }

  async function renderThumbs(): Promise<void> {
    thumbsGrid.replaceChildren();
    const plan = computePlan();
    const dupSet = new Set<number>();
    if (ph1.dedupOn && ph1.dedupGroups) {
      ph1.dedupGroups.rep_of.forEach((r, i) => { if (r !== i) dupSet.add(i); });
    }
    const max = Math.min(plan.positions.length, 400);
    for (let k = 0; k < max; k++) {
      const idx = plan.positions[k] - 1;
      const c = await ensureThumb(idx);
      const img = el('canvas', { width: c.width, height: c.height });
      img.getContext('2d')?.drawImage(c, 0, 0);
      thumbsGrid.append(el('div', { class: `thumb${dupSet.has(k) ? ' dup' : ''}` }, img,
        el('div', { class: 'tag' }, plan.rawLabels[k])));
    }
    framesInfo.textContent = `${project.frames.length} frames loaded · ${plan.positions.length} selected · ${plan.printed.length} to print`;
  }

  async function afterFramesChanged(): Promise<void> {
    ph1.dedupGroups = null;
    if (ph1.dedupOn && project.frames.length) await computeDedup(dedupStatus);
    await renderThumbs();
    void refreshPreview();
  }

  // refrescar listas de perfiles al volver a esta vista
  root.addEventListener('mxm:activated', () => {
    setOptions(curveSel, curveProfiles());
    setOptions(inkProfSel, inkProfiles());
    setOptions(printerSel, printerProfiles());
    refreshPresetList();
  });

  // ---------- proyecto de muestra ----------
  /** Un fotograma del ejemplo: pelota que rebota + cuadrado que gira, con el
   *  número grande para reconocerlo en la hoja impresa y en el escaneo. */
  function demoFrame(i: number, n: number): OffscreenCanvas {
    const w = 480, h = 270;
    const c = new OffscreenCanvas(w, h);
    const ctx = context2d(c);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    const t = n > 1 ? i / (n - 1) : 0;
    ctx.strokeStyle = '#BEB8A6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.8);
    ctx.lineTo(w, h * 0.8);
    ctx.stroke();
    ctx.fillStyle = '#17315C';
    ctx.beginPath();
    ctx.arc(58 + t * (w - 116), h * 0.8 - 28 - Math.abs(Math.sin(t * Math.PI * 1.5)) * h * 0.42, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(w - 74, 66);
    ctx.rotate(t * Math.PI);
    ctx.fillStyle = '#F0B429';
    ctx.fillRect(-24, -24, 48, 48);
    ctx.restore();
    ctx.fillStyle = '#201B14';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillText(String(i + 1), 20, 52);
    return c;
  }

  const DEMO_FRAMES = 6;
  const demoBtn = el('button', { class: 'btn ghost small', style: 'margin-top:8px' },
    `Try it with a ${DEMO_FRAMES}-frame example`);
  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    try {
      clearFrames();
      for (let i = 0; i < DEMO_FRAMES; i++) {
        const canvas = demoFrame(i, DEMO_FRAMES);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        project.frames.push({
          name: `demo_${String(i + 1).padStart(3, '0')}.png`,
          blob, thumb: null, w: canvas.width, h: canvas.height, hasAlpha: false,
        });
      }
      project.videoMeta = { origen: 'demo', fps_extraccion: 6 };
      // una sola hoja: el ejemplo se imprime, se escanea y se rearma entero
      Object.assign(s, { cols: 3, rows: 2, base_name: 'demo', out_name: 'demo', project_name: 'Demo' });
      ph1.include = ''; ph1.exclude = '';
      includeIn.value = ''; excludeIn.value = '';
      for (const b of binds) b();
      syncCustom();
      persist();
      pendingVideo = null;
      videoInfo.textContent = '';
      extractBtn.disabled = true;
      await afterFramesChanged();
      toast(`${DEMO_FRAMES} example frames ready. Press “Generate sheets”, then go to ② and simulate the scans: the whole loop without printing anything.`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Could not build the example: ${errMsg(e)}`, 'err');
    } finally {
      demoBtn.disabled = false;
    }
  });

  // ---------- marcadores: número (desplegable sobre un ajuste numérico) ----------
  // settingsForCore ya coerciona el valor; aquí se guarda como número desde
  // el principio para que el ajuste no cambie de tipo según el control
  const markerCountSel = select([['4', '4 (corners)'], ['8', '8 (recommended)'], ['12', '12 (maximum tolerance)']], String(s.marker_count));
  markerCountSel.addEventListener('change', () => {
    const v = parseInt(markerCountSel.value, 10);
    if (!Number.isNaN(v)) s.marker_count = v;
    persist(); void refreshPreview();
  });
  binds.push(() => { markerCountSel.value = String(s.marker_count); });

  // ---------- montaje ----------
  const paper = el('div', { class: 'paper' },
    el('h2', {}, '① Generate contact sheets'),
    el('div', { class: 'hint' }, 'From a video (or images) to printable sheets with registration markers.'),
    dz,
    demoBtn,
    videoInfo,
    el('div', { class: 'row tight', style: 'margin-top:8px' },
      field('Start (s)', startIn), field('End (s)', endIn), field('fps', fpsIn),
    ),
    allFrames.label,
    extractBtn, extractProg.root,

    el('h3', {}, 'Selection & names'),
    el('div', { class: 'row' },
      field('Include frames', includeIn), field('Exclude', excludeIn),
    ),
    field('Labels', namingSel),
    el('div', { class: 'row' },
      field('Base name', bindText('base_name', el('input', { type: 'text' }))),
      field('Separator', bindText('separator', el('input', { type: 'text' }))),
      field('Digits', bindNum('leading_zeros', numberInput(3, { min: 1, max: 8 }), { integer: true })),
      field('From', bindNum('start_index', numberInput(1, { min: 0 }), { integer: true })),
    ),
    field('Label numbering', numberingSel,
      'Applies to auto-increment labels. Sequential counts the selected frames; Original uses each frame’s '
      + 'position in the whole video. A repeated drawing printed once keeps its number, so gaps are expected.'),
    dedupCheck.label, dedupStatus,

    el('h3', {}, 'Sheet & grid'),
    el('div', { class: 'row' },
      field('Paper', paperSel),
      field('Orientation', bindSel('orientation', select(ORIENTATIONS, s.orientation))),
    ),
    customRow,
    el('div', { class: 'row' },
      field('Columns', bindNum('cols', numberInput(4, { min: 1, max: 20 }), { integer: true })),
      field('Rows', bindNum('rows', numberInput(5, { min: 1, max: 20 }), { integer: true })),
      field('DPI', bindNum('dpi', numberInput(300, { min: 72, max: 1200 }), { integer: true })),
    ),
    el('div', { class: 'row' },
      field('Margin (mm)', bindNum('margin_mm', numberInput(10, { min: 0 }))),
      field('Gutter (mm)', bindNum('gutter_mm', numberInput(5, { min: 0 }))),
      field('Font (pt)', bindNum('font_size_pt', numberInput(9, { min: 4 }))),
    ),

    el('h3', {}, 'Sheet number'),
    el('div', { class: 'row' },
      field('Position', bindSel('page_num_corner', select(CORNERS, s.page_num_corner))),
      field('Prefix', bindText('page_num_prefix', el('input', { type: 'text' }))),
      field('From', bindNum('page_num_start', numberInput(1, { min: 0 }), { integer: true })),
    ),
    field('Sheet numbering', pageNumberingSel,
      'Both start at “From”. Sequential numbers the sheets in output order. Original uses the position of each '
      + 'sheet’s first frame in the whole project, so excluded frames do not renumber later sheets.'),

    el('h3', {}, 'Registration (to scan back)'),
    bindCheck('registration_on', check('ArUco markers with per-sheet identity (required for phase ②)', s.registration_on)),
    el('div', { class: 'hint' }, 'Each sheet gets its own marker IDs: no QR codes needed, more room for the drawings.'),
    el('div', { class: 'row' },
      field('Markers', markerCountSel),
      field('Size (mm)', bindNum('marker_size_mm', numberInput(10, { min: 4, step: 0.5 }))),
      field('Margin (mm)', bindNum('marker_margin_mm', numberInput(4, { min: 1, step: 0.5 }))),
    ),
    field('Project name', bindText('project_name', el('input', { type: 'text', placeholder: '= output name' }))),
    (() => {
      const qrRow = el('div', { class: 'row' },
        field('QR size (mm)', bindNum('qr_size_mm', numberInput(10, { min: 6, step: 0.5 }))),
      );
      const c = check('Add a QR code per frame (for projects with MANY sheets)', !!s.qr_on);
      const sync = (): void => { qrRow.style.display = s.qr_on ? '' : 'none'; };
      c.input.addEventListener('change', () => { s.qr_on = c.input.checked; sync(); persist(); void refreshPreview(); });
      binds.push(() => { c.input.checked = !!s.qr_on; sync(); });
      sync();
      return el('div', {},
        c.label,
        el('div', { class: 'hint' }, 'Marker identity covers a limited number of sheets; the preview warns when a project exceeds it. QRs identify any number of sheets and keep desktop-app compatibility, at the cost of cell space.'),
        qrRow,
      );
    })(),
    bindCheck('gray_patch_on', check('Gray patch strip (scanner normalization)', s.gray_patch_on)),

    cyanBox,

    el('h3', {}, 'Printer'),
    field('Printer profile (Calibration tab)', printerSel, 'Corrects the measured scale of your printer.'),

    el('h3', {}, 'Output'),
    el('div', { class: 'row' },
      field('Output name', bindText('out_name', el('input', { type: 'text' }))),
      field('Sheets to generate', (() => {
        const i = el('input', { type: 'text', placeholder: 'e.g. 3, 5-7 (empty = all)' });
        i.value = ph1.sheets_include;
        i.addEventListener('change', () => { ph1.sheets_include = i.value; });
        return i;
      })()),
    ),
    el('div', { class: 'row', style: 'align-items:center; margin-top:4px' },
      el('div', { style: 'flex:0 0 auto; font-size:13.5px; font-weight:600' }, 'Formats:'),
      bindCheck('fmt_png', check('PNG (one per sheet)', s.fmt_png !== false)),
      bindCheck('fmt_pdf', check('PDF (print-ready)', s.fmt_pdf !== false)),
      bindCheck('fmt_tiff', check('TIFF', !!s.fmt_tiff)),
    ),
    el('div', { class: 'hint' }, 'layout.json, the map phase ② needs, is always included.'),
    (() => { const c = check('Keep a copy of the original frames (rescue sheets)', ph1.keepOriginals); c.input.addEventListener('change', () => { ph1.keepOriginals = c.input.checked; }); return c.label; })(),
    (() => { const c = check('Also export the individual frames', ph1.exportFrames); c.input.addEventListener('change', () => { ph1.exportFrames = c.input.checked; }); return c.label; })(),
    genBtn, genProg.root,
    warnBox,

    el('h3', {}, 'Presets'),
    presetsRow,
  );

  const bench = el('div', { class: 'bench' },
    el('h2', {}, 'Preview'),
    el('div', { class: 'preview-holder' },
      el('span', { class: 'preview-corner c1' }), el('span', { class: 'preview-corner c2' }),
      el('span', { class: 'preview-corner c3' }), el('span', { class: 'preview-corner c4' }),
      previewImg,
    ),
    el('div', { class: 'pagenav' }, prevBtn, pageLabel, nextBtn),
    el('div', { style: `display:${isCyanotype(s) ? '' : 'none'}` }, simulateToggle.label),
    previewInfo,
    framesInfo,
    thumbsGrid,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
}
