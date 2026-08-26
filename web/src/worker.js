// Worker de procesamiento: aloja el núcleo Rust/WASM y atiende comandos.
// Cada worker tiene su propia memoria WASM: varios workers = escaneos en paralelo.
import init, * as core from './wasm/mxm_core.js';

let ready = init().then(() => core.version());

const handlers = {
  version: () => core.version(),
  compute_layout: (a) => core.compute_layout(a.settings, a.firstW, a.firstH),
  render_sheet: (a) => {
    const r = core.render_sheet(
      a.settings, a.firstW, a.firstH, a.meta, a.pixels ?? new Uint8Array(0),
      a.labels, a.sheetNum, a.render, a.finish ?? 'none', a.response ?? 'null',
    );
    return { value: r, transfer: r.png ? [r.png.buffer] : [] };
  },
  assemble_layout: (a) =>
    core.assemble_layout(a.settings, a.firstW, a.firstH, a.records, a.timeline, a.video, a.originalesDir ?? ''),
  dedup_hashes: (a) => core.dedup_hashes(a.meta, a.pixels),
  group_duplicates: (a) => core.group_duplicates(a.hashes, a.threshold ?? 4),
  content_histogram: (a) => core.content_histogram(a.meta, a.pixels),
  effective_curve: (a) => core.effective_curve(a.lut ?? 'null', a.strength ?? 100, a.adapt ?? 0, a.hist ?? 'null'),
  decode_image: (a) => {
    const r = core.decode_image(a.bytes);
    return { value: r, transfer: [r.rgba.buffer] };
  },
  scan_process: (a) => {
    const r = core.scan_process(a.bytes, a.name, a.layout, a.opts ?? '{}', a.claims ?? '{}');
    const transfer = [];
    for (const f of r.frames) transfer.push(f.png.buffer);
    for (const f of r.sin_identificar) transfer.push(f.png.buffer);
    if (r.overlay) transfer.push(r.overlay.buffer);
    return { value: r, transfer };
  },
  printer_test_png: (a) => {
    const png = core.printer_test_png(a.paper, a.dpi);
    return { value: png, transfer: [png.buffer] };
  },
  analyze_printer_test: (a) => core.analyze_printer_test(a.bytes, a.paper, a.dpi, a.scanDpi ?? 0),
  cyan_strip_png: (a) => {
    const png = core.cyan_strip_png(a.paper, a.dpi, a.ink, a.mirror, a.target, a.stops ?? 'null', a.blockColor ?? '');
    return { value: png, transfer: [png.buffer] };
  },
  analyze_cyan_strip: (a) =>
    core.analyze_cyan_strip(a.bytes, a.paper, a.dpi, a.target, a.ink ?? '', a.stops ?? 'null', a.blockColor ?? ''),
  colorblocker_png: (a) => {
    const png = core.colorblocker_png(a.paper, a.dpi, a.mirror, a.blockColor ?? '');
    return { value: png, transfer: [png.buffer] };
  },
  analyze_colorblocker: (a) => core.analyze_colorblocker(a.bytes, a.paper, a.dpi),
  // PDF con estado (una instancia por worker; el pool lo enruta al worker 0)
  pdf_new: (a) => { pdfInstance = new core.Pdf(a.dpi); return null; },
  pdf_add: (a) => { pdfInstance.add_page_png(a.png); return null; },
  pdf_finish: () => {
    const bytes = pdfInstance.finish();
    pdfInstance = null;
    return { value: bytes, transfer: [bytes.buffer] };
  },
};

let pdfInstance = null;

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    await ready;
    const h = handlers[cmd];
    if (!h) throw new Error(`Comando desconocido: ${cmd}`);
    const out = h(args ?? {});
    if (out && typeof out === 'object' && 'value' in out && 'transfer' in out) {
      self.postMessage({ id, ok: true, value: out.value }, out.transfer);
    } else {
      self.postMessage({ id, ok: true, value: out });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
