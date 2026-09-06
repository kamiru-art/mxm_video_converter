// Prueba de punta a punta EN EL NAVEGADOR: hoja → "escaneo" girado →
// procesado → frames recuperados. Verifica el núcleo WASM + workers + glue.

import { errMsg } from './errors.ts';
import type { GenFrame } from './gen.ts';
import { generateSheets, packImageData, settingsForCore } from './gen.ts';
import { run } from './pool.ts';
import type { RgbaImage } from './project.ts';
import { defaultSettings } from './settings.ts';
import type { DetectOutput, Layout, PrinterProfile, ScanResult, Settings } from './types.ts';
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

async function main(): Promise<void> {
  try {
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
      keepOriginals: false,
    });
    const sheetBlob = out.files.get('e2e_p1.png');
    if (!sheetBlob || !(sheetBlob instanceof Blob)) throw new Error('sheet was not generated');
    const tif = out.files.get('e2e_p1.tif');
    if (!(tif instanceof Blob) || !tif.size) throw new Error('TIFF export missing');
    const sheetPng = new Uint8Array(await sheetBlob.arrayBuffer());
    if (!out.layoutJson) throw new Error('layout was not generated');
    const layoutJson = out.layoutJson;
    const layoutObj = JSON.parse(layoutJson) as Layout;
    if (!layoutObj.marcadores?.ids_por_hoja)
      throw new Error('layout without ids_por_hoja (no-QR identity)');
    log(
      `hoja generada (${sheetPng.length} bytes), PDF: ${out.files.has('e2e.pdf')}, TIFF ok, layout: ids_por_hoja ✓`,
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
    if (!String(result.via ?? '').startsWith('marker'))
      throw new Error(`expected marker-ID identification, got via=${result.via}`);

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
      keepOriginals: false,
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
        const { extractFrames, buildVideo } = await import('./video.ts');
        const got: Blob[] = [];
        const meta = await extractFrames(vblob, {
          start: 0,
          end: 3,
          fps: 2,
          onFrame: async (blob) => {
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
        const getters = got.map((b) => () => createImageBitmap(b));
        const out2 = await buildVideo(getters, 2);
        log(`video reconstruido: ${out2.ext} de ${out2.bytes.length} bytes`);
        if (out2.bytes.length < 5000) throw new Error('suspiciously small output video');

        // reescalado de salida: ejercita resize_rgba (Lanczos3 del núcleo)
        const out3 = await buildVideo(getters, 2, null, { targetH: 120 });
        log(`video reescalado a 120p: ${out3.ext} de ${out3.bytes.length} bytes`);
        if (out3.bytes.length < 2000) throw new Error('scaled video output too small');

        // exportación lossless: PNG en MOV por stream copy (ffmpeg.wasm)
        const { buildVideoLossless } = await import('./video.ts');
        const lossFrames = got.slice(0, 4);
        const outL = await buildVideoLossless(lossFrames, 2);
        const headL = new TextDecoder('latin1').decode(outL.bytes.slice(0, 16));
        log(`lossless MOV: ${outL.bytes.length} bytes (${outL.ext})`);
        if (outL.ext !== 'mov' || !headL.includes('ftyp'))
          throw new Error('lossless output is not a MOV');
        const totalPng = lossFrames.reduce((a, b) => a + b.size, 0);
        if (outL.bytes.length < totalPng)
          throw new Error('lossless MOV smaller than its PNG frames (not stream-copied)');

        // ProRes 4444 en el navegador (prores_ks de ffmpeg.wasm)
        const { buildVideoProres } = await import('./video.ts');
        const outP = await buildVideoProres(lossFrames, 2);
        // el atom stsd con el fourcc va en el moov, al FINAL del archivo
        const bodyP = new TextDecoder('latin1').decode(outP.bytes.slice(-65536));
        log(`ProRes MOV: ${outP.bytes.length} bytes`);
        if (outP.ext !== 'mov' || !bodyP.includes('ap4h'))
          throw new Error('ProRes output lacks the ap4h codec atom');
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
        const got: Blob[] = [];
        const meta = await extractFrames(ablob, {
          start: 0,
          end: 2,
          fps: 3,
          onFrame: async (b) => {
            got.push(b);
          },
        });
        log(
          `AVI: ${meta.count} frames extraídos vía ffmpeg.wasm (${meta.fps} fps nativo detectado)`,
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
