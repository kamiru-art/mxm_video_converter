// Motor de generación de hojas: comparte la fase ① y las hojas de rescate.
// Orquesta al núcleo WASM página a página para no cargar todos los
// fotogramas a resolución completa a la vez.

import { openOutput } from './opfs.ts';
import { recycleIdle, run, run0 } from './pool.ts';
import type { RgbaImage, VideoRef } from './project.ts';
import { isCyanotype } from './settings.ts';
import type { Bytes, LayoutInfo, Settings, TimelineItem, VideoMeta } from './types.ts';
import { context2d, sanitizeLabel, selectIndices } from './ui.ts';
import type { ZipEntryData, ZipSink } from './zip.ts';

const NUM_FIELDS = [
  'dpi',
  'custom_w_mm',
  'custom_h_mm',
  'margin_mm',
  'gutter_mm',
  'alpha_border_mm',
  'cols',
  'rows',
  'leading_zeros',
  'start_index',
  'font_size_pt',
  'label_gap_mm',
  'page_num_start',
  'page_num_zeros',
  'page_num_size_pt',
  'marker_count',
  'marker_size_mm',
  'marker_margin_mm',
  'qr_size_mm',
  'cyan_curve_strength',
  'cyan_adaptive',
  'cyan_clarity',
  'cyan_halo_mm',
  'cyan_frame_border_mm',
  'print_scale_x',
  'print_scale_y',
] as const;
const INT_FIELDS = new Set<string>([
  'dpi',
  'cols',
  'rows',
  'leading_zeros',
  'start_index',
  'page_num_start',
  'page_num_zeros',
  'marker_count',
]);

/** Serializa los ajustes para el núcleo (misma forma que el snapshot),
 *  coercionando números que la interfaz pudo dejar como strings. */
export function settingsForCore(s: Partial<Settings>): string {
  const out: Record<string, unknown> = { ...s };
  for (const k of NUM_FIELDS) {
    if (out[k] !== undefined && out[k] !== null) {
      const v = Number(out[k]);
      out[k] = INT_FIELDS.has(k) ? Math.round(v) : v;
    }
  }
  return JSON.stringify(out);
}

function zfill(n: number, digits: number): string {
  let out = String(n);
  while (out.length < digits) out = `0${out}`;
  return out;
}

/**
 * Resuelve la curva efectiva de cianotipia UNA vez por generación (fuerza +
 * adaptación al contenido) y devuelve ajustes listos con la curva cocinada.
 */
export async function resolveCyanCurve<T extends Partial<Settings>>(
  settings: T,
  thumbFrames: OffscreenCanvas[],
): Promise<T> {
  const s = { ...settings };
  if (!isCyanotype(s)) return s;
  let hist = 'null';
  if ((s.cyan_adaptive ?? 0) > 0 && thumbFrames.length) {
    const { meta, pixels } = packThumbs(thumbFrames.slice(0, 200));
    hist = await run('content_histogram', { meta, pixels }, [pixels.buffer]);
  }
  const lut = await run('effective_curve', {
    lut: JSON.stringify(s.cyan_curve ?? null),
    strength: s.cyan_curve_strength ?? 100,
    adapt: s.cyan_adaptive ?? 0,
    hist,
  });
  s.cyan_curve = JSON.parse(lut) as number[] | null;
  s.cyan_curve_strength = 100.0;
  s.cyan_adaptive = 0.0;
  return s;
}

/** Meta de un fotograma dentro del buffer empaquetado (lo lee el núcleo). */
interface PackedMeta {
  w: number;
  h: number;
  has_alpha: boolean;
  orig_name: string;
  orig_file?: string | null;
  /** Posición en `pixels`; -1 cuando el fotograma va sin píxeles (hoja no
   *  seleccionada: solo se mide). */
  offset: number;
}

export interface PackedPixels {
  meta: string;
  pixels: Bytes;
}

/** Empaqueta miniaturas (OffscreenCanvas) como buffer RGBA + meta JSON. */
export function packThumbs(canvases: OffscreenCanvas[]): PackedPixels {
  let total = 0;
  const metas: PackedMeta[] = [];
  const datas: Uint8ClampedArray[] = [];
  for (const c of canvases) {
    const d = context2d(c).getImageData(0, 0, c.width, c.height);
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

/** Un fotograma ya decodificado para empaquetar; `data` nulo = solo medir. */
export interface PackItem {
  data: Bytes | Uint8ClampedArray | null;
  w: number;
  h: number;
  hasAlpha: boolean;
  origName?: string;
  origFile?: string | null;
}

/** Empaqueta ImageData ya decodificados. */
export function packImageData(items: PackItem[]): PackedPixels {
  let total = 0;
  const metas: PackedMeta[] = [];
  for (const it of items) {
    metas.push({
      w: it.w,
      h: it.h,
      has_alpha: !!it.hasAlpha,
      orig_name: it.origName ?? '',
      orig_file: it.origFile ?? null,
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

/** Un fotograma A IMPRIMIR (representante), tal como lo entrega la fase ①,
 *  el rescate o la prueba de punta a punta. */
export interface GenFrame {
  name: string;
  w: number;
  h: number;
  hasAlpha: boolean;
  /** El archivo original, para la copia de `_frames/`; nulo si no hay. */
  blob: Blob | null;
  getImageData: (full: boolean) => Promise<RgbaImage>;
  /** Fotograma que vive en su video (ProjectFrame.video): `prefetch` lo
   *  decodifica con los demás de su página. */
  video?: VideoRef;
  /** Sin `blob`: produce el PNG para `_frames/` al armar el ZIP, y solo
   *  entonces. */
  encodePng?: () => Promise<Blob>;
}

export interface GenerateArgs {
  settings: Settings;
  /** Solo los fotogramas a imprimir (representantes), en orden. */
  frames: GenFrame[];
  /** Etiquetas paralelas a `frames`. */
  labels: string[];
  /** Número de hoja por página, o null = continuo. */
  pageNumbers?: number[] | null;
  timeline?: TimelineItem[];
  videoMeta?: VideoMeta;
  /** Incluir cada fotograma como archivo en `<nombre>_frames/`. Es UNA
   *  cosa: la fase ② los necesita para las hojas de rescate (el layout apunta
   *  a ellos) y de paso quedan para cualquier otro uso. Antes eran dos
   *  opciones, "originals" y "export", que escribían los mismos archivos dos
   *  veces y nadie sabía distinguir. */
  includeFrames?: boolean;
  /** Antes de cada página seleccionada, con sus fotogramas: decodificar
   *  de golpe los que viven en un video (project.ts). */
  prefetch?: (frames: GenFrame[]) => Promise<void>;
  /** Con un ZipSink, cada archivo entra en el ZIP en cuanto existe (hoja
   *  a hoja) y `files` queda vacío; sin él, todo se devuelve en `files`
   *  para que quien llama lo empaquete (hojas de rescate, pruebas). */
  sink?: ZipSink;
  onProgress?: (done: number, total: number, note: string) => void;
}

export interface GenerateResult {
  /** Vacío cuando se dio un `sink`. */
  files: Map<string, ZipEntryData>;
  /** El ZIP terminado, cuando se dio un `sink`. */
  zip?: Blob;
  /** PNG de cada hoja generada (solo proyectos cortos, para simular escaneos). */
  sheetImages: Map<string, Blob>;
  layoutJson: string | null;
  avisos: string[];
  numPages: number;
  layoutInfo: LayoutInfo;
}

// Las generaciones se serializan: el PDF vive como estado en el worker 0 y
// dos generaciones a la vez (fase ① y hojas de rescate) entrelazarían páginas.
let genLock: Promise<unknown> = Promise.resolve();

/** Hasta cuántas hojas se guardan en memoria para los escaneos de prueba. */
const DEMO_SHEET_LIMIT = 8;

export function generateSheets(args: GenerateArgs): Promise<GenerateResult> {
  const run_ = genLock.then(() => generateSheetsInner(args));
  genLock = run_.catch(() => {});
  return run_;
}

/** Nombre único dentro de una carpeta del ZIP: `base`, `base_2`, `base_3`… */
function uniqueName(base: string, used: Set<string>): string {
  let cand = base,
    n = 1;
  while (used.has(cand)) {
    n += 1;
    cand = `${base}_${n}`;
  }
  used.add(cand);
  return cand;
}

async function generateSheetsInner({
  settings,
  frames,
  labels,
  pageNumbers = null,
  timeline = [],
  videoMeta = {},
  includeFrames = true,
  prefetch = async () => {},
  sink,
  onProgress = () => {},
}: GenerateArgs): Promise<GenerateResult> {
  const s: Settings = { ...settings };
  if (!s.fmt_png && !s.fmt_pdf && !s.fmt_tiff) s.fmt_png = true; // algo hay que exportar
  const safeName = sanitizeLabel(s.out_name || 'hojas');
  const perPage = Math.max(1, s.cols * s.rows);
  const numPages = Math.max(1, Math.ceil(frames.length / perPage));
  const firstW = frames[0]?.w ?? 16;
  const firstH = frames[0]?.h ?? 9;

  const files = new Map<string, ZipEntryData>();
  const sheetImages = new Map<string, Blob>();
  const originalesDir = includeFrames ? `${safeName}_frames` : '';
  // al ZIP en cuanto existe, o a `files` para quien empaqueta después
  const emit = async (name: string, data: ZipEntryData): Promise<void> => {
    if (sink) await sink.add(name, data);
    else files.set(name, data);
  };

  // los fotogramas como archivos; la ruta de cada uno va al layout, en el
  // registro del fotograma, y es lo que la fase ② busca para el rescate. Se
  // nombran ahora y se escriben al final, detrás de las hojas
  const origFiles: (string | undefined)[] = frames.map(() => undefined);
  const frameEntries: [string, ZipEntryData][] = [];
  if (originalesDir) {
    const usados = new Set<string>();
    for (let i = 0; i < frames.length; i++) {
      const cand = uniqueName(sanitizeLabel(labels[i]), usados);
      // una imagen de carpeta conserva su formato; un fotograma de video es PNG
      const ext = frames[i].blob
        ? (frames[i].name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase()
        : '.png';
      const data: ZipEntryData | undefined = frames[i].blob ?? frames[i].encodePng;
      if (data) {
        const path = `${originalesDir}/${cand}${ext}`;
        frameEntries.push([path, data]);
        origFiles[i] = path;
      }
    }
  }

  // hojas seleccionadas
  const pagesSelected = new Set(
    selectIndices(numPages, s.sheets_include ?? '', s.sheets_exclude ?? ''),
  );
  const pnumOf = (k: number): number =>
    pageNumbers && k < pageNumbers.length ? pageNumbers[k] : (s.page_num_start ?? 1) + k;
  const maxPnum = Math.max(1, ...Array.from({ length: numPages }, (_, k) => pnumOf(k)));
  const fileDigits = Math.max(s.page_num_zeros ?? 1, String(maxPnum).length);

  if (s.fmt_pdf) await run0('pdf_new', { dpi: s.dpi });
  // el PDF llega por bloques (uno por página y el cierre) y se escribe a un
  // archivo de salida según llega: ni el núcleo ni la pestaña retienen páginas
  const pdfOut = s.fmt_pdf
    ? await openOutput(`${safeName}-${Date.now()}.pdf`, 'application/pdf')
    : null;

  const records: Record<string, unknown>[] = [];
  let done = 0;
  // la barra cuenta hojas Y archivos de fotogramas: con un sink, escribirlos
  // es la segunda mitad del trabajo, y antes la barra estaba al 100 % ahí
  const totalSel = Math.max(1, pagesSelected.size + (sink ? frameEntries.length : 0));
  const coreSettings = settingsForCore(s);

  try {
    for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
      const chunkStart = pageIdx * perPage;
      const chunk = frames.slice(chunkStart, chunkStart + perPage);
      const chunkLabels = labels.slice(chunkStart, chunkStart + perPage);
      const selected = pagesSelected.has(pageIdx + 1);
      const pnum = pnumOf(pageIdx);
      const pageBase = `${safeName}_p${zfill(pnum, fileDigits)}`;

      if (selected) {
        onProgress(done, totalSel, `sheet ${pnum}: decoding ${chunk.length} frame(s)…`);
        await prefetch(chunk);
      }
      const items: PackItem[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const f = chunk[j];
        const origFile = origFiles[chunkStart + j];
        if (selected) {
          const d = await f.getImageData(true);
          items.push({
            data: d.data,
            w: d.w,
            h: d.h,
            hasAlpha: f.hasAlpha,
            origName: f.name,
            origFile,
          });
        } else {
          items.push({
            data: null,
            w: f.w,
            h: f.h,
            hasAlpha: f.hasAlpha,
            origName: f.name,
            origFile,
          });
        }
      }
      const { meta, pixels } = packImageData(items);
      const res = await run(
        'render_sheet',
        {
          settings: coreSettings,
          firstW,
          firstH,
          meta,
          pixels,
          labels: JSON.stringify(chunkLabels),
          sheetNum: pnum,
          render: selected,
          finish: 'final',
        },
        [pixels.buffer],
      );

      const record: unknown = JSON.parse(res.record);
      if (record && typeof record === 'object') {
        const rec = record as Record<string, unknown>;
        rec.archivo_hoja = `${pageBase}.png`;
        rec.generada = selected;
        records.push(rec);
      }
      if (selected && res.png) {
        if (pdfOut) await pdfOut.write(await run0('pdf_add', { png: res.png }));
        if (s.fmt_tiff) {
          const tif = await run('encode_tiff', { png: res.png });
          await emit(`${pageBase}.tif`, new Blob([tif], { type: 'image/tiff' }));
        }
        // como Blob: el navegador puede sacarlo del heap de JS hasta el ZIP
        const sheetBlob = new Blob([res.png], { type: 'image/png' });
        if (s.fmt_png) await emit(`${pageBase}.png`, sheetBlob);
        // proyectos cortos: se retienen para poder simular escaneos en la
        // fase ② sin imprimir (en uno largo serían cientos de megas)
        if (numPages <= DEMO_SHEET_LIMIT) sheetImages.set(`${pageBase}.png`, sheetBlob);
        done++;
        onProgress(done, totalSel, `sheet ${pnum} ready`);
      }
    }

    if (pdfOut) {
      await pdfOut.write(await run0('pdf_finish', {}));
      await emit(`${safeName}.pdf`, await pdfOut.close());
    }
  } catch (e) {
    // sin esto, un fallo a mitad de generación dejaría el PDF a medias vivo
    // en el worker 0 (pinned para siempre, memoria retenida), y su archivo
    // de salida a medias en el disco
    if (s.fmt_pdf) await run0('pdf_abort', {}).catch(() => {});
    await pdfOut?.abort();
    throw e;
  }

  let layoutJson: string | null = null;
  if (s.registration_on && records.length) {
    layoutJson = await run('assemble_layout', {
      settings: coreSettings,
      firstW,
      firstH,
      records: JSON.stringify(records),
      timeline: JSON.stringify(timeline),
      video: JSON.stringify(videoMeta),
      originalesDir,
    });
    await emit(`${safeName}_layout.json`, new TextEncoder().encode(layoutJson));
  }

  // los fotogramas, al final: con un sink es la parte larga del empaquetado
  // (los de video se codifican ahora, en los workers)
  const sheetsDone = done;
  for (let i = 0; i < frameEntries.length; i++) {
    const [name, data] = frameEntries[i];
    await emit(name, data);
    if (sink && (i % 10 === 9 || i === frameEntries.length - 1)) {
      onProgress(sheetsDone + i + 1, totalSel, `frame files ${i + 1}/${frameEntries.length}`);
    }
  }
  const zip = sink ? await sink.finish() : undefined;

  const layoutInfo = JSON.parse(
    await run('compute_layout', { settings: coreSettings, firstW, firstH }),
  ) as LayoutInfo;
  recycleIdle(); // devolver al sistema la memoria WASM que infló la generación
  return {
    files,
    zip,
    sheetImages,
    layoutJson,
    avisos: layoutInfo.avisos ?? [],
    numPages,
    layoutInfo,
  };
}
