// Fase ③ — Calibración: perfil de impresora, curva de cianotipia, ColorBlocker.

import { run } from './pool.js';
import { el, toast, download, dropzone, field, numberInput, select, check, pngUrl } from './ui.js';
import * as store from './store.js';

const PAPERS = ['A4', 'A3', 'A5', 'Carta (Letter)'];

function profileSaver(kind, getData) {
  const name = el('input', { type: 'text', placeholder: 'nombre del perfil' });
  const btn = el('button', {
    class: 'btn blue small', onclick: () => {
      const n = name.value.trim();
      const data = getData();
      if (!n || !data) { toast('Analiza primero y ponle nombre al perfil.', 'err'); return; }
      store.saveProfile(kind, n, data);
      toast(`Perfil «${n}» guardado. Ya puedes usarlo en la fase ①.`, 'ok');
    },
  }, 'Guardar perfil');
  return el('div', { class: 'row tight' }, field('Guardar como', name), btn);
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
  ctx.fillText('rojo: respuesta medida · azul: curva de compensación', 8, 14);
}

export function mountPhase3(root) {
  // ── A. Impresora ──────────────────────────────────────────
  const aPaper = select(PAPERS, 'A4');
  const aDpi = numberInput(300, { min: 150, max: 600 });
  const aScanDpi = numberInput(300, { min: 0 });
  let aResult = null;
  const aOut = el('div');
  const cardA = el('div', { class: 'paper' },
    el('h2', {}, 'Perfil de impresora'),
    el('div', { class: 'hint' }, 'Mide la escala real de tu impresora, su respuesta tonal y el tamaño mínimo fiable de marcadores y QRs.'),
    el('div', { class: 'row' }, field('Papel', aPaper), field('DPI', aDpi)),
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        const png = await run('printer_test_png', { paper: aPaper.value, dpi: parseInt(aDpi.value, 10) });
        download(png, 'prueba_impresora.png', 'image/png');
        toast('Imprime la página al 100 % (sin «ajustar a página»), escanéala completa y súbela aquí.', 'ok');
      },
    }, '⬇ Descargar página de prueba'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Suelta el ESCANEO de la página impresa',
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
            el('div', { class: 'allok-box', style: 'color:inherit' },
              el('div', {}, `Escala medida: ${(aResult.scale_x * 100).toFixed(2)} % × ${(aResult.scale_y * 100).toFixed(2)} %`),
              el('div', {}, `Marcador mínimo detectado: ${aResult.marker_min_mm ?? '—'} mm → usa ≥ ${aResult.marker_recomendado_mm} mm`),
              el('div', {}, `QR mínimo legible: ${aResult.qr_min_mm ?? '—'} mm → usa ≥ ${aResult.qr_recomendado_mm} mm`),
            ),
            aResult.notas?.length ? el('ul', { class: 'warnlist', style: 'color:#8a6d3b' }, aResult.notas.map((n) => el('li', {}, n))) : '',
          );
        } catch (e) { toast(String(e.message ?? e), 'err'); }
      },
    })),
    field('DPI del escaneo (para medir la escala)', aScanDpi, 'El DPI al que escaneaste la página impresa.'),
    aOut,
    profileSaver('impresora', () => aResult),
  );

  // ── B. Curva de cianotipia ────────────────────────────────
  const bPaper = select(PAPERS, 'A4');
  const bDpi = numberInput(300, { min: 150, max: 600 });
  const bTarget = select([['kamiru21', 'Tira de 21 parches (rápida)'], ['edn256', 'Carta EDN 2.2 — 256 tonos (fina)']], 'kamiru21');
  const bInk = el('input', { type: 'color', value: '#000000' });
  const bMirror = check('Espejada (como tus negativos reales)', true);
  let bResult = null;
  const bOut = el('div');
  const bCanvas = el('canvas', { class: 'curveplot', width: 360, height: 240, style: 'width:100%; max-width:380px; margin-top:8px' });
  bCanvas.style.display = 'none';
  const cardB = el('div', { class: 'paper' },
    el('h2', {}, 'Curva de cianotipia'),
    el('div', { class: 'hint' }, 'Mide la respuesta real de TU proceso (impresora + acetato + química + sol) y construye la curva de compensación — método Easy Digital Negatives integrado.'),
    el('div', { class: 'row' }, field('Papel', bPaper), field('DPI', bDpi)),
    field('Carta', bTarget),
    el('div', { class: 'row tight' }, field('Tinta del negativo', bInk), bMirror.label),
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        const png = await run('cyan_strip_png', {
          paper: bPaper.value, dpi: parseInt(bDpi.value, 10), ink: bInk.value,
          mirror: bMirror.input.checked, target: bTarget.value,
        });
        download(png, 'carta_cianotipia.png', 'image/png');
        toast('Imprime en acetato al 100 %, expón tu cianotipia como siempre, revela, seca y escanea la COPIA AZUL (no el acetato).', 'ok');
      },
    }, '⬇ Descargar carta (negativo para acetato)'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Suelta el ESCANEO de la copia azul',
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
            el('div', { class: 'allok-box', style: 'color:inherit' },
              `Rango dinámico medido: ${(bResult.rango_dinamico * 100).toFixed(0)} % · curva de 256 puntos construida.`),
            bResult.notas?.length ? el('ul', { class: 'warnlist', style: 'color:#8a6d3b' }, bResult.notas.map((n) => el('li', {}, n))) : '',
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
  const cMirror = check('Espejada', true);
  let cResult = null;
  const cOut = el('div');
  const cardC = el('div', { class: 'paper' },
    el('h2', {}, 'EDN ColorBlocker'),
    el('div', { class: 'hint' }, '36 matices × 21 variantes: descubre qué color de tinta bloquea mejor el UV en TU impresora (el negro no siempre gana) y construye un degradado de 3 paradas.'),
    el('div', { class: 'row' }, field('Papel', cPaper), field('DPI', cDpi)),
    cMirror.label,
    el('button', {
      class: 'btn ghost small', onclick: async () => {
        const png = await run('colorblocker_png', {
          paper: cPaper.value, dpi: parseInt(cDpi.value, 10), mirror: cMirror.input.checked,
        });
        download(png, 'colorblocker.png', 'image/png');
        toast('Imprime en acetato al 100 % en MÁXIMA calidad, expón, revela, seca y escanea la copia azul.', 'ok');
      },
    }, '⬇ Descargar carta ColorBlocker'),
    el('div', { style: 'margin-top:10px' }, dropzone({
      label: 'Suelta el ESCANEO de la copia azul',
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
            el('div', { class: 'allok-box', style: 'color:inherit' },
              el('div', {}, 'Mejor bloqueador de UV: ', sw(cResult.mejor_color), el('code', {}, cResult.mejor_color)),
              el('div', { style: 'margin-top:4px' }, 'Degradado (sombras → luces): ',
                ...(cResult.stops ?? []).map((s) => sw(s[1]))),
            ),
            cResult.notas?.length ? el('ul', { class: 'warnlist', style: 'color:#8a6d3b' }, cResult.notas.map((n) => el('li', {}, n))) : '',
          );
        } catch (e) { toast(String(e.message ?? e), 'err'); }
      },
    })),
    cOut,
    profileSaver('cianotipia_color', () => cResult),
  );

  // ── exportar/importar perfiles ────────────────────────────
  const cardD = el('div', { class: 'paper' },
    el('h2', {}, 'Tus perfiles y presets'),
    el('div', { class: 'hint' }, 'Viven en este navegador. Exporta un JSON para llevarlos a otra máquina o guardarlos con el proyecto.'),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn ghost small', onclick: () => {
          download(new TextEncoder().encode(store.exportAll()), 'mxm_perfiles.json', 'application/json');
        },
      }, '⬇ Exportar todo'),
      dropzone({
        label: 'Importar perfiles (JSON)', accept: '.json',
        onFiles: async ([f]) => {
          try { store.importAll(await f.text()); toast('Perfiles importados.', 'ok'); }
          catch (e) { toast(`No se pudo importar: ${e.message}`, 'err'); }
        },
      }),
    ),
  );

  root.append(el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px' },
    cardA, cardB, cardC, cardD));
}
