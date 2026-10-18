// Fase ③ — Calibración: perfil de impresora y curva de cianotipia.

import { errMsg } from './errors.ts';
import { tr } from './i18n.ts';
import { run } from './pool.ts';
import type { ProfileKind, ProfileMap } from './store.ts';
import * as store from './store.ts';
import type { CyanProfile, PrinterProfile } from './types.ts';
import type { Child, SelectOption } from './ui.ts';
import { download, dropzone, el, field, numberInput, select, setOptions, toast } from './ui.ts';

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
  onSaved?: () => void,
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
        onSaved?.();
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
  ctx.fillText(tr('red: measured response · blue: compensation curve'), 8, 14);
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

  // ── B. Curva de cianotipia (carta EDN 2.2, 256 tonos) ─────
  const bPaper = select(PAPERS, 'A4');
  const bDpi = numberInput(300, { min: 150, max: 600 });
  const bInk = el('input', { type: 'color', value: '#000000' });
  // Segunda pasada: la carta se imprime con una curva ya guardada y el
  // análisis mide lo que esa curva no corrigió. La curva que sale ya la
  // incluye: se guarda y se usa EN LUGAR de la primera.
  const priorOptions = (): SelectOption[] => [
    ['', '(none: first pass)'],
    ...store.listProfiles('cianotipia').map((n): SelectOption => [n, n]),
  ];
  const bPrior = select(priorOptions(), '');
  // los nombres los puso el usuario: el traductor (i18n.ts) no los toca
  bPrior.dataset.i18n = 'names';
  const refreshPriors = (): void => {
    const keep = bPrior.value;
    setOptions(bPrior, priorOptions());
    bPrior.value = store.listProfiles('cianotipia').includes(keep) ? keep : '';
  };
  const priorLut = (): number[] | null =>
    bPrior.value ? (store.loadProfile('cianotipia', bPrior.value)?.lut ?? null) : null;
  /** Curva con la que se descargó la última carta en esta sesión ('' = sin
   *  curva; null = no se descargó ninguna): medir con otra daría una curva
   *  equivocada sin ningún error. */
  let downloadedWith: string | null = null;
  let bResult: CyanProfile | null = null;
  /** Zona de un archivo a la vista, pero acepta varios (se promedian, ver
   *  «Advanced options»): con `multiple` mostraría además el botón de carpeta. */
  const bZone = (opts: Parameters<typeof dropzone>[0]): HTMLDivElement => {
    const zone = dropzone(opts);
    const input = zone.querySelector('input[type=file]');
    if (input instanceof HTMLInputElement) input.multiple = true;
    return zone;
  };
  const bOut = el('div');
  const bCanvas = el('canvas', {
    class: 'curveplot',
    width: 360,
    height: 240,
    style: 'width:100%; max-width:380px; margin-top:8px',
  });
  bCanvas.style.display = 'none';
  // la leyenda va dibujada: al cambiar de idioma se vuelve a dibujar
  document.addEventListener('mxm:lang', () => {
    if (bResult) drawCurve(bCanvas, { respuesta: bResult.respuesta, lut: bResult.lut });
  });
  root.addEventListener('mxm:activated', refreshPriors);
  const cardB = calibCard(
    'Cyanotype curve',
    'Measures the response of your process (printer, film, chemistry, light) and builds the compensation curve ' +
      'with the 256-tone chart of Easy Digital Negatives 2.2. Expose the chart exactly as you expose your work.',
    el('div', { class: 'row' }, field('Paper', bPaper), field('DPI', bDpi)),
    field('Negative ink', bInk),
    // lo opcional va plegado: a la vista, la carta se ve como un solo paso
    el(
      'details',
      { class: 'adv' },
      el('summary', {}, 'Advanced options'),
      el(
        'div',
        { class: 'hint' },
        'Several prints: drop the scans of several prints of the same chart together and the app averages them. It helps when a print came out uneven.',
      ),
      field('Curve already on the chart', bPrior),
      el(
        'div',
        { class: 'hint' },
        'Second pass: pick the curve you saved from the first chart. The chart prints with it, and the new analysis corrects what it left. Save the result and use it instead of the first curve.',
      ),
    ),
    el(
      'button',
      {
        class: 'btn ghost small',
        onclick: async () => {
          try {
            const prior = priorLut();
            const png = await run('cyan_chart_png', {
              paper: bPaper.value,
              dpi: parseInt(bDpi.value, 10),
              ink: bInk.value,
              prior: prior ? JSON.stringify(prior) : 'null',
            });
            downloadedWith = bPrior.value;
            download(
              png,
              prior ? 'cyanotype_chart_2nd_pass.png' : 'cyanotype_chart.png',
              'image/png',
            );
            toast(
              'Print on transparency film at 100 %, in colour mode (not grayscale), expose your cyanotype as usual, develop, dry and scan the BLUE PRINT (not the film).',
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
      bZone({
        label: 'Drop the SCAN of the blue print',
        accept: 'image/*,.tif,.tiff',
        onFiles: async (files) => {
          try {
            if (downloadedWith !== null && downloadedWith !== bPrior.value) {
              toast(
                'The last chart you downloaded used a different “Curve already on the chart”. Pick the one it was printed with, or the curve will be wrong.',
                'err',
              );
              return;
            }
            const scans = await Promise.all(
              files.map(async (f) => new Uint8Array(await f.arrayBuffer())),
            );
            const prior = priorLut();
            const res = await run(
              'analyze_cyan_chart',
              {
                scans,
                paper: bPaper.value,
                dpi: parseInt(bDpi.value, 10),
                ink: bInk.value,
                prior: prior ? JSON.stringify(prior) : 'null',
              },
              scans.map((b) => b.buffer),
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
                el(
                  'div',
                  {},
                  `Measured dynamic range: ${((result.rango_dinamico ?? 0) * 100).toFixed(0)} % · 256-point curve built.`,
                ),
                (result.escaneos ?? 1) > 1
                  ? el('div', {}, `Average of ${result.escaneos} prints.`)
                  : '',
                result.pasada === 2
                  ? el(
                      'div',
                      {},
                      'Second pass: this curve already includes the first one. Save it and use it instead.',
                    )
                  : '',
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
    profileSaver('cianotipia', () => bResult, refreshPriors),
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

  root.append(el('div', { class: 'calib-grid' }, cardA, cardB, cardD));
}
