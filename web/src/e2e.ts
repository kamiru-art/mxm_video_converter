// Prueba de punta a punta EN EL NAVEGADOR: hoja → "escaneo" girado →
// procesado → frames recuperados. Verifica el núcleo WASM + workers + glue.

import { errMsg, isCancelled } from './errors.ts';
import type { GenFrame } from './gen.ts';
import { generateSheets, packImageData, settingsForCore } from './gen.ts';
import { run } from './pool.ts';
import type { RgbaImage } from './project.ts';
import { defaultSettings } from './settings.ts';
import type { Bytes, DetectOutput, Layout, PrinterProfile, ScanResult, Settings } from './types.ts';
import { context2d } from './ui.ts';

const logEl = document.getElementById('log');
if (!logEl) throw new Error('Missing #log in e2e.html');
const logNode: HTMLElement = logEl;
const lines: string[] = [];
function log(s: string): void {
  lines.push(s);
  logNode.textContent = lines.join('\n');
  console.log('[E2E]', s);
}

// Lo que e2e-run.mts vuelca en artifacts/e2e/: los pasos del log y el
// SHA-256 de las salidas que no dependen del reloj ni de un codificador del
// navegador (hojas, PDF, TIFF, layout, recortes del núcleo). Mismas entradas,
// mismos bytes: dos corridas en la misma máquina dan el mismo informe. Los
// videos codificados quedan fuera; de ellos cuenta lo que se comprueba.
const outputs: Record<string, string> = {};
/** Archivos que el runner saca de la página para verificarlos por fuera
 *  (con el ffmpeg de la máquina, no con el código que los escribió). */
const e2eFiles: Record<string, Blob> = {};
/** Qué fuente es cada fotograma del video sin pérdida, en orden. */
const lossless: { sequence: string[] } = { sequence: [] };
(globalThis as { e2eFiles?: unknown }).e2eFiles = e2eFiles;
// las violaciones de CSP, oídas por la propia página: Safari no deja leer
// su consola desde fuera, y así los tres navegadores las cuentan igual
const csp: string[] = [];
(globalThis as { e2eReport?: unknown }).e2eReport = { steps: lines, outputs, lossless, csp };
document.addEventListener('securitypolicyviolation', (e) => {
  csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
});
async function digest(name: string, data: Uint8Array | Blob | string): Promise<void> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : data.slice();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  outputs[name] = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** [ancho, alto, bits por canal] de un PNG, de su IHDR. */
function pngHeader(png: Uint8Array): [number, number, number] {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [dv.getUint32(16), dv.getUint32(20), png[24]];
}

function synthFrame(w: number, h: number, base: [number, number, number]): RgbaImage {
  const c = new OffscreenCanvas(w, h);
  const ctx = context2d(c);
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'white';
  for (let i = -h; i < w; i += 40) {
    ctx.save();
    ctx.translate(i, 0);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(0, 0, 8, h * 2);
    ctx.restore();
  }
  const d = ctx.getImageData(0, 0, w, h);
  return { data: new Uint8Array(d.data.buffer), w, h };
}

/** PNG (RGBA 8 bits, deflate del navegador) SIN pasar por un Blob: ver
 *  stressExport. */
async function encodePng(img: ImageData): Promise<Bytes> {
  return encodePngRaw(img.width, img.height, 8, 6, img.data);
}

/** PNG de `depth` bits (8 o 16) y tipo de color `colour` (2 RGB, 6 RGBA)
 *  a partir de las muestras crudas, en big-endian si son de 16 bits: el
 *  navegador no sabe escribir PNG de 16 bits, y la prueba los necesita. */
async function encodePngRaw(
  w: number,
  h: number,
  depth: 8 | 16,
  colour: 2 | 6,
  samples: ArrayLike<number>,
): Promise<Bytes> {
  const ch = colour === 6 ? 4 : 3;
  const rowBytes = (w * ch * depth) / 8;
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w * ch; x++) {
      const v = samples[y * w * ch + x];
      if (depth === 16) {
        raw[y * (rowBytes + 1) + 1 + x * 2] = v >> 8;
        raw[y * (rowBytes + 1) + 2 + x * 2] = v & 255;
      } else raw[y * (rowBytes + 1) + 1 + x] = v;
    }
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  void writer.write(raw);
  void writer.close();
  const zParts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    zParts.push(value);
  }
  const z = new Uint8Array(zParts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of zParts) {
    z.set(p, off);
    off += p.length;
  }
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([depth, colour, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

/** Prueba de CARGA de la exportación sin pérdida, aparte de la suite (no
 *  corre en CI: son minutos): `e2e.html?stress=export&frames=180&w=2160&h=3840`
 *  (`kind=frames` para el ZIP de PNG en vez del MOV)
 *  hace fotogramas sintéticos distintos entre sí de ese tamaño y los
 *  exporta como haría la fase ④, por trozos y al disco privado. El
 *  proyecto Old Fires (180 fotogramas 4K, 1.6 GB estimados) es lo que
 *  antes se rechazaba. `audio=1` añade el sonido de la muestra. El MOV
 *  queda en `globalThis.e2eOutput` para sacarlo con puppeteer y pasarlo
 *  por ffprobe o AVFoundation. */
async function stressExport(params: URLSearchParams): Promise<void> {
  const { storeProcessedFrame, clearProcessedCache } = await import('./opfs.ts');
  await clearProcessedCache();
  const n = parseInt(params.get('frames') ?? '180', 10);
  const w = parseInt(params.get('w') ?? '2160', 10);
  const h = parseInt(params.get('h') ?? '3840', 10);
  const fps = parseFloat(params.get('fps') ?? '12');
  // `vary`: fotogramas de tamaños que difieren en 1–2 px, como los recortes
  // de escaneos de verdad. Fuerza el camino de recomposición (el passthrough
  // no se toca) y con él conform_frame
  const vary = !!params.get('vary');
  const frames: Blob[] = [];
  let pngBytes = 0;
  for (let i = 0; i < n; i++) {
    const fw = vary ? w - (i % 3) : w;
    const fh = vary ? h - ((i + 1) % 3) : h;
    const c = new OffscreenCanvas(fw, fh);
    const ctx = context2d(c);
    // un degradado que gira, texto y unos discos: contenido distinto en
    // cada fotograma, con detalle suficiente para que ProRes no lo regale
    const g = ctx.createLinearGradient(0, 0, fw, fh);
    g.addColorStop(0, `hsl(${(i * 7) % 360} 70% 60%)`);
    g.addColorStop(1, `hsl(${(i * 7 + 180) % 360} 70% 30%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, fw, fh);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let k = 0; k < 40; k++) {
      const a = (i / n) * Math.PI * 2 + k * 0.4;
      ctx.beginPath();
      ctx.arc(
        fw / 2 + Math.cos(a) * (fw / 3),
        fh / 2 + Math.sin(a) * (fh / 3),
        20 + k * 3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.fillStyle = 'black';
    ctx.font = `${Math.round(fh / 12)}px sans-serif`;
    ctx.fillText(`frame ${i + 1}`, fw / 10, fh / 2);
    // a disco como BYTES, igual que los recortes de la fase ②: un Blob de
    // convertToBlob cuenta contra el cupo de Blobs de Chrome (~500 MB en
    // total) hasta que el recolector lo suelta, y pasado el cupo los
    // siguientes ya no se pueden leer (ver opfs.ts)
    const blob = await storeProcessedFrame(
      `stress_${i + 1}`,
      await encodePng(ctx.getImageData(0, 0, fw, fh)),
    );
    frames.push(blob);
    pngBytes += blob.size;
    if ((i + 1) % 20 === 0) log(`… ${i + 1}/${n} fotogramas ${w}×${h} listos`);
  }
  log(`${n} fotogramas ${w}×${h}: ${(pngBytes / 1e6).toFixed(0)} MB de PNG`);
  let audio: { file: File; start: number } | undefined;
  if (params.get('audio')) {
    // `asrc=big`: un clip de 60 s y 117 MB, como el original de un proyecto
    // de verdad, en vez de la muestra de 3 s de la suite
    const name = params.get('asrc') === 'big' ? 'e2e_big_audio.mp4' : 'e2e_sample_audio.mp4';
    const aresp = await fetch(`/${name}`);
    if (!aresp.ok) throw new Error(`no audio sample: ${name}`);
    audio = {
      file: new File([await aresp.arrayBuffer()], name, { type: 'video/mp4' }),
      start: parseFloat(params.get('astart') ?? '0.5'),
    };
    log(`audio: ${name}, ${(audio.file.size / 1e6).toFixed(0)} MB, desde ${audio.start} s`);
  }
  const { exportLossless } = await import('./export.ts');
  const kind = params.get('kind') === 'frames' ? 'frames' : 'mov';
  const t0 = performance.now();
  let lastPct = -1;
  const out = await exportLossless(frames, fps, {
    kind,
    audio,
    onProgress: (stage, d, t) => {
      const pct = Math.floor((t ? d / t : 1) * 10) * 10;
      if (pct !== lastPct || stage !== 'writing') {
        lastPct = pct;
        log(`… ${stage} ${pct} % a los ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
    },
  });
  const secs = (performance.now() - t0) / 1000;
  const blob = new Blob([out.bytes], { type: out.mime });
  (globalThis as { e2eOutput?: Blob; e2eFrames?: Blob[] }).e2eOutput = blob;
  (globalThis as { e2eOutput?: Blob; e2eFrames?: Blob[] }).e2eFrames = frames;
  log(
    `${kind} sin pérdida: ${(blob.size / 1e6).toFixed(0)} MB en ${secs.toFixed(0)} s (${(secs / n).toFixed(2)} s por fotograma), ${out.bytes instanceof Blob ? 'en disco' : 'en memoria'}${out.audio ? ', con audio' : ''}`,
  );
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) log(`heap JS usado: ${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB`);
  if (audio && !out.audio) throw new Error('the export dropped the audio track');
  log(
    `plan: ${out.plan.w}×${out.plan.h}, ${out.plan.sixteen ? 16 : 8} bits, ${out.plan.passthrough} tal cual, ${out.plan.conform} conformados`,
  );
  if (kind === 'frames') return;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const sink = new mb.EncodedPacketSink(track);
    let count = 0;
    let bytes = 0;
    let last = -1;
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      if (p.timestamp <= last) throw new Error('packets out of order');
      last = p.timestamp;
      count++;
      bytes += p.byteLength;
    }
    const dur = await track.computeDuration();
    if (audio) {
      const at = await input.getPrimaryAudioTrack();
      if (!at) throw new Error('the MOV has no audio track');
      const adur = await at.computeDuration();
      log(
        `audio del MOV: ${at.codec} ${at.numberOfChannels} ch a ${at.sampleRate} Hz, ${adur.toFixed(3)} s`,
      );
      if (Math.abs(adur - n / fps) > 0.05)
        throw new Error(`audio lasts ${adur.toFixed(3)} s, video ${(n / fps).toFixed(3)} s`);
    }
    // mediabunny no conoce el códec PNG (codec null) pero lee la tabla de
    // muestras igual: cuenta, tamaños y tiempos
    log(
      `MOV: png ${track.codedWidth}×${track.codedHeight}, ${count} fotogramas (${(bytes / 1e6).toFixed(0)} MB de video), ${dur.toFixed(3)} s`,
    );
    const pngBytesTotal = frames.reduce((a, f) => a + f.size, 0);
    if (count !== n || Math.abs(dur - n / fps) > 0.01)
      throw new Error(`MOV is wrong: ${count} frames, ${dur.toFixed(3)} s`);
    // sin `vary` los PNG entran tal cual (passthrough): en muestras, el MOV
    // pesa exactamente lo que ellos. Con `vary` se conforman y pesan otra cosa
    if (!vary && bytes !== pngBytesTotal)
      throw new Error(`PNG samples total ${bytes} bytes, source PNGs ${pngBytesTotal}`);
  } finally {
    input.dispose();
  }
}

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('stress') === 'export') {
      try {
        await stressExport(params);
      } catch (e) {
        // dónde falló, no sólo qué: son minutos por intento
        if (e instanceof Error && e.stack) log(e.stack);
        throw e;
      }
      document.title = 'E2E-OK';
      log('✅ STRESS OK');
      return;
    }
    const v = await run('version', {});
    log(`wasm ${v} cargado`);

    // fase ①: generar una hoja con 4 frames sintéticos (SIN QR: la identidad
    // va en los IDs de los marcadores — el camino por defecto actual)
    const s: Settings = {
      ...defaultSettings(),
      dpi: 150,
      cols: 2,
      rows: 2,
      project_name: 'e2e',
      out_name: 'e2e',
      marker_size_mm: 10,
      fmt_tiff: true,
    };
    const colors: [number, number, number][] = [
      [200, 60, 60],
      [60, 180, 60],
      [60, 60, 200],
      [180, 160, 40],
    ];
    const frames: GenFrame[] = colors.map((c, i) => {
      const fd = synthFrame(320, 180, c);
      return {
        name: `f${i}.png`,
        w: 320,
        h: 180,
        hasAlpha: false,
        blob: null,
        getImageData: async () => fd,
      };
    });
    const labels = ['e2e_001', 'e2e_002', 'e2e_003', 'e2e_004'];
    const out = await generateSheets({
      settings: s,
      frames,
      labels,
      timeline: labels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
      videoMeta: { fps_extraccion: 4 },
      includeFrames: false,
    });
    const sheetBlob = out.files.get('e2e_p1.png');
    if (!sheetBlob || !(sheetBlob instanceof Blob)) throw new Error('sheet was not generated');

    // cancelar: una señal ya abortada corta antes de la primera hoja; abortar
    // al terminar la primera corta antes de la segunda. Sale como
    // CancelledError, no como fallo, y la generación siguiente funciona
    const expectCancelled = async (p: Promise<unknown>, what: string): Promise<void> => {
      try {
        await p;
      } catch (e) {
        if (isCancelled(e)) return;
        throw new Error(`${what}: ${errMsg(e)}`);
      }
      throw new Error(`${what}: did not cancel`);
    };
    const pre = new AbortController();
    pre.abort();
    await expectCancelled(
      generateSheets({ settings: s, frames, labels, includeFrames: false, signal: pre.signal }),
      'generateSheets with an aborted signal',
    );
    const mid = new AbortController();
    let sheetsReady = 0;
    await expectCancelled(
      generateSheets({
        settings: { ...s, cols: 1, rows: 1, fmt_pdf: false, fmt_tiff: false },
        frames,
        labels,
        includeFrames: false,
        signal: mid.signal,
        onProgress: (_d, _t, note) => {
          if (/ready$/.test(note)) {
            sheetsReady++;
            mid.abort();
          }
        },
      }),
      'generateSheets aborted after the first sheet',
    );
    if (sheetsReady !== 1)
      throw new Error(`cancel: ${sheetsReady} sheets were made before stopping`);
    log('cancelar la generación: antes de empezar y tras la primera hoja ✓');
    const tif = out.files.get('e2e_p1.tif');
    if (!(tif instanceof Blob) || !tif.size) throw new Error('TIFF export missing');
    const sheetPng = new Uint8Array(await sheetBlob.arrayBuffer());
    if (!out.layoutJson) throw new Error('layout was not generated');
    const layoutJson = out.layoutJson;
    const layoutObj = JSON.parse(layoutJson) as Layout;
    if (!layoutObj.marcadores?.ids_por_hoja)
      throw new Error('layout without ids_por_hoja (no-QR identity)');
    // el PDF sale por bloques: cabecera al principio, cierre al final, y la
    // xref tiene que apuntar a cada objeto (lo comprueba el test de Rust; aquí
    // que la concatenación de los bloques sea un archivo entero)
    const pdfBlob = out.files.get('e2e.pdf');
    if (!(pdfBlob instanceof Blob)) throw new Error('PDF missing');
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);
    if (!pdfText.startsWith('%PDF-1.5') || !pdfText.endsWith('%%EOF\n'))
      throw new Error('PDF is not a whole file');
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdfText)?.[1]);
    if (pdfText.slice(startxref, startxref + 5) !== 'xref\n')
      throw new Error(`PDF startxref (${startxref}) does not point at the xref table`);
    if (!/\/Predictor 15 \/Colors 3/.test(pdfText))
      throw new Error('PDF page is not the sheet PNG stream');
    await digest('sheet/e2e_p1.png', sheetPng);
    await digest('sheet/e2e.pdf', pdfBytes);
    await digest('sheet/e2e_p1.tif', tif);
    await digest('sheet/layout.json', layoutJson);
    log(
      `hoja generada (${sheetPng.length} bytes), PDF: ${pdfBytes.length} bytes con xref en ${startxref}, TIFF ok, layout: ids_por_hoja ✓`,
    );

    // "escanear": dibujar la hoja rotada 2° sobre un lienzo mayor
    const bmp = await createImageBitmap(sheetBlob);
    const sc = new OffscreenCanvas(Math.round(bmp.width * 1.3), Math.round(bmp.height * 1.25));
    const sctx = context2d(sc);
    sctx.fillStyle = '#b4b4af';
    sctx.fillRect(0, 0, sc.width, sc.height);
    sctx.translate(sc.width / 2, sc.height / 2);
    sctx.rotate((2 * Math.PI) / 180);
    sctx.scale(1.15, 1.15);
    sctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    const scanBlob = await sc.convertToBlob({ type: 'image/png' });
    const scanBytes = new Uint8Array(await scanBlob.arrayBuffer());
    await digest('scan/scan1.png', scanBytes);
    log(`escaneo simulado ${sc.width}×${sc.height}`);

    // fase ②: procesar (camino todo-en-WASM)
    const res = await run(
      'scan_process',
      {
        bytes: scanBytes,
        name: 'scan1.png',
        layout: layoutJson,
        opts: '{}',
        claims: '{}',
      },
      [scanBytes.buffer],
    );
    const result = JSON.parse(res.result) as ScanResult;
    log(
      `scan ok=${result.ok} hoja=${result.hoja_numero} via=${result.via} marcadores=${result.marcadores}/${result.marcadores_total} escala=${result.escala} frames=${res.frames.length}`,
    );
    if (!result.ok || res.frames.length !== 4) throw new Error(`fase ② falló: ${res.result}`);
    for (const f of res.frames) await digest(`scan/frames/${f.label}.png`, f.png);
    if (!String(result.via ?? '').startsWith('marker'))
      throw new Error(`expected marker-ID identification, got via=${result.via}`);
    // los recortes de un mismo layout salen TODOS del mismo tamaño aunque el
    // escaneo esté girado y escalado: el video final los copia sin tocarlos
    const cropSizes = new Set(res.frames.map((f) => pngHeader(f.png).join('×')));
    if (cropSizes.size !== 1) throw new Error(`crops differ in size: ${[...cropSizes].join(', ')}`);
    log(`recortes del mismo tamaño (${[...cropSizes][0]}) ✓`);

    // ── 16 bits de punta a punta ─────────────────────────────────
    // Cuatro fotogramas de 16 bits con un degradado fino (vecinos que en 8
    // bits serían el mismo nivel) → hojas de 16 bits en PNG, TIFF y PDF →
    // esa hoja como un escaneo de 16 bits → recortes de 16 bits, todos del
    // mismo tamaño → el video sin pérdida, que los copia tal cual. En ningún
    // punto del camino puede quedar en 8 bits.
    {
      const DW = 320;
      const DH = 180;
      const deepFrames: GenFrame[] = [0, 1, 2, 3].map((k) => {
        const le = new Uint8Array(DW * DH * 8);
        const dv = new DataView(le.buffer);
        for (let y = 0; y < DH; y++)
          for (let x = 0; x < DW; x++) {
            const o = (y * DW + x) * 8;
            dv.setUint16(o, 8000 + x * 97 + k * 3000, true);
            dv.setUint16(o + 2, 12000 + y * 131, true);
            dv.setUint16(o + 4, 30000 + (x + y) * 41, true);
            dv.setUint16(o + 6, 65535, true);
          }
        return {
          name: `deep${k}.png`,
          w: DW,
          h: DH,
          hasAlpha: false,
          sixteen: true,
          blob: null,
          getImageData: async () => ({ data: le.slice(), w: DW, h: DH, deep: true }),
        };
      });
      const deepLabels = ['d_001', 'd_002', 'd_003', 'd_004'];
      const deepOut = await generateSheets({
        settings: { ...s, out_name: 'deep', fmt_png: true, fmt_pdf: true, fmt_tiff: true },
        frames: deepFrames,
        labels: deepLabels,
        timeline: deepLabels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
        videoMeta: { fps_extraccion: 4 },
        includeFrames: false,
      });
      const deepSheet = deepOut.files.get('deep_p1.png');
      const deepTif = deepOut.files.get('deep_p1.tif');
      const deepPdf = deepOut.files.get('deep.pdf');
      if (!(deepSheet instanceof Blob) || !(deepTif instanceof Blob) || !(deepPdf instanceof Blob))
        throw new Error('the 16-bit sheets were not generated');
      const sheet16 = new Uint8Array(await deepSheet.arrayBuffer());
      if (sheet16[24] !== 16) throw new Error(`the sheet PNG has ${sheet16[24]} bits per channel`);
      const tifBytes = new Uint8Array(await deepTif.arrayBuffer());
      const tifInfo = await run('probe_image', { bytes: tifBytes.slice() });
      if (!tifInfo.sixteen) throw new Error('the sheet TIFF is not 16-bit');
      const pdf16 = new TextDecoder('latin1').decode(await deepPdf.arrayBuffer());
      if (!pdf16.startsWith('%PDF-1.5') || !/\/BitsPerComponent 16/.test(pdf16))
        throw new Error('the sheet PDF does not carry the 16-bit image');
      // el degradado sigue siendo fino DENTRO de la hoja: más de 256 niveles
      // distintos en el rojo de un fotograma (en 8 bits no puede haber más)
      if (!deepOut.layoutJson) throw new Error('16-bit layout missing');
      const deepLayout = JSON.parse(deepOut.layoutJson) as Layout;
      const bbox = deepLayout.hojas?.[0]?.frames?.d_001?.bbox as number[] | undefined;
      if (!bbox) throw new Error('16-bit layout without the frame box');
      const dec = await run('decode_image16', { bytes: sheet16.slice() });
      const px16 = new Uint16Array(dec.rgba16.buffer, dec.rgba16.byteOffset, dec.w * dec.h * 4);
      const reds = new Set<number>();
      for (let y = bbox[1] + 2; y < bbox[3] - 2; y++)
        for (let x = bbox[0] + 2; x < bbox[2] - 2; x++) reds.add(px16[(y * dec.w + x) * 4]);
      if (reds.size <= 256)
        throw new Error(`only ${reds.size} red levels in a 16-bit frame on the sheet`);
      await digest('deep/deep_p1.png', sheet16);
      await digest('deep/deep_p1.tif', tifBytes);
      // la hoja como escaneo de 16 bits (un escáner plano perfecto)
      const deepScan = await run('scan_process', {
        bytes: sheet16.slice(),
        name: 'deep_scan.png',
        layout: deepOut.layoutJson,
        opts: '{}',
      });
      const deepResult = JSON.parse(deepScan.result) as ScanResult;
      if (!deepResult.ok || deepScan.frames.length !== 4)
        throw new Error(`16-bit scan failed: ${deepScan.result}`);
      const heads = deepScan.frames.map((f) => pngHeader(f.png));
      if (heads.some((h) => h[2] !== 16))
        throw new Error('a crop of a 16-bit scan came out in 8 bits');
      if (new Set(heads.map((h) => `${h[0]}×${h[1]}`)).size !== 1)
        throw new Error('the 16-bit crops differ in size');
      const { exportLossless } = await import('./export.ts');
      const crops = deepScan.frames.map((f) => new Blob([f.png], { type: 'image/png' }));
      const deepMov = await exportLossless(crops, 4);
      if (!deepMov.plan.sixteen || deepMov.plan.passthrough !== 4 || deepMov.plan.conform !== 0)
        throw new Error(
          `16-bit crops were not copied as they are: ${JSON.stringify(deepMov.plan)}`,
        );
      log(
        `16 bits de punta a punta: hoja PNG/TIFF/PDF de 16 bits (${reds.size} niveles de rojo en un fotograma), escaneo → 4 recortes de 16 bits ${heads[0][0]}×${heads[0][1]} → MOV que los copia tal cual ✓`,
      );
    }

    // fase ② por WebGPU (si el navegador tiene GPU): detect → warp GPU → finish
    try {
      const { getGpuDevice, gpuWarpPerspective } = await import('./webgpu.ts');
      const gpu = await getGpuDevice();
      if (gpu) {
        const sbmp = await createImageBitmap(scanBlob);
        const cnv = new OffscreenCanvas(sbmp.width, sbmp.height);
        const cctx0 = context2d(cnv, { willReadFrequently: true });
        cctx0.drawImage(sbmp, 0, 0);
        const rgba = new Uint8Array(cctx0.getImageData(0, 0, sbmp.width, sbmp.height).data.buffer);
        const det = JSON.parse(
          await run(
            'scan_detect',
            {
              rgba,
              w: sbmp.width,
              h: sbmp.height,
              name: 'scan1gpu.png',
              layout: layoutJson,
              opts: '{}',
            },
            [rgba.buffer],
          ),
        ) as DetectOutput;
        if (!det.ok) throw new Error(`scan_detect failed: ${JSON.stringify(det.res)}`);
        const warped = await gpuWarpPerspective(sbmp, det.m, det.flipped, det.out_w, det.out_h);
        sbmp.close();
        if (!warped) throw new Error('gpuWarpPerspective returned null');
        const state = JSON.stringify({
          res: det.res,
          s: det.s,
          refined_ids: det.refined_ids,
          local: det.local,
        });
        const gres = await run(
          'scan_finish',
          {
            rgba: warped,
            w: det.out_w,
            h: det.out_h,
            name: 'scan1gpu.png',
            layout: layoutJson,
            opts: '{}',
            claims: '{}',
            state,
          },
          [warped.buffer],
        );
        const gresult = JSON.parse(gres.result) as ScanResult;
        log(`scan GPU ok=${gresult.ok} hoja=${gresult.hoja_numero} frames=${gres.frames.length}`);
        if (!gresult.ok || gres.frames.length !== 4)
          throw new Error(`GPU path failed: ${gres.result}`);
      } else {
        log('· (no WebGPU in this browser: GPU path skipped, WASM fallback already tested)');
      }
    } catch (e) {
      throw new Error(`WebGPU path: ${errMsg(e)}`);
    }

    // fase ③: página de prueba de impresora + autoanálisis
    const test = await run('printer_test_png', { paper: 'A4', dpi: 150 });
    const testCopy = new Uint8Array(test);
    await digest('calibration/printer_test_A4_150.png', testCopy);
    const prof = JSON.parse(
      await run('analyze_printer_test', { bytes: testCopy, paper: 'A4', dpi: 150, scanDpi: 150 }, [
        testCopy.buffer,
      ]),
    ) as PrinterProfile;
    log(
      `calibración: escala ${prof.scale_x}×${prof.scale_y}, marcador mín ${prof.marker_min_mm} mm, QR mín ${prof.qr_min_mm} mm`,
    );
    if (Math.abs(prof.scale_x - 1) > 0.01) throw new Error('escala de impresora incorrecta');

    // ☀️ cianotipia: negativo → copia azul simulada → escaneo → procesado
    // (con QR activado: ejercita el camino LEGADO de identificación por QR)
    const sc2: Settings = {
      ...s,
      mode: 'cyanotype',
      cyan_mirror: true,
      cyan_bg: 'saving',
      out_name: 'cy',
      project_name: 'cy',
      marker_size_mm: 12,
      qr_on: true,
      qr_size_mm: 16,
      fmt_tiff: false,
    };
    const cyFrames = [synthFrame(320, 180, [200, 60, 60]), synthFrame(320, 180, [40, 40, 40])];
    const cyLabels = ['cy_001', 'cy_002'];
    const cyGen = await generateSheets({
      settings: sc2,
      frames: cyFrames.map(
        (fd, i): GenFrame => ({
          name: `c${i}.png`,
          w: 320,
          h: 180,
          hasAlpha: false,
          blob: null,
          getImageData: async () => fd,
        }),
      ),
      labels: cyLabels,
      timeline: cyLabels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
      videoMeta: {},
      includeFrames: false,
    });
    if (!cyGen.layoutJson) throw new Error('cyanotype layout was not generated');
    const cyLayoutJson = cyGen.layoutJson;
    // la copia azul física: render con finish='simulate' (misma geometría)
    const items = cyFrames.map((fd, i) => ({
      data: fd.data,
      w: fd.w,
      h: fd.h,
      hasAlpha: false,
      origName: `c${i}.png`,
    }));
    const { meta, pixels } = packImageData(items);
    const sim = await run(
      'render_sheet',
      {
        settings: settingsForCore(sc2),
        firstW: 320,
        firstH: 180,
        meta,
        pixels,
        labels: JSON.stringify(cyLabels),
        sheetNum: 1,
        render: true,
        finish: 'simulate',
      },
      [pixels.buffer],
    );
    if (!sim.png) throw new Error('simulated blue print was not rendered');
    await digest('cyanotype/simulated_print.png', sim.png);
    const cyBmp = await createImageBitmap(new Blob([sim.png], { type: 'image/png' }));
    const cc = new OffscreenCanvas(Math.round(cyBmp.width * 1.25), Math.round(cyBmp.height * 1.2));
    const cctx = context2d(cc);
    cctx.fillStyle = '#a8a8a2';
    cctx.fillRect(0, 0, cc.width, cc.height);
    cctx.translate(cc.width / 2, cc.height / 2);
    cctx.rotate((-1.5 * Math.PI) / 180);
    cctx.scale(1.1, 1.1);
    cctx.drawImage(cyBmp, -cyBmp.width / 2, -cyBmp.height / 2);
    const cyScan = new Uint8Array(
      await (await cc.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    const cyRes = await run(
      'scan_process',
      {
        bytes: cyScan,
        name: 'cyan1.png',
        layout: cyLayoutJson,
        opts: '{}',
        claims: '{}',
      },
      [cyScan.buffer],
    );
    const cyResult = JSON.parse(cyRes.result) as ScanResult;
    log(
      `cianotipia: ok=${cyResult.ok} marcadores=${cyResult.marcadores}/${cyResult.marcadores_total} frames=${cyRes.frames.length} estrategia=${cyResult.estrategia}`,
    );
    if (!cyResult.ok || cyRes.frames.length !== 2)
      throw new Error(`cianotipia falló: ${cyRes.result}`);
    for (const f of cyRes.frames) await digest(`cyanotype/frames/${f.label}.png`, f.png);

    // ✋ asignación manual: mismo escaneo, pero con los QR ilegibles (se
    // quitan del layout). Este layout tiene una sola hoja, así que sin QR se
    // identifica por eliminación; lo que se comprueba aquí es que decir la
    // hoja a mano manda sobre eso y llega entera hasta los recortes.
    const blindLayout = JSON.parse(cyLayoutJson) as Layout;
    for (const h of blindLayout.hojas ?? []) h.qrs = {};
    const blindStr = JSON.stringify(blindLayout);
    const cyScan2 = new Uint8Array(
      await (await cc.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    const blindRes = await run(
      'scan_process',
      {
        bytes: cyScan2,
        name: 'cyan1.png',
        layout: blindStr,
        opts: '{}',
        claims: '{}',
      },
      [cyScan2.buffer],
    );
    const blindResult = JSON.parse(blindRes.result) as ScanResult;
    if (!String(blindResult.via ?? '').startsWith('only sheet')) {
      throw new Error(
        `sin QR debería caer en la identificación por eliminación: via=${blindResult.via}`,
      );
    }
    const cyScan3 = new Uint8Array(
      await (await cc.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    const handRes = await run(
      'scan_process',
      {
        bytes: cyScan3,
        name: 'cyan1.png',
        layout: blindStr,
        opts: JSON.stringify({ forced_sheet: 1 }),
        claims: '{}',
      },
      [cyScan3.buffer],
    );
    const handResult = JSON.parse(handRes.result) as ScanResult;
    log(
      `asignación manual: ok=${handResult.ok} hoja=${handResult.hoja_numero} via=${handResult.via} frames=${handRes.frames.length}`,
    );
    if (!handResult.ok || handRes.frames.length !== 2)
      throw new Error(`asignación manual falló: ${handRes.result}`);
    if (!String(handResult.via ?? '').startsWith('assigned by hand'))
      throw new Error(`via inesperada: ${handResult.via}`);

    // ↩ compatibilidad: los ajustes en español de versiones anteriores deben
    // producir exactamente el mismo lienzo que los nuevos en inglés
    const legacy: Settings = {
      ...s,
      paper: 'Carta (Letter)',
      orientation: 'Horizontal',
      page_num_corner: 'Inferior derecha',
      mode: 'cianotipia',
      cyan_bg: 'ahorro',
    };
    const modern: Settings = {
      ...s,
      paper: 'Letter',
      orientation: 'landscape',
      page_num_corner: 'Bottom right',
      mode: 'cyanotype',
      cyan_bg: 'saving',
    };
    const [lay1, lay2] = await Promise.all([
      run('compute_layout', { settings: settingsForCore(legacy), firstW: 320, firstH: 180 }),
      run('compute_layout', { settings: settingsForCore(modern), firstW: 320, firstH: 180 }),
    ]);
    if (lay1 !== lay2) throw new Error(`los ajustes heredados ya no equivalen:\n${lay1}\n${lay2}`);
    log('compatibilidad de ajustes en español ✓');

    // fase ①/④ con VIDEO REAL (WebCodecs): extraer y reconstruir
    try {
      const vresp = await fetch('/e2e_sample.mp4');
      if (vresp.ok) {
        const vblob = new File([await vresp.arrayBuffer()], 'e2e_sample.mp4', {
          type: 'video/mp4',
        });
        const { extractFrames } = await import('./video.ts');
        const got: Blob[] = [];
        const meta = await extractFrames(vblob, {
          start: 0,
          end: 3,
          fps: 2,
          onFrame: async (blob) => {
            if (!blob) throw new Error('expected a PNG frame');
            got.push(blob);
          },
        });
        log(`video: ${meta.count} frames extraídos a 2 fps (nativo ${meta.fps.toFixed(1)} fps)`);
        if (got.length < 5) throw new Error('incomplete video extraction');
        if (meta.cancelled) throw new Error('extraction reported cancelled without a signal');

        // parar a mitad (todos los fotogramas: 36): el AbortSignal corta la
        // extracción y devuelve lo ya entregado, en orden y con índices
        // consecutivos; lo que estaba en los workers se entrega, no se pierde
        const ctl = new AbortController();
        let seen = 0;
        const partial = await extractFrames(vblob, {
          start: 0,
          end: 3,
          fps: null,
          signal: ctl.signal,
          onFrame: async (_b, _thumb, _t, i) => {
            if (i !== seen) throw new Error(`frame ${i} arrived out of order (expected ${seen})`);
            seen++;
            if (seen === 2) ctl.abort();
          },
        });
        log(
          `video: parada a mitad tras ${partial.count} fotogramas (cancelled=${partial.cancelled})`,
        );
        if (!partial.cancelled || partial.count < 2 || partial.count >= 30)
          throw new Error(`abort did not stop the extraction (${partial.count} frames)`);

        // extracción perezosa: sin PNG, el fotograma vive en el video. Se
        // vuelve a decodificar por su instante, en el orden pedido, y las
        // hojas y el ZIP salen del video sin ningún PNG intermedio
        const { decodeVideoFrames } = await import('./video.ts');
        const refs: { t: number; thumbW: number }[] = [];
        const lazyMeta = await extractFrames(vblob, {
          start: 0,
          end: 3,
          fps: 2,
          lazy: true,
          onFrame: async (b, thumb, t) => {
            if (b !== null) throw new Error('lazy extraction produced a PNG');
            refs.push({ t, thumbW: thumb.width });
          },
        });
        if (lazyMeta.count < 5 || refs.some((r) => r.thumbW !== 256))
          throw new Error(`lazy extraction: ${lazyMeta.count} frames, thumbs ${refs[0]?.thumbW}`);
        const wanted = [refs[3].t, refs[0].t, refs[4].t];
        const decoded: { index: number; w: number; h: number }[] = [];
        await decodeVideoFrames(vblob, wanted, (index, bmp) => {
          decoded.push({ index, w: bmp.width, h: bmp.height });
          bmp.close();
        });
        // llegan en orden de tiempo (t0 < t3 < t4) con el índice pedido
        if (
          decoded.map((d) => d.index).join() !== '1,0,2' ||
          decoded.some((d) => d.w !== 320 || d.h !== 180)
        )
          throw new Error(`decodeVideoFrames: ${JSON.stringify(decoded)}`);
        log(`video: ${lazyMeta.count} fotogramas perezosos; 3 redecodificados por instante`);

        const { clearFrames, frameImageData, framePngs, prefetchVideoFrames, project } =
          await import('./project.ts');
        const { makeZip } = await import('./zip.ts');
        clearFrames();
        for (const [i, r] of refs.entries()) {
          project.frames.push({
            name: `lazy_${i + 1}.png`,
            blob: null,
            video: { file: vblob, t: r.t },
            thumb: null,
            w: 320,
            h: 180,
            hasAlpha: false,
          });
        }
        const pngs = framePngs(project.frames.map((_f, i) => i));
        const lazyFrames: GenFrame[] = project.frames.map((f, i) => ({
          name: f.name,
          w: f.w,
          h: f.h,
          hasAlpha: false,
          blob: null,
          video: f.video,
          encodePng: pngs.get[i],
          getImageData: (full: boolean) => frameImageData(i, full),
        }));
        const lazyLabels = lazyFrames.map((_f, i) => `lz_${i + 1}`);
        const lazyOut = await generateSheets({
          settings: { ...s, cols: 3, rows: 2, out_name: 'lazy', fmt_pdf: false, fmt_tiff: false },
          frames: lazyFrames,
          labels: lazyLabels,
          timeline: lazyLabels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
          videoMeta: { fps_extraccion: 2 },
          includeFrames: true,
          prefetch: (chunk) =>
            prefetchVideoFrames(chunk.flatMap((g) => (g.video ? [g.video] : []))),
        });
        const lazySheet = lazyOut.files.get('lazy_p1.png');
        if (!(lazySheet instanceof Blob) || !lazySheet.size)
          throw new Error('lazy sheet was not generated');
        const lazyEntry = lazyOut.files.get('lazy_frames/lz_1.png');
        if (typeof lazyEntry !== 'function') throw new Error('frame export entry is not lazy');
        const lazyZip = await makeZip(lazyOut.files);
        // el ZIP lo escribe zipwriter.ts en ZIP64: cola con EOCD64 + localizador + EOCD
        const tailBytes = new Uint8Array(await lazyZip.slice(-98).arrayBuffer());
        const sig = (o: number): number =>
          tailBytes[o] |
          (tailBytes[o + 1] << 8) |
          (tailBytes[o + 2] << 16) |
          (tailBytes[o + 3] << 24);
        if (sig(0) !== 0x06064b50 || sig(56) !== 0x07064b50 || sig(76) !== 0x06054b50)
          throw new Error('ZIP tail is not EOCD64 + locator + EOCD');
        // el PNG que sale del video al exportar es EL MISMO que el de la
        // extracción con PNG (mismo instante, mismo codificador): byte a byte
        const lazyPng = new Uint8Array(await new Blob([await lazyEntry()]).arrayBuffer());
        const eager = new Uint8Array(await got[0].arrayBuffer());
        if (lazyPng.length !== eager.length || lazyPng.some((v, i) => v !== eager[i]))
          throw new Error(
            `exported frame differs from the eager PNG (${lazyPng.length} vs ${eager.length} bytes)`,
          );
        pngs.cancel();
        await digest('video/lazy_p1.png', lazySheet);
        await digest('video/frame_1.png', eager);
        log(
          `hojas desde el video: hoja ${lazySheet.size} bytes, ZIP ${lazyZip.size} bytes, PNG exportado idéntico al de la extracción ✓`,
        );
        clearFrames();

        // caché de disco (OPFS): lo que entra sale igual, y se puede vaciar
        const { storeFrame, clearFrameCache } = await import('./opfs.ts');
        await clearFrameCache();
        const stored = await storeFrame('e2e_1.png', got[0]);
        const back = new Uint8Array(await stored.arrayBuffer());
        const orig = new Uint8Array(await got[0].arrayBuffer());
        if (back.length !== orig.length || back.some((v, i) => v !== orig[i]))
          throw new Error('OPFS round trip changed the bytes');
        await clearFrameCache();
        log(`OPFS: ${back.length} bytes ida y vuelta`);

        // ── el video final, siempre sin pérdida ───────────────────────
        // Una secuencia que obliga a decidir: un PNG de 16 bits del tamaño
        // de la mayoría (va tal cual), un PNG de 8 bits de 322×179 (se
        // centra en 320×180 sin remuestrear y se ensancha a 16 bits) y un
        // TIFF de 16 bits (el núcleo lo pasa a PNG sin perder bits), con
        // dibujos repetidos, como los deja la deduplicación. Los píxeles no
        // se comprueban aquí: el MOV y el ZIP salen al runner, que los
        // decodifica con el ffmpeg de la máquina y compara cada muestra de
        // 16 bits con las de las fuentes (e2e-run.mts, "lossless").
        const { exportLossless } = await import('./export.ts');
        const W = 320;
        const H = 180;
        // valores que en 8 bits colapsarían: difieren en el byte bajo
        const deep = (seed: number, ch: number): Uint16Array => {
          const a = new Uint16Array(W * H * ch);
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++)
              for (let c = 0; c < ch; c++)
                a[(y * W + x) * ch + c] = (x * 197 + y * 331 + c * 7919 + seed * 104729) % 65536;
          return a;
        };
        const f16 = new Blob([await encodePngRaw(W, H, 16, 2, deep(1, 3))], { type: 'image/png' });
        const shallow = new Uint8Array(322 * 179 * 3).map(
          (_, i) => (i * 37 + Math.floor(i / 966) * 11) & 255,
        );
        const f8 = new Blob([await encodePngRaw(322, 179, 8, 2, shallow)], { type: 'image/png' });
        const tif = await run('encode_tiff', { png: await encodePngRaw(W, H, 16, 2, deep(2, 3)) });
        const fTif = new Blob([tif], { type: 'image/tiff' });
        const seqFrames = [f16, f8, f16, fTif, f8];
        e2eFiles['src_f16.png'] = f16;
        e2eFiles['src_f8.png'] = f8;
        e2eFiles['src_tif.tif'] = fTif;
        lossless.sequence = [
          'src_f16.png',
          'src_f8.png',
          'src_f16.png',
          'src_tif.tif',
          'src_f8.png',
        ];

        // cancelar tras escribir el primer fotograma: CancelledError, y nada
        // a medias en el disco
        const vctl = new AbortController();
        let wrote = 0;
        try {
          await exportLossless(seqFrames, 2, {
            signal: vctl.signal,
            onProgress: (stage, d) => {
              if (stage !== 'writing') return;
              wrote = d;
              if (d === 1) vctl.abort();
            },
          });
          throw new Error('the export did not cancel');
        } catch (e) {
          if (!isCancelled(e)) throw new Error(`export cancel: ${errMsg(e)}`);
        }
        if (wrote !== 1) throw new Error(`export cancel: ${wrote} frames written`);
        log('cancelar la exportación tras el primer fotograma ✓');

        const mb = await import('mediabunny');
        /** Canal 0 del audio de un archivo, como una sola señal a su ritmo. */
        const audioOf = async (
          bytes: Bytes | Blob,
          type: string,
        ): Promise<{
          codec: string | null;
          rate: number;
          channels: number;
          dur: number;
          pcm: Float32Array;
        } | null> => {
          const input = new mb.Input({
            source: new mb.BlobSource(new Blob([bytes], { type })),
            formats: mb.ALL_FORMATS,
          });
          try {
            const track = await input.getPrimaryAudioTrack();
            if (!track) return null;
            const rate = track.sampleRate;
            const dur = await track.computeDuration();
            const pcm = new Float32Array(Math.ceil((dur + 0.1) * rate));
            const sink = new mb.AudioSampleSink(track);
            for await (const smp of sink.samples()) {
              const ch = smp.toAudioBuffer().getChannelData(0);
              const at = Math.round(smp.timestamp * rate);
              if (at >= 0) pcm.set(ch.subarray(0, Math.min(ch.length, pcm.length - at)), at);
              smp.close();
            }
            return { codec: track.codec, rate, channels: track.numberOfChannels, dur, pcm };
          } finally {
            input.dispose();
          }
        };
        /** Frecuencia dominante en [t0, t1), por cruces por cero. */
        const hz = (a: { rate: number; pcm: Float32Array }, t0: number, t1: number): number => {
          let n = 0;
          const i0 = Math.round(t0 * a.rate);
          const i1 = Math.round(t1 * a.rate);
          for (let i = i0 + 1; i < i1; i++) if (a.pcm[i - 1] < 0 !== a.pcm[i] < 0) n++;
          return n / 2 / (t1 - t0);
        };
        const nearHz = (v: number, want: number): boolean => Math.abs(v - want) < want * 0.1;
        /** Nivel eficaz del canal 0: distingue sonido de silencio. */
        const rms = (a: { pcm: Float32Array }): number => {
          let sum = 0;
          for (const v of a.pcm) sum += v * v;
          return Math.sqrt(sum / Math.max(1, a.pcm.length));
        };
        const sample = async (name: string): Promise<File | null> => {
          const r = await fetch(`/${name}`);
          return r.ok ? new File([await r.arrayBuffer()], name, { type: 'video/mp4' }) : null;
        };

        // el MOV de la secuencia con el sonido del original estéreo a
        // 44.1 kHz: el tramo [0.5, 3.0) s, con el salto de 440 a 880 Hz del
        // original (t = 1.5 s) cayendo en t = 1.0 s del video
        const stereo = await sample('e2e_sample_audio_stereo.mp4');
        const audio = stereo ? { file: stereo, start: 0.5 } : undefined;
        const mov = await exportLossless(seqFrames, 2, { kind: 'mov', audio });
        const p = mov.plan;
        log(
          `MOV sin pérdida: ${p.w}×${p.h}, ${p.sixteen ? 16 : 8} bits${p.alpha ? ' + alfa' : ''}, ${p.frames} fotogramas de ${p.unique} dibujos: ${p.passthrough} tal cual, ${p.conform} conformados, ${p.resized} reescalados`,
        );
        if (
          mov.ext !== 'mov' ||
          p.w !== W ||
          p.h !== H ||
          !p.sixteen ||
          p.alpha ||
          p.frames !== 5 ||
          p.unique !== 3 ||
          p.passthrough !== 1 ||
          p.conform !== 2 ||
          p.resized !== 0
        )
          throw new Error(`lossless plan is wrong: ${JSON.stringify(p)}`);
        e2eFiles['lossless.mov'] = new Blob([mov.bytes]);
        if (audio) {
          const a = await audioOf(mov.bytes, mov.mime);
          if (!mov.audio || !a) throw new Error('the lossless MOV lost the sound');
          const f1 = hz(a, 0.2, 0.8);
          const f2 = hz(a, 1.2, 1.8);
          log(
            `audio en el MOV: ${a.codec} ${a.channels} ch a ${a.rate} Hz, ${a.dur.toFixed(2)} s; ${f1.toFixed(0)} / ${f2.toFixed(0)} Hz`,
          );
          if (
            a.channels !== 2 ||
            a.rate !== 44100 ||
            Math.abs(a.dur - 2.5) > 0.05 ||
            !nearHz(f1, 440) ||
            !nearHz(f2, 880)
          )
            throw new Error('the sound of the lossless MOV is wrong or out of sync');
        }
        // la misma secuencia como PNG numerados en un ZIP, con su WAV
        const zipOut = await exportLossless(seqFrames, 2, {
          kind: 'frames',
          audio,
          baseName: 'seq',
        });
        e2eFiles['lossless.zip'] = new Blob([zipOut.bytes]);
        log(`ZIP de fotogramas: ${new Blob([zipOut.bytes]).size} bytes, audio=${zipOut.audio}`);
        // con UN fotograma transparente la secuencia entera lleva alfa, y el
        // relleno del centrado es transparente, no blanco
        const alphaPx = new Uint8Array(W * H * 4).map((_, i) =>
          i % 4 === 3 ? ((i >> 2) % W < 40 ? 0 : 255) : (i * 13) & 255,
        );
        const fA = new Blob([await encodePngRaw(W, H, 8, 6, alphaPx)], { type: 'image/png' });
        e2eFiles['src_alpha.png'] = fA;
        const movA = await exportLossless([f16, fA], 2, { kind: 'mov' });
        if (!movA.plan.alpha || !movA.plan.sixteen || movA.plan.conform !== 2)
          throw new Error(`alpha plan is wrong: ${JSON.stringify(movA.plan)}`);
        e2eFiles['alpha.mov'] = new Blob([movA.bytes]);
        log('MOV con alfa: RGBA de 16 bits ✓');

        // ── el sonido, combinación a combinación ─────────────────────
        // Los 4 primeros fotogramas de la extracción (2 s a 2 fps, PNG de 8
        // bits del mismo tamaño: van tal cual) con orígenes distintos: 5.1
        // (que se pliega a dos canales porque un MOV de edición no lleva
        // más), un tramo que el original ya no cubre (silencio hasta el
        // final, pero la pista dura lo que el video), uno que ni empieza
        // dentro, y un original mudo.
        const lossFrames = got.slice(0, 4);
        const cases: {
          file: string;
          start: number;
          channels: number | null;
          note: string;
          /** El original sólo suena en el canal central: la mezcla a dos
           *  canales tiene que traerlo, no tirarlo. */
          loud?: boolean;
        }[] = [
          { file: 'e2e_sample_audio_51.mp4', start: 0.5, channels: 2, note: '5.1 → 2', loud: true },
          { file: 'e2e_sample_audio.mp4', start: 2.5, channels: 1, note: 'el original se acaba' },
          { file: 'e2e_sample_audio.mp4', start: 5, channels: null, note: 'el tramo no existe' },
          { file: 'e2e_sample.mp4', start: 0, channels: null, note: 'original mudo' },
        ];
        for (const c of cases) {
          const f = await sample(c.file);
          if (!f) {
            log(`· (sin ${c.file}: caso omitido)`);
            continue;
          }
          const built = await exportLossless(lossFrames, 2, { audio: { file: f, start: c.start } });
          if (built.plan.passthrough !== 4 || built.plan.sixteen)
            throw new Error(`${c.note}: same-size 8-bit PNGs were not copied as they are`);
          const track = await audioOf(built.bytes, built.mime);
          if (c.channels === null) {
            if (built.audio || track) throw new Error(`${c.note}: an audio track appeared`);
            if (!built.audioNote) throw new Error(`${c.note}: silent without saying why`);
            log(`· ${c.note}: mudo, con aviso ✓`);
            continue;
          }
          // 5.1: si este navegador no decodifica esa disposición, el video
          // sale mudo y avisa; lo que no puede es colgarse ni escribir una
          // pista rota
          if (!built.audio) {
            log(`· ${c.note}: el navegador no lo decodifica, video mudo`);
            if (track) throw new Error(`${c.note}: silent flag but a track is there`);
            continue;
          }
          if (!track) throw new Error(`${c.note}: audio flag but no track`);
          if (track.channels !== c.channels)
            throw new Error(`${c.note}: ${track.channels} channels in the MOV`);
          if (Math.abs(track.dur - 2) > 0.05)
            throw new Error(`${c.note}: audio lasts ${track.dur.toFixed(2)} s, video 2 s`);
          const level = rms(track);
          if (c.loud && level < 0.05)
            throw new Error(`${c.note}: the centre channel did not reach the mix`);
          log(
            `· ${c.note}: ${track.codec} ${track.channels} ch a ${track.rate} Hz, ${track.dur.toFixed(2)} s, rms ${level.toFixed(3)} ✓`,
          );
        }
      } else {
        log('· (sin muestra de video: prueba de WebCodecs omitida)');
      }
    } catch (e) {
      throw new Error(`flujo de video: ${errMsg(e)}`);
    }

    // MOV ProRes: mediabunny abre el contenedor pero WebCodecs no decodifica
    // el códec (como los MOV HEVC 10 bits de cámara) → desvío por canDecode()
    try {
      const presp = await fetch('/e2e_sample_prores.mov');
      if (presp.ok) {
        const pblob = new File([await presp.arrayBuffer()], 'e2e_sample_prores.mov', {
          type: 'video/quicktime',
        });
        const { probeVideo, extractFrames } = await import('./video.ts');
        const pprobe = await probeVideo(pblob);
        if (!pprobe.width) throw new Error('ProRes MOV probe returned no dimensions');
        const got: Blob[] = [];
        const meta = await extractFrames(pblob, {
          start: 0,
          end: 1,
          fps: 4,
          onFrame: async (b) => {
            if (!b) throw new Error('expected a PNG frame');
            got.push(b);
          },
        });
        log(
          `MOV ProRes: ${meta.count} frames extraídos vía ffmpeg.wasm (${pprobe.width}×${pprobe.height})`,
        );
        if (got.length < 3) throw new Error(`incomplete ProRes extraction (${got.length})`);
      } else {
        log('· (sin muestra ProRes: prueba del códec no decodificable omitida)');
      }
    } catch (e) {
      throw new Error(`flujo MOV de cámara: ${errMsg(e)}`);
    }

    // AVI: extracción por el decodificador de respaldo (ffmpeg.wasm)
    try {
      const aresp = await fetch('/e2e_sample.avi');
      if (aresp.ok) {
        const ablob = new File([await aresp.arrayBuffer()], 'e2e_sample.avi', {
          type: 'video/x-msvideo',
        });
        const { extractFrames } = await import('./video.ts');
        const { ffmpegThreads } = await import('./avi.ts');
        // el servidor del test manda las cabeceras de _headers: con ellas el
        // origen está aislado y el multihilo puede probarse; si no, es que
        // las cabeceras (o el navegador) no dan SharedArrayBuffer
        if (!crossOriginIsolated) throw new Error('the page is not cross-origin isolated');
        const got: Blob[] = [];
        const meta = await extractFrames(ablob, {
          start: 0,
          end: 2,
          fps: 3,
          onFrame: async (b) => {
            if (!b) throw new Error('expected a PNG frame');
            got.push(b);
          },
        });
        // qué núcleo corrió de verdad: se sabe después de la primera sesión
        log(
          `AVI: ${meta.count} frames extraídos vía ffmpeg.wasm (${meta.fps} fps nativo detectado), núcleo ${ffmpegThreads()}-threaded`,
        );
        if (got.length < 5) throw new Error(`incomplete AVI extraction (${got.length})`);

        // parar a mitad con ffmpeg.wasm: la parada termina la instancia en
        // plena tanda (24 fotogramas) y la extracción devuelve lo entregado
        const ctl = new AbortController();
        let seen = 0;
        const partial = await extractFrames(ablob, {
          start: 0,
          end: 2,
          fps: null,
          signal: ctl.signal,
          onFrame: async (_b, _thumb, _t, i) => {
            if (i !== seen)
              throw new Error(`AVI frame ${i} arrived out of order (expected ${seen})`);
            seen++;
            if (seen === 2) ctl.abort();
          },
        });
        log(
          `AVI: parada a mitad tras ${partial.count} fotogramas (cancelled=${partial.cancelled})`,
        );
        if (!partial.cancelled || partial.count < 2 || partial.count >= 20)
          throw new Error(`abort did not stop the AVI extraction (${partial.count} frames)`);

        // `lazy` NO se honra aquí: ffmpeg.wasm no puede volver a decodificar
        // deprisa, así que entrega el PNG igual
        let lazyAvi = 0;
        const lazyAviMeta = await extractFrames(ablob, {
          start: 0,
          end: 1,
          fps: 3,
          lazy: true,
          onFrame: async (b) => {
            if (!b) throw new Error('ffmpeg.wasm honoured lazy and dropped the PNG');
            lazyAvi++;
          },
        });
        if (lazyAviMeta.count < 2 || lazyAvi !== lazyAviMeta.count)
          throw new Error(`lazy AVI extraction: ${lazyAvi}/${lazyAviMeta.count}`);
        log(`AVI: con lazy sigue entregando PNG (${lazyAvi} fotogramas)`);
      } else {
        log('· (sin muestra AVI: prueba del decodificador de respaldo omitida)');
      }
    } catch (e) {
      throw new Error(`flujo AVI: ${errMsg(e)}`);
    }

    document.title = 'E2E-OK';
    log('✅ E2E OK');
  } catch (e) {
    document.title = 'E2E-FAIL';
    log(`❌ ${errMsg(e)}`);
    console.error(e);
  }
}

void main();
