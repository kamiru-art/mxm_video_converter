// Fase ③ — Calibración: perfil de impresora, curva de cianotipia, ColorBlocker.

import { run } from './pool.js';
import { el, toast, download, dropzone, field, numberInput, select, check, pngUrl } from './ui.js';
import * as store from './store.js';

const PAPERS = ['A4', 'A3', 'A5', 'Letter'];

/** Tarjeta de calibración: cabecera, entradilla y cuerpo, siempre en ese
 *  orden y siempre tres bloques. Las cuatro comparten las filas de la rejilla
 *  (ver .calib-card), y por eso el primer control de cada una arranca a la
 *  altura de sus vecinas aunque las entradillas ocupen distinto número de
 *  líneas al estrechar la ventana. */
function calibCard(title, intro, ...body) {
  return el('div', { class: 'paper calib-card' },
    el('h2', {}, title),
    el('div', { class: 'hint' }, intro),
    el('div', { class: 'calib-body' }, ...body),
  );
}

function profileSaver(kind, getData) {
  const name = el('input', { type: 'text', placeholder: 'profile name' });
  const btn = el('button', {
    class: 'btn blue small', onclick: () => {
      const n = name.value.trim();
      const data = getData();
      if (!n || !data) { toast('Analyze first and give the profile a name.', 'err'); return; }
      try {
        store.saveProfile(kind, n, data);
      } catch (e) {
        // el perfil es el resultado de imprimir, exponer, secar y escanear:
        // decir "guardado" cuando no lo está cuesta toda esa tarde otra vez
        toast(`Profile “${n}” was NOT saved. ${e.message ?? e}`, 'err');
        return;
      }
      toast(`Profile “${n}” saved. You can now use it in phase ①.`, 'ok');
    },
  }, 'Save profile');
  return el('div', { class: 'row tight' }, field('Save as', name), btn);
}

/** Dibuja respuesta medida + curva en un canvas. */
function drawCurve(canvas, { respuesta = [], lut = [] }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#F4F0E4';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#D8D2BC';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo((W * i) / 4, 0); ctx.lineTo((W * i) / 4, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke();
  }
  // diagonal de referencia
  ctx.strokeStyle = '#B9B29A'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
  ctx.setLineDash([]);
  // respuesta medida (densidad → luminancia)
  if (respuesta.length) {
    ctx.strokeStyle = '#C4533A'; ctx.lineWidth = 2;
    ctx.beginPath();
    respuesta.forEach(([d, y], i) => {
      const px = (d / 255) * W, py = H - (y / 255) * H;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  // LUT (gris → densidad)
  if (lut.length === 256) {
    ctx.strokeStyle = '#17315C'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    lut.forEach((d, g) => {
      const px = (g / 255) * W, py = H - (d / 255) * H;
      g ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  ctx.fillStyle = '#57503F';
  ctx.font = '11px IBM Plex Mono, monospace';
  ctx.fillText('red: measured response · blue: compensation curve', 8, 14);
}

export function mountPhase3(root) {
  // ── A. Impresora ──────────────────────────────────────────
  const aPaper = select(PAPERS, 'A4');
  const aDpi = numberInput(300, { min: 150, max: 600 });
  const aScanDpi = numberInput(300, { min: 0 });
  let aResult = null;
  const aOut = el('div');
  const cardA = calibCard('Printer profile',
    'Measures your printer’s real scale, its tonal response and the smallest marker and QR it still prints readably. '
    + 'Print the page at 100 %, scan it whole and drop it back here. Start with this one: phase ① uses it to compensate the paper.',
    el('div', { class: 'row' },
      field('Paper', aPaper), field('DPI', aDpi),
      field('Scan DPI', aScanDpi, 'The DPI you scanned at.'),
    ),
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        try {
          const png = await run('printer_test_png', { paper: aPaper.value, dpi: parseInt(aDpi.value, 10) });
          download(png, 'printer_test.png', 'image/png');
          toast('Print the page at 100 % (no “fit to page”), scan it whole and drop it here.', 'ok');
        } catch (e) {
          console.error(e);
          toast(`Could not build the test page: ${e.message ?? e}`, 'err');
        }
      },
    }, 'Download test page'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Drop the SCAN of the printed page',
      accept: 'image/*,.tif,.tiff',
      onFiles: async ([f]) => {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const res = await run('analyze_printer_test', {
            bytes, paper: aPaper.value, dpi: parseInt(aDpi.value, 10),
            scanDpi: parseFloat(aScanDpi.value) || 0,
          }, [bytes.buffer]);
          aResult = JSON.parse(res);
          aOut.replaceChildren(
            el('div', { class: 'allok-box' },
              el('div', {}, `Measured scale: ${(aResult.scale_x * 100).toFixed(2)} % × ${(aResult.scale_y * 100).toFixed(2)} %`),
              el('div', {}, `Smallest detected marker: ${aResult.marker_min_mm ?? '—'} mm → use ≥ ${aResult.marker_recomendado_mm} mm`),
              el('div', {}, `Smallest readable QR: ${aResult.qr_min_mm ?? '—'} mm → use ≥ ${aResult.qr_recomendado_mm} mm`),
            ),
            aResult.notas?.length ? el('ul', { class: 'warnlist' }, aResult.notas.map((n) => el('li', {}, n))) : '',
          );
        } catch (e) { toast(String(e.message ?? e), 'err'); }
      },
    })),
    aOut,
    profileSaver('impresora', () => aResult),
  );

  // ── B. Curva de cianotipia ────────────────────────────────
  const bPaper = select(PAPERS, 'A4');
  const bDpi = numberInput(300, { min: 150, max: 600 });
  const bTarget = select([['kamiru21', '21-patch strip (quick)'], ['edn256', 'EDN 2.2 chart, 256 tones (fine)']], 'kamiru21');
  const bInk = el('input', { type: 'color', value: '#000000' });
  const bMirror = check('Mirrored (like your real negatives)', true);
  let bResult = null;
  const bOut = el('div');
  const bCanvas = el('canvas', { class: 'curveplot', width: 360, height: 240, style: 'width:100%; max-width:380px; margin-top:8px' });
  bCanvas.style.display = 'none';
  const cardB = calibCard('Cyanotype curve',
    'Measures the real response of YOUR process (printer + film + chemistry + sun) and builds the compensation curve '
    + '(Easy Digital Negatives method built in). Expose the chart the way you expose your work, or the curve measures a different process.',
    el('div', { class: 'row' }, field('Paper', bPaper), field('DPI', bDpi)),
    field('Chart', bTarget),
    el('div', { class: 'row tight' }, field('Negative ink', bInk), bMirror.label),
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        try {
          const png = await run('cyan_strip_png', {
            paper: bPaper.value, dpi: parseInt(bDpi.value, 10), ink: bInk.value,
            mirror: bMirror.input.checked, target: bTarget.value,
          });
          download(png, 'cyanotype_chart.png', 'image/png');
          toast('Print on transparency film at 100 %, expose your cyanotype as usual, develop, dry and scan the BLUE PRINT (not the film).', 'ok');
        } catch (e) {
          console.error(e);
          toast(`Could not build the chart: ${e.message ?? e}`, 'err');
        }
      },
    }, 'Download chart (negative for film)'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Drop the SCAN of the blue print',
      accept: 'image/*,.tif,.tiff',
      onFiles: async ([f]) => {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const res = await run('analyze_cyan_strip', {
            bytes, paper: bPaper.value, dpi: parseInt(bDpi.value, 10),
            target: bTarget.value, ink: bInk.value,
          }, [bytes.buffer]);
          bResult = JSON.parse(res);
          bResult.respuesta = bResult.respuesta ?? [];
          bCanvas.style.display = '';
          drawCurve(bCanvas, { respuesta: bResult.respuesta, lut: bResult.lut });
          bOut.replaceChildren(
            el('div', { class: 'allok-box' },
              `Measured dynamic range: ${(bResult.rango_dinamico * 100).toFixed(0)} % · 256-point curve built.`),
            bResult.notas?.length ? el('ul', { class: 'warnlist' }, bResult.notas.map((n) => el('li', {}, n))) : '',
          );
        } catch (e) { toast(String(e.message ?? e), 'err'); }
      },
    })),
    bCanvas, bOut,
    profileSaver('cianotipia', () => bResult),
  );

  // ── C. ColorBlocker ───────────────────────────────────────
  const cPaper = select(PAPERS, 'A4');
  const cDpi = numberInput(300, { min: 150, max: 600 });
  const cMirror = check('Mirrored', true);
  let cResult = null;
  const cOut = el('div');
  const cardC = calibCard('EDN ColorBlocker',
    '36 hues × 21 variants: finds which ink color blocks UV best on YOUR printer (black doesn’t always win) and builds a 3-stop gradient. '
    + 'Print it at maximum quality; this chart is the one that suffers most from a draft setting.',
    el('div', { class: 'row' }, field('Paper', cPaper), field('DPI', cDpi)),
    cMirror.label,
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        try {
          const png = await run('colorblocker_png', {
            paper: cPaper.value, dpi: parseInt(cDpi.value, 10), mirror: cMirror.input.checked,
          });
          download(png, 'colorblocker.png', 'image/png');
          toast('Print on transparency film at 100 % at MAXIMUM quality, expose, develop, dry and scan the blue print.', 'ok');
        } catch (e) {
          console.error(e);
          toast(`Could not build the ColorBlocker chart: ${e.message ?? e}`, 'err');
        }
      },
    }, 'Download ColorBlocker chart'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Drop the SCAN of the blue print',
      accept: 'image/*,.tif,.tiff',
      onFiles: async ([f]) => {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const res = await run('analyze_colorblocker', {
            bytes, paper: cPaper.value, dpi: parseInt(cDpi.value, 10),
          }, [bytes.buffer]);
          cResult = JSON.parse(res);
          const sw = (hex) => el('span', {
            style: `display:inline-block; width:22px; height:22px; border-radius:4px; background:${hex}; border:1px solid #0003; vertical-align:middle; margin:0 4px`,
            title: hex,
          });
          cOut.replaceChildren(
            el('div', { class: 'allok-box' },
              el('div', {}, 'Best UV blocker: ', sw(cResult.mejor_color), el('code', {}, cResult.mejor_color)),
              el('div', { style: 'margin-top:4px' }, 'Gradient (shadows → highlights): ',
                ...(cResult.stops ?? []).map((s) => sw(s[1]))),
            ),
            cResult.notas?.length ? el('ul', { class: 'warnlist' }, cResult.notas.map((n) => el('li', {}, n))) : '',
          );
        } catch (e) { toast(String(e.message ?? e), 'err'); }
      },
    })),
    cOut,
    profileSaver('cianotipia_color', () => cResult),
  );

  // ── exportar/importar perfiles ────────────────────────────
  const cardD = calibCard('Your profiles & presets',
    'They live in this browser, not in a server, so clearing site data takes them with it. Export a JSON to move them to '
    + 'another machine, to keep them beside the project, or simply to have a copy of an afternoon you cannot repeat.',
    // rotuladas como los campos de las otras tarjetas: así las cuatro
    // arrancan su primer control a la misma altura
    el('div', { class: 'row' },
      // aria-describedby y no <label>: envolver un botón en una etiqueta le
      // reenviaría el clic. Sin esto el rótulo sería texto suelto y la
      // distinción que lleva no llegaría a un lector de pantalla.
      el('div', { class: 'field' }, el('span', { id: 'calib-export-cap' }, 'Save a copy'),
        el('button', {
          class: 'btn ghost small', style: 'width:100%', 'aria-describedby': 'calib-export-cap',
          onclick: () => {
            download(new TextEncoder().encode(store.exportAll()), 'mxm_profiles.json', 'application/json');
          },
        }, 'Export everything')),
      el('div', { class: 'field' }, el('span', { id: 'calib-import-cap' }, 'Bring some back'),
        dropzone({
          label: 'Import profiles (JSON)', accept: '.json',
          describedBy: 'calib-import-cap',
          onFiles: async ([f]) => {
            try { store.importAll(await f.text()); toast('Profiles imported.', 'ok'); }
            catch (e) { toast(`Import failed: ${e.message}`, 'err'); }
          },
        })),
    ),
  );

  root.append(el('div', { class: 'calib-grid' }, cardA, cardB, cardC, cardD));
}
