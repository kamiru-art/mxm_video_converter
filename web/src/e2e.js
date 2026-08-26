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

    // fase ①: generar una hoja con 4 frames sintéticos
    const s = { ...defaultSettings(), dpi: 150, cols: 2, rows: 2, project_name: 'e2e', out_name: 'e2e', marker_size_mm: 10, qr_size_mm: 14 };
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
    const sheetPng = out.files.get('e2e_p1.png');
    if (!sheetPng) throw new Error('no se generó la hoja');
    log(`hoja generada (${sheetPng.length} bytes), PDF: ${out.files.has('e2e.pdf')}, layout: ${!!out.layoutJson}`);

    // "escanear": dibujar la hoja rotada 2° sobre un lienzo mayor
    const bmp = await createImageBitmap(new Blob([sheetPng], { type: 'image/png' }));
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

    // fase ②: procesar
    const res = await run('scan_process', {
      bytes: scanBytes, name: 'scan1.png', layout: out.layoutJson,
      opts: '{}', claims: '{}',
    }, [scanBytes.buffer]);
    const result = JSON.parse(res.result);
    log(`scan ok=${result.ok} hoja=${result.hoja_numero} marcadores=${result.marcadores}/${result.marcadores_total} escala=${result.escala} frames=${res.frames.length}`);
    if (!result.ok || res.frames.length !== 4) throw new Error(`fase ② falló: ${res.result}`);

    // fase ③: página de prueba de impresora + autoanálisis
    const test = await run('printer_test_png', { paper: 'A4', dpi: 150 });
    const testCopy = new Uint8Array(test);
    const prof = JSON.parse(await run('analyze_printer_test', { bytes: testCopy, paper: 'A4', dpi: 150, scanDpi: 150 }, [testCopy.buffer]));
    log(`calibración: escala ${prof.scale_x}×${prof.scale_y}, marcador mín ${prof.marker_min_mm} mm, QR mín ${prof.qr_min_mm} mm`);
    if (Math.abs(prof.scale_x - 1) > 0.01) throw new Error('escala de impresora incorrecta');

    // ☀️ cianotipia: negativo → copia azul simulada → escaneo → procesado
    const sc2 = { ...s, mode: 'cianotipia', cyan_mirror: true, cyan_bg: 'ahorro', out_name: 'cy', project_name: 'cy', marker_size_mm: 12, qr_size_mm: 16 };
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

    document.title = 'E2E-OK';
    log('✅ E2E OK');
  } catch (e) {
    document.title = 'E2E-FAIL';
    log(`❌ ${e.message ?? e}`);
    console.error(e);
  }
}

main();
