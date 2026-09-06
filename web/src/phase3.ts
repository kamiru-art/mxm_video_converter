// Fase ③ — Calibración: perfil de impresora, curva de cianotipia, ColorBlocker.

import { errMsg } from './errors.ts';
import { run } from './pool.ts';
import type { ProfileKind, ProfileMap } from './store.ts';
import * as store from './store.ts';
import type { ColorProfile, CyanProfile, PrinterProfile } from './types.ts';
import type { Child } from './ui.ts';
import { check, download, dropzone, el, field, numberInput, select, toast } from './ui.ts';

const PAPERS = ['A4', 'A3', 'A5', 'Letter'];

/** Tarjeta de calibración: cabecera, entradilla y cuerpo, siempre en ese
 *  orden y siempre tres bloques. Las cuatro comparten las filas de la rejilla
 *  (ver .calib-card), y por eso el primer control de cada una arranca a la
 *  altura de sus vecinas aunque las entradillas ocupen distinto número de
 *  líneas al estrechar la ventana. */
function calibCard(title: string, intro: string, ...body: Child[]): HTMLDivElement {
  return el(
    'div',
    { class: 'paper calib-card' },
    el('h2', {}, title),
    el('div', { class: 'hint' }, intro),
    el('div', { class: 'calib-body' }, ...body),
  );
}

function profileSaver<K extends ProfileKind>(
  kind: K,
  getData: () => ProfileMap[K] | null,
): HTMLDivElement {
  const name = el('input', { type: 'text', placeholder: 'profile name' });
  const btn = el(
    'button',
    {
      class: 'btn blue small',
      onclick: () => {
        const n = name.value.trim();
        const data = getData();
        if (!n || !data) {
          toast('Analyze first and give the profile a name.', 'err');
          return;
        }
        try {
          store.saveProfile(kind, n, data);
        } catch (e) {
          // el perfil es el resultado de imprimir, exponer, secar y escanear:
          // decir "guardado" cuando no lo está cuesta toda esa tarde otra vez
          toast(`Profile “${n}” was NOT saved. ${errMsg(e)}`, 'err');
          return;
        }
        toast(`Profile “${n}” saved. You can now use it in phase ①.`, 'ok');
      },
    },
    'Save profile',
  );
  return el('div', { class: 'row tight' }, field('Save as', name), btn);
}

/** Dibuja respuesta medida + curva en un canvas. */
function drawCurve(
  canvas: HTMLCanvasElement,
  { respuesta = [], lut = [] }: { respuesta?: [number, number][]; lut?: number[] },
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width,
    H = canvas.height;
  ctx.fillStyle = '#F4F0E4';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#D8D2BC';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo((W * i) / 4, 0);
    ctx.lineTo((W * i) / 4, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, (H * i) / 4);
    ctx.lineTo(W, (H * i) / 4);
    ctx.stroke();
  }
  // diagonal de referencia
  ctx.strokeStyle = '#B9B29A';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(W, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  // respuesta medida (densidad → luminancia)
  if (respuesta.length) {
    ctx.strokeStyle = '#C4533A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    respuesta.forEach(([d, y], i) => {
      const px = (d / 255) * W,
        py = H - (y / 255) * H;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  // LUT (gris → densidad)
  if (lut.length === 256) {
    ctx.strokeStyle = '#17315C';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    lut.forEach((d, g) => {
      const px = (g / 255) * W,
        py = H - (d / 255) * H;
      if (g) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  ctx.fillStyle = '#57503F';
  ctx.font = '11px IBM Plex Mono, monospace';
  ctx.fillText('red: measured response · blue: compensation curve', 8, 14);
}

export function mountPhase3(root: HTMLElement): void {
  // ── A. Impresora ──────────────────────────────────────────
  const aPaper = select(PAPERS, 'A4');
  const aDpi = numberInput(300, { min: 150, max: 600 });
  const aScanDpi = numberInput(300, { min: 0 });
  let aResult: PrinterProfile | null = null;
  const aOut = el('div');
  const cardA = calibCard(
    'Printer profile',
    'Measures the real print scale, the tonal response and the smallest marker and QR your printer still prints legibly. ' +
      'Print at 100 %, scan the whole page and drop it here. Phase ① uses this profile to correct the scale.',
    el(
      'div',
      { class: 'row' },
      field('Paper', aPaper),
      field('DPI', aDpi),
      field('Scan DPI', aScanDpi, 'The DPI you scanned at.'),
    ),
    el(
      'button',
      {
        class: 'btn ghost small',
        onclick: async () => {
          try {
            const png = await run('printer_test_png', {
              paper: aPaper.value,
              dpi: parseInt(aDpi.value, 10),
            });
            download(png, 'printer_test.png', 'image/png');
            toast(
              'Print the page at 100 % (no “fit to page”), scan it whole and drop it here.',
              'ok',
            );
          } catch (e) {
            console.error(e);
            toast(`Could not build the test page: ${errMsg(e)}`, 'err');
          }
        },
      },
      'Download test page',
    ),
    el(
      'div',
      { style: 'margin-top:10px' },
      dropzone({
        label: 'Drop the SCAN of the printed page',
        accept: 'image/*,.tif,.tiff',
        onFiles: async ([f]) => {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const res = await run(
              'analyze_printer_test',
              {
                bytes,
                paper: aPaper.value,
                dpi: parseInt(aDpi.value, 10),
                scanDpi: parseFloat(aScanDpi.value) || 0,
              },
              [bytes.buffer],
            );
            const result = JSON.parse(res) as PrinterProfile;
            aResult = result;
            aOut.replaceChildren(
              el(
                'div',
                { class: 'allok-box' },
                el(
                  'div',
                  {},
                  `Measured scale: ${(result.scale_x * 100).toFixed(2)} % × ${(result.scale_y * 100).toFixed(2)} %`,
                ),
                el(
                  'div',
                  {},
                  `Smallest detected marker: ${result.marker_min_mm ?? '—'} mm → use ≥ ${result.marker_recomendado_mm} mm`,
                ),
                el(
                  'div',
                  {},
                  `Smallest readable QR: ${result.qr_min_mm ?? '—'} mm → use ≥ ${result.qr_recomendado_mm} mm`,
                ),
              ),
              result.notas?.length
                ? el(
                    'ul',
                    { class: 'warnlist' },
                    result.notas.map((n) => el('li', {}, n)),
                  )
                : '',
            );
          } catch (e) {
            toast(errMsg(e), 'err');
          }
        },
      }),
    ),
    aOut,
    profileSaver('impresora', () => aResult),
  );

  // ── B. Curva de cianotipia ────────────────────────────────
  const bPaper = select(PAPERS, 'A4');
  const bDpi = numberInput(300, { min: 150, max: 600 });
  const bTarget = select(
    [
      ['kamiru21', '21-patch strip (quick)'],
      ['edn256', 'EDN 2.2 chart, 256 tones (fine)'],
    ],
    'kamiru21',
  );
  const bInk = el('input', { type: 'color', value: '#000000' });
  const bMirror = check('Mirrored (like your real negatives)', true);
  let bResult: CyanProfile | null = null;
  const bOut = el('div');
  const bCanvas = el('canvas', {
    class: 'curveplot',
    width: 360,
    height: 240,
    style: 'width:100%; max-width:380px; margin-top:8px',
  });
  bCanvas.style.display = 'none';
  const cardB = calibCard(
    'Cyanotype curve',
    'Measures the response of your process (printer, film, chemistry, light) and builds the compensation curve ' +
      '(Easy Digital Negatives method). Expose the chart exactly as you expose your work.',
    el('div', { class: 'row' }, field('Paper', bPaper), field('DPI', bDpi)),
    field('Chart', bTarget),
    el('div', { class: 'row tight' }, field('Negative ink', bInk), bMirror.label),
    el(
      'button',
      {
        class: 'btn ghost small',
        onclick: async () => {
          try {
            const png = await run('cyan_strip_png', {
              paper: bPaper.value,
              dpi: parseInt(bDpi.value, 10),
              ink: bInk.value,
              mirror: bMirror.input.checked,
              target: bTarget.value,
            });
            download(png, 'cyanotype_chart.png', 'image/png');
            toast(
              'Print on transparency film at 100 %, expose your cyanotype as usual, develop, dry and scan the BLUE PRINT (not the film).',
              'ok',
            );
          } catch (e) {
            console.error(e);
            toast(`Could not build the chart: ${errMsg(e)}`, 'err');
          }
        },
      },
      'Download chart (negative for film)',
    ),
    el(
      'div',
      { style: 'margin-top:10px' },
      dropzone({
        label: 'Drop the SCAN of the blue print',
        accept: 'image/*,.tif,.tiff',
        onFiles: async ([f]) => {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const res = await run(
              'analyze_cyan_strip',
              {
                bytes,
                paper: bPaper.value,
                dpi: parseInt(bDpi.value, 10),
                target: bTarget.value,
                ink: bInk.value,
              },
              [bytes.buffer],
            );
            const result = JSON.parse(res) as CyanProfile;
            result.respuesta = result.respuesta ?? [];
            bResult = result;
            bCanvas.style.display = '';
            drawCurve(bCanvas, { respuesta: result.respuesta, lut: result.lut });
            bOut.replaceChildren(
              el(
                'div',
                { class: 'allok-box' },
                `Measured dynamic range: ${((result.rango_dinamico ?? 0) * 100).toFixed(0)} % · 256-point curve built.`,
              ),
              result.notas?.length
                ? el(
                    'ul',
                    { class: 'warnlist' },
                    result.notas.map((n) => el('li', {}, n)),
                  )
                : '',
            );
          } catch (e) {
            toast(errMsg(e), 'err');
          }
        },
      }),
    ),
    bCanvas,
    bOut,
    profileSaver('cianotipia', () => bResult),
  );

  // ── C. ColorBlocker ───────────────────────────────────────
  const cPaper = select(PAPERS, 'A4');
  const cDpi = numberInput(300, { min: 150, max: 600 });
  const cMirror = check('Mirrored', true);
  let cResult: ColorProfile | null = null;
  const cOut = el('div');
  const cardC = calibCard(
    'EDN ColorBlocker',
    '36 hues × 21 variants: finds the ink color that blocks UV best on your printer (not always black) and builds a 3-stop gradient. ' +
      'Print at maximum quality: a draft setting ruins this chart.',
    el('div', { class: 'row' }, field('Paper', cPaper), field('DPI', cDpi)),
    cMirror.label,
    el(
      'button',
      {
        class: 'btn ghost small',
        onclick: async () => {
          try {
            const png = await run('colorblocker_png', {
              paper: cPaper.value,
              dpi: parseInt(cDpi.value, 10),
              mirror: cMirror.input.checked,
            });
            download(png, 'colorblocker.png', 'image/png');
            toast(
              'Print on transparency film at 100 % at MAXIMUM quality, expose, develop, dry and scan the blue print.',
              'ok',
            );
          } catch (e) {
            console.error(e);
            toast(`Could not build the ColorBlocker chart: ${errMsg(e)}`, 'err');
          }
        },
      },
      'Download ColorBlocker chart',
    ),
    el(
      'div',
      { style: 'margin-top:10px' },
      dropzone({
        label: 'Drop the SCAN of the blue print',
        accept: 'image/*,.tif,.tiff',
        onFiles: async ([f]) => {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const res = await run(
              'analyze_colorblocker',
              {
                bytes,
                paper: cPaper.value,
                dpi: parseInt(cDpi.value, 10),
              },
              [bytes.buffer],
            );
            const result = JSON.parse(res) as ColorProfile;
            cResult = result;
            const sw = (hex: string): HTMLSpanElement =>
              el('span', {
                style: `display:inline-block; width:22px; height:22px; border-radius:4px; background:${hex}; border:1px solid #0003; vertical-align:middle; margin:0 4px`,
                title: hex,
              });
            cOut.replaceChildren(
              el(
                'div',
                { class: 'allok-box' },
                el(
                  'div',
                  {},
                  'Best UV blocker: ',
                  sw(result.mejor_color),
                  el('code', {}, result.mejor_color),
                ),
                el(
                  'div',
                  { style: 'margin-top:4px' },
                  'Gradient (shadows → highlights): ',
                  ...(result.stops ?? []).map((s) => sw(s[1])),
                ),
              ),
              result.notas?.length
                ? el(
                    'ul',
                    { class: 'warnlist' },
                    result.notas.map((n) => el('li', {}, n)),
                  )
                : '',
            );
          } catch (e) {
            toast(errMsg(e), 'err');
          }
        },
      }),
    ),
    cOut,
    profileSaver('cianotipia_color', () => cResult),
  );

  // ── exportar/importar perfiles ────────────────────────────
  const cardD = calibCard(
    'Your profiles & presets',
    'Stored in this browser only: clearing site data deletes them. Export a JSON to move them to another machine ' +
      'or to keep a copy with the project.',
    // rotuladas como los campos de las otras tarjetas: así las cuatro
    // arrancan su primer control a la misma altura
    el(
      'div',
      { class: 'row' },
      // aria-describedby y no <label>: envolver un botón en una etiqueta le
      // reenviaría el clic. Sin esto el rótulo sería texto suelto y la
      // distinción que lleva no llegaría a un lector de pantalla.
      el(
        'div',
        { class: 'field' },
        el('span', { id: 'calib-export-cap' }, 'Save a copy'),
        el(
          'button',
          {
            class: 'btn ghost small',
            style: 'width:100%',
            'aria-describedby': 'calib-export-cap',
            onclick: () => {
              download(
                new TextEncoder().encode(store.exportAll()),
                'mxm_profiles.json',
                'application/json',
              );
            },
          },
          'Export everything',
        ),
      ),
      el(
        'div',
        { class: 'field' },
        el('span', { id: 'calib-import-cap' }, 'Bring some back'),
        dropzone({
          label: 'Import profiles (JSON)',
          accept: '.json',
          describedBy: 'calib-import-cap',
          onFiles: async ([f]) => {
            try {
              store.importAll(await f.text());
              toast('Profiles imported.', 'ok');
            } catch (e) {
              toast(`Import failed: ${errMsg(e)}`, 'err');
            }
          },
        }),
      ),
    ),
  );

  root.append(el('div', { class: 'calib-grid' }, cardA, cardB, cardC, cardD));
}
