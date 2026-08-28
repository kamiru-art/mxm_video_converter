// Prueba de punta a punta EN EL NAVEGADOR: hoja → "escaneo" girado →
// procesado → frames recuperados. Verifica el núcleo WASM + workers + glue.

import { run, run0 } from './pool.js';
import { generateSheets, packImageData, settingsForCore } from './gen.js';
import { defaultSettings } from './phase1.js';

const logEl = document.getElementById('log');
const lines = [];
function log(s) {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  console.log('[E2E]', s);
}

function synthFrame(w, h, base) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
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

async function main() {
  try {
    const v = await run('version', {});
    log(`wasm ${v} cargado`);

    // fase ①: generar una hoja con 4 frames sintéticos (SIN QR: la identidad
    // va en los IDs de los marcadores — el camino por defecto actual)
    const s = { ...defaultSettings(), dpi: 150, cols: 2, rows: 2, project_name: 'e2e', out_name: 'e2e', marker_size_mm: 10, fmt_tiff: true };
    const colors = [[200, 60, 60], [60, 180, 60], [60, 60, 200], [180, 160, 40]];
    const frames = colors.map((c, i) => {
      const fd = synthFrame(320, 180, c);
      return {
        name: `f${i}.png`, w: 320, h: 180, hasAlpha: false, blob: null,
        getImageData: async () => fd,
      };
    });
    const labels = ['e2e_001', 'e2e_002', 'e2e_003', 'e2e_004'];
    const out = await generateSheets({
      settings: s, frames, labels,
      timeline: labels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
      videoMeta: { fps_extraccion: 4 }, keepOriginals: false,
    });
    const sheetBlob = out.files.get('e2e_p1.png');
    if (!sheetBlob) throw new Error('sheet was not generated');
    if (!out.files.get('e2e_p1.tif')?.size) throw new Error('TIFF export missing');
    const sheetPng = new Uint8Array(await sheetBlob.arrayBuffer());
    const layoutObj = JSON.parse(out.layoutJson);
    if (!layoutObj.marcadores?.ids_por_hoja) throw new Error('layout without ids_por_hoja (no-QR identity)');
    log(`hoja generada (${sheetPng.length} bytes), PDF: ${out.files.has('e2e.pdf')}, TIFF ok, layout: ids_por_hoja ✓`);

    // "escanear": dibujar la hoja rotada 2° sobre un lienzo mayor
    const bmp = await createImageBitmap(sheetBlob);
    const sc = new OffscreenCanvas(Math.round(bmp.width * 1.3), Math.round(bmp.height * 1.25));
    const sctx = sc.getContext('2d');
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
    const res = await run('scan_process', {
      bytes: scanBytes, name: 'scan1.png', layout: out.layoutJson,
      opts: '{}', claims: '{}',
    }, [scanBytes.buffer]);
    const result = JSON.parse(res.result);
    log(`scan ok=${result.ok} hoja=${result.hoja_numero} via=${result.via} marcadores=${result.marcadores}/${result.marcadores_total} escala=${result.escala} frames=${res.frames.length}`);
    if (!result.ok || res.frames.length !== 4) throw new Error(`fase ② falló: ${res.result}`);
    if (!String(result.via ?? '').startsWith('marker')) throw new Error(`expected marker-ID identification, got via=${result.via}`);

    // fase ② por WebGPU (si el navegador tiene GPU): detect → warp GPU → finish
    try {
      const { getGpuDevice, gpuWarpPerspective } = await import('./webgpu.js');
      const gpu = await getGpuDevice();
      if (gpu) {
        const sbmp = await createImageBitmap(scanBlob);
        const cnv = new OffscreenCanvas(sbmp.width, sbmp.height);
        const cctx0 = cnv.getContext('2d', { willReadFrequently: true });
        cctx0.drawImage(sbmp, 0, 0);
        const rgba = new Uint8Array(cctx0.getImageData(0, 0, sbmp.width, sbmp.height).data.buffer);
        const det = JSON.parse(await run('scan_detect', {
          rgba, w: sbmp.width, h: sbmp.height, name: 'scan1gpu.png', layout: out.layoutJson, opts: '{}',
        }, [rgba.buffer]));
        if (!det.ok) throw new Error(`scan_detect failed: ${JSON.stringify(det.res)}`);
        const warped = await gpuWarpPerspective(sbmp, det.m, det.flipped, det.out_w, det.out_h);
        sbmp.close();
        if (!warped) throw new Error('gpuWarpPerspective returned null');
        const state = JSON.stringify({ res: det.res, s: det.s, refined_ids: det.refined_ids, local: det.local });
        const gres = await run('scan_finish', {
          rgba: warped, w: det.out_w, h: det.out_h, name: 'scan1gpu.png',
          layout: out.layoutJson, opts: '{}', claims: '{}', state,
        }, [warped.buffer]);
        const gresult = JSON.parse(gres.result);
        log(`scan GPU ok=${gresult.ok} hoja=${gresult.hoja_numero} frames=${gres.frames.length}`);
        if (!gresult.ok || gres.frames.length !== 4) throw new Error(`GPU path failed: ${gres.result}`);
      } else {
        log('· (no WebGPU in this browser: GPU path skipped, WASM fallback already tested)');
      }
    } catch (e) {
      throw new Error(`WebGPU path: ${e.message ?? e}`);
    }

    // fase ③: página de prueba de impresora + autoanálisis
    const test = await run('printer_test_png', { paper: 'A4', dpi: 150 });
    const testCopy = new Uint8Array(test);
    const prof = JSON.parse(await run('analyze_printer_test', { bytes: testCopy, paper: 'A4', dpi: 150, scanDpi: 150 }, [testCopy.buffer]));
    log(`calibración: escala ${prof.scale_x}×${prof.scale_y}, marcador mín ${prof.marker_min_mm} mm, QR mín ${prof.qr_min_mm} mm`);
    if (Math.abs(prof.scale_x - 1) > 0.01) throw new Error('escala de impresora incorrecta');

    // ☀️ cianotipia: negativo → copia azul simulada → escaneo → procesado
    // (con QR activado: ejercita el camino LEGADO de identificación por QR)
    const sc2 = { ...s, mode: 'cianotipia', cyan_mirror: true, cyan_bg: 'ahorro', out_name: 'cy', project_name: 'cy', marker_size_mm: 12, qr_on: true, qr_size_mm: 16, fmt_tiff: false };
    const cyFrames = [synthFrame(320, 180, [200, 60, 60]), synthFrame(320, 180, [40, 40, 40])];
    const cyLabels = ['cy_001', 'cy_002'];
    const cyGen = await generateSheets({
      settings: sc2,
      frames: cyFrames.map((fd, i) => ({ name: `c${i}.png`, w: 320, h: 180, hasAlpha: false, blob: null, getImageData: async () => fd })),
      labels: cyLabels,
      timeline: cyLabels.map((et, i) => ({ pos: i + 1, etiqueta: et, rep: et })),
      videoMeta: {}, keepOriginals: false,
    });
    // la copia azul física: render con finish='simulate' (misma geometría)
    const items = cyFrames.map((fd, i) => ({ data: fd.data, w: fd.w, h: fd.h, hasAlpha: false, origName: `c${i}.png` }));
    const { meta, pixels } = packImageData(items);
    const sim = await run('render_sheet', {
      settings: settingsForCore(sc2), firstW: 320, firstH: 180, meta, pixels,
      labels: JSON.stringify(cyLabels), sheetNum: 1, render: true, finish: 'simulate',
    }, [pixels.buffer]);
    const cyBmp = await createImageBitmap(new Blob([sim.png], { type: 'image/png' }));
    const cc = new OffscreenCanvas(Math.round(cyBmp.width * 1.25), Math.round(cyBmp.height * 1.2));
    const cctx = cc.getContext('2d');
    cctx.fillStyle = '#a8a8a2';
    cctx.fillRect(0, 0, cc.width, cc.height);
    cctx.translate(cc.width / 2, cc.height / 2);
    cctx.rotate((-1.5 * Math.PI) / 180);
    cctx.scale(1.1, 1.1);
    cctx.drawImage(cyBmp, -cyBmp.width / 2, -cyBmp.height / 2);
    const cyScan = new Uint8Array(await (await cc.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const cyRes = await run('scan_process', {
      bytes: cyScan, name: 'cyan1.png', layout: cyGen.layoutJson, opts: '{}', claims: '{}',
    }, [cyScan.buffer]);
    const cyResult = JSON.parse(cyRes.result);
    log(`cianotipia: ok=${cyResult.ok} marcadores=${cyResult.marcadores}/${cyResult.marcadores_total} frames=${cyRes.frames.length} estrategia=${cyResult.estrategia}`);
    if (!cyResult.ok || cyRes.frames.length !== 2) throw new Error(`cianotipia falló: ${cyRes.result}`);

    // fase ①/④ con VIDEO REAL (WebCodecs): extraer y reconstruir
    try {
      const vresp = await fetch('/e2e_sample.mp4');
      if (vresp.ok) {
        const vblob = new Blob([await vresp.arrayBuffer()], { type: 'video/mp4' });
        vblob.name = 'e2e_sample.mp4';
        const { extractFrames, buildVideo } = await import('./video.js');
        const got = [];
        const meta = await extractFrames(vblob, {
          start: 0, end: 3, fps: 2,
          onFrame: async (blob) => got.push(blob),
        });
        log(`video: ${meta.count} frames extraídos a 2 fps (nativo ${meta.fps.toFixed(1)} fps)`);
        if (got.length < 5) throw new Error('incomplete video extraction');
        const getters = got.map((b) => () => createImageBitmap(b));
        const out2 = await buildVideo(getters, 2);
        log(`video reconstruido: ${out2.ext} de ${out2.bytes.length} bytes`);
        if (out2.bytes.length < 5000) throw new Error('suspiciously small output video');

        // reescalado de salida: ejercita resize_rgba (Lanczos3 del núcleo)
        const out3 = await buildVideo(getters, 2, null, { targetH: 120 });
        log(`video reescalado a 120p: ${out3.ext} de ${out3.bytes.length} bytes`);
        if (out3.bytes.length < 2000) throw new Error('scaled video output too small');

        // exportación lossless: PNG en MOV por stream copy (ffmpeg.wasm)
        const { buildVideoLossless } = await import('./video.js');
        const lossFrames = got.slice(0, 4);
        const outL = await buildVideoLossless(lossFrames, 2);
        const headL = new TextDecoder('latin1').decode(outL.bytes.slice(0, 16));
        log(`lossless MOV: ${outL.bytes.length} bytes (${outL.ext})`);
        if (outL.ext !== 'mov' || !headL.includes('ftyp')) throw new Error('lossless output is not a MOV');
        const totalPng = lossFrames.reduce((a, b) => a + b.size, 0);
        if (outL.bytes.length < totalPng) throw new Error('lossless MOV smaller than its PNG frames (not stream-copied)');
      } else {
        log('· (sin muestra de video: prueba de WebCodecs omitida)');
      }
    } catch (e) {
      throw new Error(`flujo de video: ${e.message}`);
    }

    // MOV ProRes: mediabunny abre el contenedor pero WebCodecs no decodifica
    // el códec (como los MOV HEVC 10 bits de cámara) → desvío por canDecode()
    try {
      const presp = await fetch('/e2e_sample_prores.mov');
      if (presp.ok) {
        const pblob = new Blob([await presp.arrayBuffer()], { type: 'video/quicktime' });
        pblob.name = 'e2e_sample_prores.mov';
        const { probeVideo, extractFrames } = await import('./video.js');
        const pprobe = await probeVideo(pblob);
        if (!pprobe.width) throw new Error('ProRes MOV probe returned no dimensions');
        const got = [];
        const meta = await extractFrames(pblob, { start: 0, end: 1, fps: 4, onFrame: async (b) => got.push(b) });
        log(`MOV ProRes: ${meta.count} frames extraídos vía ffmpeg.wasm (${pprobe.width}×${pprobe.height})`);
        if (got.length < 3) throw new Error(`incomplete ProRes extraction (${got.length})`);
      } else {
        log('· (sin muestra ProRes: prueba del códec no decodificable omitida)');
      }
    } catch (e) {
      throw new Error(`flujo MOV de cámara: ${e.message ?? e}`);
    }

    // AVI: extracción por el decodificador de respaldo (ffmpeg.wasm)
    try {
      const aresp = await fetch('/e2e_sample.avi');
      if (aresp.ok) {
        const ablob = new Blob([await aresp.arrayBuffer()], { type: 'video/x-msvideo' });
        ablob.name = 'e2e_sample.avi';
        const { extractFrames } = await import('./video.js');
        const got = [];
        const meta = await extractFrames(ablob, { start: 0, end: 2, fps: 3, onFrame: async (b) => got.push(b) });
        log(`AVI: ${meta.count} frames extraídos vía ffmpeg.wasm (${meta.fps} fps nativo detectado)`);
        if (got.length < 5) throw new Error(`incomplete AVI extraction (${got.length})`);
      } else {
        log('· (sin muestra AVI: prueba del decodificador de respaldo omitida)');
      }
    } catch (e) {
      throw new Error(`flujo AVI: ${e.message ?? e}`);
    }

    document.title = 'E2E-OK';
    log('✅ E2E OK');
  } catch (e) {
    document.title = 'E2E-FAIL';
    log(`❌ ${e.message ?? e}`);
    console.error(e);
  }
}

main();
