// Worker de procesamiento: aloja el núcleo Rust/WASM y atiende comandos.
// Cada worker tiene su propia memoria WASM: varios workers = escaneos en paralelo.
// Cada respuesta incluye `mem` (bytes de memoria WASM) y `pinned` (estado PDF
// vivo) para que el pool pueda reciclar workers hinchados sin perder nada.

import type { CommandName, Commands, WorkerRequest, WorkerResponse } from './commands.ts';
import { errMsg } from './errors.ts';
import type { Bytes, DecodedImage, RenderSheetOutput, ScanOutput } from './types.ts';
import type { InitOutput } from './wasm/mxm_core.js';
import init, * as core from './wasm/mxm_core.js';

// wasm-bindgen devuelve cada Vec<u8> como una copia sobre un ArrayBuffer
// propio, así que se puede transferir y meter en un Blob.
const bytes = (u8: Uint8Array): Bytes => u8 as Bytes;

let wasm: InitOutput | null = null;
// Si el .wasm no carga, cada comando falla con el error crudo del navegador
// ("expected application/wasm", "Failed to fetch"). La causa habitual es una
// pestaña abierta durante una publicación: su mxm_core_bg-<hash>.wasm ya no
// existe y el sitio devuelve HTML en su lugar. Se dice lo que hay que hacer.
const ready: Promise<string> = init().then(
  (exports) => {
    wasm = exports;
    return core.version();
  },
  (e: unknown) => {
    throw new Error(
      `The WebAssembly core could not load (${errMsg(e)}). Reload the page: this usually happens when the site was updated while this tab was open.`,
    );
  },
);

/** Un manejador devuelve el valor a secas, o {value, transfer} cuando hay
 *  buffers que mover en vez de copiar. */
interface Transferred<T> {
  value: T;
  transfer: Transferable[];
}

type Outcome<K extends CommandName> = Commands[K]['result'] | Transferred<Commands[K]['result']>;

/** Un manejador es síncrono (el núcleo lo es) salvo encode_frame, que espera
 *  al codificador PNG del navegador. */
type Handler<K extends CommandName> = (a: Commands[K]['args']) => Outcome<K> | Promise<Outcome<K>>;

type Handlers = { [K in CommandName]: Handler<K> };

let pdfInstance: core.Pdf | null = null;

function scanTransfer(r: ScanOutput): Transferable[] {
  const transfer: Transferable[] = [];
  for (const f of r.frames) transfer.push(f.png.buffer);
  for (const f of r.sin_identificar) transfer.push(f.png.buffer);
  if (r.overlay) transfer.push(r.overlay.buffer);
  return transfer;
}

const handlers: Handlers = {
  version: () => core.version(),
  compute_layout: (a) => core.compute_layout(a.settings, a.firstW, a.firstH),
  render_sheet: (a) => {
    const r = core.render_sheet(
      a.settings,
      a.firstW,
      a.firstH,
      a.meta,
      a.pixels ?? new Uint8Array(0),
      a.labels,
      a.sheetNum,
      a.render,
      a.finish ?? 'none',
      a.response ?? 'null',
    ) as RenderSheetOutput;
    return { value: r, transfer: r.png ? [r.png.buffer] : [] };
  },
  assemble_layout: (a) =>
    core.assemble_layout(
      a.settings,
      a.firstW,
      a.firstH,
      a.records,
      a.timeline,
      a.video,
      a.originalesDir ?? '',
    ),
  dedup_hashes: (a) => core.dedup_hashes(a.meta, a.pixels),
  group_duplicates: (a) => core.group_duplicates(a.hashes, a.threshold ?? 4),
  content_histogram: (a) => core.content_histogram(a.meta, a.pixels),
  effective_curve: (a) =>
    core.effective_curve(a.lut ?? 'null', a.strength ?? 100, a.adapt ?? 0, a.hist ?? 'null'),
  decode_image: (a) => {
    const r = core.decode_image(a.bytes) as DecodedImage;
    return { value: r, transfer: [r.rgba.buffer] };
  },
  scan_process: (a) => {
    const r = core.scan_process(
      a.bytes,
      a.name,
      a.layout,
      a.opts ?? '{}',
      a.claims ?? '{}',
    ) as ScanOutput;
    return { value: r, transfer: scanTransfer(r) };
  },
  scan_detect: (a) => core.scan_detect(a.rgba, a.w, a.h, a.name, a.layout, a.opts ?? '{}'),
  scan_finish: (a) => {
    const r = core.scan_finish(
      a.rgba,
      a.w,
      a.h,
      a.name,
      a.layout,
      a.opts ?? '{}',
      a.claims ?? '{}',
      a.state,
    ) as ScanOutput;
    return { value: r, transfer: scanTransfer(r) };
  },
  resize_rgba: (a) => {
    const out = bytes(core.resize_rgba(a.rgba, a.w, a.h, a.outW, a.outH));
    return { value: out, transfer: [out.buffer] };
  },
  encode_tiff: (a) => {
    const tif = bytes(core.encode_tiff(a.png));
    return { value: tif, transfer: [tif.buffer] };
  },
  printer_test_png: (a) => {
    const png = bytes(core.printer_test_png(a.paper, a.dpi));
    return { value: png, transfer: [png.buffer] };
  },
  analyze_printer_test: (a) => core.analyze_printer_test(a.bytes, a.paper, a.dpi, a.scanDpi ?? 0),
  cyan_strip_png: (a) => {
    const png = bytes(
      core.cyan_strip_png(
        a.paper,
        a.dpi,
        a.ink,
        a.mirror,
        a.target,
        a.stops ?? 'null',
        a.blockColor ?? '',
      ),
    );
    return { value: png, transfer: [png.buffer] };
  },
  analyze_cyan_strip: (a) =>
    core.analyze_cyan_strip(
      a.bytes,
      a.paper,
      a.dpi,
      a.target,
      a.ink ?? '',
      a.stops ?? 'null',
      a.blockColor ?? '',
    ),
  colorblocker_png: (a) => {
    const png = bytes(core.colorblocker_png(a.paper, a.dpi, a.mirror, a.blockColor ?? ''));
    return { value: png, transfer: [png.buffer] };
  },
  analyze_colorblocker: (a) => core.analyze_colorblocker(a.bytes, a.paper, a.dpi),
  // PNG y miniatura de un fotograma de video, fuera del hilo principal (ver
  // frames.ts). No pasa por el núcleo: el codificador PNG del navegador es
  // el mismo que usaba el hilo principal, y aquí corren varios a la vez. El
  // lienzo es opaco a propósito: un fotograma de video no tiene
  // transparencia, y un PNG RGB pesa un 20 % menos que el mismo en RGBA.
  encode_frame: async (a) => {
    const src = a.image;
    const w = 'rgba' in src ? src.w : src.width;
    const h = 'rgba' in src ? src.h : src.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create a 2D canvas context in the worker.');
    if ('rgba' in src) {
      if (src.rgba.byteLength !== w * h * 4) {
        throw new Error(
          `The video decoder returned ${src.rgba.byteLength} bytes for a ${w}×${h} frame (${w * h * 4} expected).`,
        );
      }
      const px = new Uint8ClampedArray(src.rgba.buffer, src.rgba.byteOffset, w * h * 4);
      ctx.putImageData(new ImageData(px, w, h), 0, 0);
    } else {
      ctx.drawImage(src, 0, 0);
      src.close();
    }
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const tw = Math.max(1, Math.round(a.thumbW));
    const th = Math.max(1, Math.round((h / w) * tw));
    const small = new OffscreenCanvas(tw, th);
    const sctx = small.getContext('2d');
    if (!sctx) throw new Error('Could not create a 2D canvas context in the worker.');
    sctx.drawImage(canvas, 0, 0, tw, th);
    const thumb = small.transferToImageBitmap();
    return { value: { png, thumb, w, h }, transfer: [thumb] };
  },
  // PDF con estado (una instancia por worker; el pool lo enruta al worker 0)
  pdf_new: (a) => {
    pdfInstance?.free(); // no filtrar una instancia anterior abandonada
    pdfInstance = new core.Pdf(a.dpi);
    return null;
  },
  pdf_add: (a) => {
    if (!pdfInstance) throw new Error('pdf_add without pdf_new');
    pdfInstance.add_page_png(a.png);
    return null;
  },
  pdf_finish: () => {
    if (!pdfInstance) throw new Error('pdf_finish without pdf_new');
    const pdf = bytes(pdfInstance.finish());
    pdfInstance = null;
    return { value: pdf, transfer: [pdf.buffer] };
  },
  // descarta un PDF a medias (generación fallida): sin esto, pinned=true
  // dejaría al worker 0 sin reciclar para siempre
  pdf_abort: () => {
    pdfInstance?.free();
    pdfInstance = null;
    return null;
  },
};

function isTransferred(out: unknown): out is Transferred<unknown> {
  return !!out && typeof out === 'object' && 'value' in out && 'transfer' in out;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = ev.data;
  try {
    await ready;
    const h = handlers[cmd] as ((a: unknown) => unknown) | undefined;
    if (!h) throw new Error(`Unknown command: ${cmd}`);
    const out = await h(args ?? {});
    const mem = wasm?.memory?.buffer?.byteLength ?? 0;
    const pinned = pdfInstance !== null;
    if (isTransferred(out)) {
      const reply: WorkerResponse = { id, ok: true, value: out.value, mem, pinned };
      self.postMessage(reply, out.transfer);
    } else {
      const reply: WorkerResponse = { id, ok: true, value: out, mem, pinned };
      self.postMessage(reply);
    }
  } catch (e) {
    const mem = wasm?.memory?.buffer?.byteLength ?? 0;
    const message = errMsg(e);
    // un panic de Rust (RuntimeError/unreachable) deja el módulo en estado
    // dudoso: se marca para que el pool recicle este worker al quedar ocioso
    const poisoned =
      e instanceof WebAssembly.RuntimeError || /unreachable|RuntimeError/.test(message);
    const reply: WorkerResponse = {
      id,
      ok: false,
      error: message,
      mem,
      pinned: pdfInstance !== null,
      poisoned,
    };
    self.postMessage(reply);
  }
};
