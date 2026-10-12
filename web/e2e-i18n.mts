// Prueba de punta a punta del IDIOMA, a clics, sobre el index.html real. La
// interfaz se escribe en inglés y i18n.ts la traduce al vuelo; lo que puede
// fallar es que un texto llegue sin traducción, que al volver al inglés
// quede algo en español, que el idioma no se recuerde, o que un texto más
// largo rompa la página en un teléfono. Así que, en cada ventana:
//
//   1. se montan todas las vistas en inglés y se guarda su texto;
//      ES → EN tiene que devolver EXACTAMENTE ese texto
//   2. en español, el recorrido completo: el ejemplo → hojas → escaneos
//      simulados → informe y vista ampliada → MOV, ZIP de PNG y MP4 →
//      vista previa → calibración → ayuda. Los botones se buscan por su
//      texto en español (el del diccionario): si no está, la prueba falla
//   3. nada se sale por la derecha en ninguna vista, y una captura de cada una
//   4. lo que llegó al documento sin traducción (i18n.ts lo apunta): nada
//   5. EN otra vez: ningún texto del diccionario en español queda en la
//      página; ES otra vez: el mismo texto que antes
//   6. al recargar, sigue en español
//
//   npm run test:i18n                        Chrome, escritorio y móvil
//   npm run test:i18n -- --browser=zen       Zen (o Firefox)
//   npm run test:i18n -- --browser=safari    Safari
//
// Artefacto: artifacts/e2e/i18n.<navegador>.json con cada comprobación y lo
// que quedó sin traducir, y las capturas en artifacts/e2e/i18n/<navegador>-<ventana>/.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, Viewport } from './e2e-browsers.mts';
import { browserFromArgs, launch, serveDist } from './e2e-browsers.mts';
import { HELP_ES } from './src/help-es.ts';
import { EXACT, TEMPLATES } from './src/i18n-es.ts';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));
const which = browserFromArgs();
const VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844, mobile: true },
};
const VIEWS = ['sheets', 'scans', 'video', 'calibration', 'help'];

/** El texto en español de un botón o rótulo, del diccionario: si falta, la
 *  prueba falla aquí y no esperando a un botón que no existe. */
function es(en: string, ...args: string[]): string {
  const v = EXACT[en] ?? TEMPLATES.find(([k]) => k === en)?.[1];
  if (!v) throw new Error(`no Spanish for "${en}" in i18n-es.ts`);
  return v.replace(/\{#?(\d)\}/g, (_, i: string) => args[Number(i)] ?? '');
}
/** El trozo fijo más largo del español de la plantilla cuyo inglés empieza
 *  por `enStart`: lo que tiene que verse de un texto compuesto. */
function esFixed(enStart: string): string {
  const t = TEMPLATES.find(([k]) => k.startsWith(enStart));
  if (!t) throw new Error(`no template for "${enStart}" in i18n-es.ts`);
  return t[1]
    .split(/\{#?\d\}/)
    .sort((a, b) => b.length - a.length)[0]
    .trim();
}
/** Los títulos de la ayuda en español, tal como los escribe help-es.ts. */
const HELP_HEADINGS = [...HELP_ES.matchAll(/<h[23]>([^<]*)<\/h[23]>/g)].map((m) => m[1].trim());
/** Un literal de expresión regular para el código que corre en la página;
 *  `start`: anclado al principio. */
const rx = (s: string, start = false): string =>
  `/${start ? '^' : ''}${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`;

/** Los textos en español que no son también un texto en inglés: si alguno
 *  queda en la página en inglés, la vuelta al inglés falló. */
const SPANISH_ONLY = [
  ...new Set(Object.values(EXACT).filter((v) => !(v in EXACT) && /[a-zñáéíóú]{3}/i.test(v))),
];
/** Y los trozos fijos largos de las plantillas en español: un texto compuesto
 *  que se quedara en español los contiene. */
const SPANISH_PIECES = [
  ...new Set(
    TEMPLATES.flatMap(([, v]) => v.split(/\{#?\d\}/))
      .map((p) => p.trim())
      .filter(
        (p) =>
          p.length >= 16 &&
          !Object.keys(EXACT).some((k) => k.includes(p)) &&
          !TEMPLATES.some(([k]) => k.includes(p)),
      ),
  ),
];
/** El español de cada plantilla como patrón (los huecos, cualquier cosa),
 *  salvo las que se escriben igual en inglés: un texto compuesto que quede
 *  en español al volver al inglés encaja en uno, por corto que sea («Hoja 3»). */
const toPattern = (t: string): string =>
  `^${t
    .split(/\{#?\d\}/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+?')}$`;
const SPANISH_TEMPLATES = TEMPLATES.filter(
  ([en, v]) => /[a-zñáéíóú]{3}/i.test(v.replace(/\{#?\d\}/g, '')) && toPattern(en) !== toPattern(v),
).map(([, v]) => toPattern(v));
/** Los textos en inglés de la interfaz cuyo español es otro: ninguno puede
 *  verse tal cual en la página en español. Un oráculo que no depende de lo
 *  que el traductor apunta como no traducido. */
const ENGLISH_ONLY = Object.entries(EXACT)
  .filter(([k, v]) => k !== v && /[a-z]{3} [a-z]{3}/i.test(k))
  .map(([k]) => k);

const INSTRUMENT = `
  if (window.__ui) return true;
  // los nodos, no su texto: este observador va antes que el de i18n.ts y
  // vería el aviso aún en inglés; se lee cuando se pregunta, ya traducido
  const toastNodes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) toastNodes.push(n);
  }).observe(document.getElementById('toasts'), { childList: true });
  const toasts = { get length() { return toastNodes.length; }, slice: (i) => toastNodes.slice(i).map((n) => n.className + ': ' + n.textContent), join: (s) => toasts.slice(0).join(s) };
  const downloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download')) return click.call(this);
    const name = this.getAttribute('download');
    fetch(this.href).then((r) => r.blob()).then((blob) => downloads.push({ name, blob }));
  };
  window.confirm = () => true;
  window.__ui = {
    toasts,
    downloads,
    button(re) {
      return [...document.querySelectorAll('button')].find(
        (b) => re.test(b.textContent) && b.offsetParent !== null,
      );
    },
    async until(fn, ms, what) {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out: ' + what + ' | toasts: ' + toasts.join(' / '));
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    overflow() {
      return document.documentElement.scrollWidth - window.innerWidth;
    },
    /** Todo el texto de la página, nodo a nodo, con los atributos que se
     *  leen: lo que tiene que volver igual tras ES → EN. */
    snapshot() {
      const out = [document.title];
      const it = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = it.currentNode; n; n = it.nextNode()) {
        if (n.nodeType === 3) { if (n.data.trim()) out.push(n.data); }
        else for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
          const v = n.getAttribute(a);
          if (v) out.push('@' + a + '=' + v);
        }
      }
      return out;
    },
    /** Dónde están la marca, cada pestaña, el indicador, el selector y el
     *  principio de la vista: nada de eso puede moverse al cambiar de idioma. */
    header() {
      const out = {};
      // de la vista, sólo dónde empieza: su alto es el de su texto
      const put = (k, el, whole = true) => {
        const b = el?.getBoundingClientRect();
        const v = b && (whole ? [b.left, b.top, b.width, b.height] : [b.left, b.top]);
        out[k] = v ? v.map((x) => Math.round(x * 10) / 10).join(',') : 'missing';
      };
      put('wordmark', document.querySelector('.wordmark'));
      put('strip', document.getElementById('phase-nav'));
      document.querySelectorAll('#phase-nav .frame').forEach((f) => put('tab ' + f.dataset.view, f));
      put('badge', document.getElementById('capbadge'));
      put('switch', document.getElementById('lang-switch'));
      put('view', document.getElementById('views'), false);
      return out;
    },
    async lang(l) {
      document.querySelector('#lang-switch [data-lang="' + l + '"]').click();
      // el español se carga la primera vez: se espera a que llegue
      await this.until(() => document.documentElement.lang === l, 10000, 'the language ' + l);
      await new Promise((r) => setTimeout(r, 300));
      return document.documentElement.lang;
    },
  };
  return true;
`;

const step = (body: string): string => `const ui = window.__ui; ${body}`;

async function openApp(driver: Driver, port: number, view: string): Promise<void> {
  await driver.open(`http://127.0.0.1:${port}/#${view}`);
  await driver.run(`
    const t0 = Date.now();
    while (!document.querySelector('#view-${view} .paper, #view-${view} .prose')) {
      if (Date.now() - t0 > 30000) throw new Error('the page did not mount');
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;`);
  await driver.run(INSTRUMENT);
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function runFlow(
  driver: Driver,
  port: number,
  shots: string,
): Promise<{ checks: Check[]; misses: string[] }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  };
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(shots, `${name}.png`), await driver.screenshot());
  };
  const goto = (view: string): Promise<unknown> =>
    driver.run(
      step(
        `location.hash = '#${view}'; await new Promise((r) => setTimeout(r, 600)); return true;`,
      ),
    );
  const screen = async (view: string): Promise<void> => {
    await goto(view);
    const over = await driver.run<number>(step('return ui.overflow();'));
    check(`es ${view}: no sideways scroll`, over <= 0, `${over} px wider than the window`);
    await shot(view);
  };

  // 1. inglés por defecto, y la ida y vuelta con todas las vistas montadas
  await openApp(driver, port, 'sheets');
  for (const v of VIEWS) await goto(v);
  await goto('sheets');
  const start = await driver.run<{ lang: string; pressed: string | null; nav: string }>(
    step(`return {
      lang: document.documentElement.lang,
      pressed: document.querySelector('#lang-switch [aria-pressed="true"]')?.dataset.lang ?? null,
      nav: document.querySelector('#phase-nav .fname').textContent,
    };`),
  );
  check(
    'English by default',
    start.lang === 'en' && start.pressed === 'en' && start.nav === 'Sheets',
    `lang=${start.lang}, pressed=${start.pressed}, first tab "${start.nav}"`,
  );
  await shot('header-en');
  const en0 = await driver.run<string[]>(step('return ui.snapshot();'));
  // el indicador aparece cuando el navegador dice si hay GPU: antes, la
  // cabecera aún no tiene su ancho final
  await driver.run(
    step(
      `return ui.until(() => !document.getElementById('capbadge').hidden, 15000, 'the WebGPU badge');`,
    ),
  );
  const toEs = await driver.run<{
    lang: string;
    nav: string;
    title: string;
    changed: number;
    moved: string[];
    parts: number;
  }>(
    step(`
    const before = ui.snapshot();
    const head = ui.header();
    const lang = await ui.lang('es');
    const after = ui.snapshot();
    const headEs = ui.header();
    return {
      moved: Object.keys(head).filter((k) => head[k] !== headEs[k]).map((k) => k + ' ' + head[k] + ' → ' + headEs[k]),
      parts: Object.values(head).filter((v) => v !== 'missing').length,
      lang,
      nav: document.querySelector('#phase-nav .fname').textContent,
      title: document.title,
      changed: after.filter((t, i) => t !== before[i]).length,
    };`),
  );
  check(
    'ES switches the page at once, without reloading',
    toEs.lang === 'es' &&
      toEs.nav === es('Sheets') &&
      toEs.changed > 100 &&
      toEs.title === es('MXM Studio: mixed media & cyanotype animation, free forever'),
    `lang=${toEs.lang}, first tab "${toEs.nav}", ${toEs.changed} texts changed, title "${toEs.title}"`,
  );
  check(
    'the header stays put when switching to ES',
    toEs.moved.length === 0 && toEs.parts === 10,
    toEs.moved.length
      ? toEs.moved.join(' | ')
      : `${toEs.parts} parts (title, tabs, badge, switch, view) at the same place and size`,
  );
  await shot('header-es');
  const en1 = await driver.run<string[]>(step(`await ui.lang('en'); return ui.snapshot();`));
  const diff = en0.flatMap((t, i) => (t === en1[i] ? [] : [`"${t}" → "${en1[i]}"`]));
  check(
    'ES → EN gives back exactly the English page',
    en0.length === en1.length && diff.length === 0,
    diff.length ? diff.slice(0, 8).join(' | ') : `${en0.length} texts, all identical`,
  );

  // 2. el recorrido completo en español
  await driver.run(step(`await ui.lang('es'); return true;`));
  await screen('sheets');
  const sheets = await driver.run<string>(
    step(`
    ui.button(${rx(es('Try it with a {#0}-frame example', '6'))}).click();
    await ui.until(() => ui.button(${rx(es('Generate sheets (ZIP)'), true)}) && !ui.button(${rx(es('Generate sheets (ZIP)'), true)}).disabled && document.querySelectorAll('#view-sheets .thumb').length, 60000, 'the example');
    await new Promise((r) => setTimeout(r, 500));
    ui.button(${rx(es('Generate sheets (ZIP)'), true)}).click();
    const zip = await ui.until(() => ui.downloads.find((d) => /\\.zip$/.test(d.name)), 180000, 'the sheets ZIP');
    return zip.name + ' ' + zip.blob.size + ' bytes';`),
  );
  check('es: sheets generated and downloaded', /\.zip \d+ bytes$/.test(sheets), sheets);
  await shot('sheets-done');

  // un nombre que puso el usuario no se traduce, aunque coincida con un
  // texto de la interfaz: un preajuste llamado «Portrait» (que en un menú
  // de orientación es «Vertical»)
  const preset = await driver.run<{ option: string; toast: string }>(
    step(`
    const name = document.querySelector('#view-sheets input[placeholder=${JSON.stringify(es('preset name'))}]');
    name.value = 'Portrait';
    name.dispatchEvent(new Event('input'));
    const n = ui.toasts.length;
    [...name.closest('.row').querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(es('Save'))}).click();
    await ui.until(() => ui.toasts.length > n, 10000, 'the preset saved notice');
    const sel = [...document.querySelectorAll('#view-sheets select')].find((s) => [...s.options].some((o) => o.value === 'Portrait'));
    return { option: sel.querySelector('option[value="Portrait"]').textContent, toast: ui.toasts.slice(n).join(' / ') };`),
  );
  check(
    'es: a name the user chose stays as it is',
    preset.option === 'Portrait' && preset.toast.includes('“Portrait”'),
    `option "${preset.option}"; ${preset.toast}`,
  );

  await screen('scans');
  const scans = await driver.run<{ toasts: string; rows: number; tags: string[] }>(
    step(`
    const n = ui.toasts.length;
    ui.button(${rx(es('No scans yet? Simulate them from this session’s sheets'))}).click();
    await ui.until(() => ui.toasts.slice(n).some((t) => t.includes(${JSON.stringify(es('Processing finished. Check the report.'))})), 240000, 'processing the scans');
    const tags = [...document.querySelectorAll('#view-scans .report-thumbs .thumb .tag')].map((t) => t.textContent);
    return { toasts: ui.toasts.slice(n).join(' / '), rows: document.querySelectorAll('#view-scans table.report td.assign-cell').length, tags };`),
  );
  // una hoja escaneada: una fila, su vista de alineación y seis recortes
  const align = es('alignment');
  check(
    'es: scans simulated and processed',
    scans.rows === 1 &&
      scans.tags.length === 7 &&
      scans.tags.filter((t) => t === align).length === 1,
    `${scans.rows} report row(s); thumbnails: ${scans.tags.join(', ')}; ${scans.toasts}`,
  );
  await shot('scans-done');

  // un confirm() no pasa por el documento: lo traduce quien lo muestra.
  // Sólo un teléfono pregunta, ante un escaneo demasiado pesado (una
  // cabecera PNG de 10000×14000 a 16 bits); Chrome emula Android
  const ask = await driver.run<{ skipped?: string; asked?: string; toast?: string }>(
    step(`
    const uad = navigator.userAgentData;
    if (!(uad?.mobile || /Android|iPhone|iPad/.test(navigator.userAgent)))
      return { skipped: 'no phone user agent in this browser' };
    const asked = [];
    window.confirm = (m) => { asked.push(m); return false; };
    try {
      const png = new Uint8Array(64);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(png.buffer).setUint32(16, 10000);
      new DataView(png.buffer).setUint32(20, 14000);
      png[24] = 16;
      png[25] = 2;
      const input = document.querySelector('#view-scans input[type=file][accept^=".tif"]');
      const dt = new DataTransfer();
      dt.items.add(new File([png], 'too-heavy.png', { type: 'image/png' }));
      input.files = dt.files;
      const n = ui.toasts.length;
      input.dispatchEvent(new Event('change'));
      await ui.until(() => asked.length && ui.toasts.length > n, 30000, 'the question on a heavy scan');
      await new Promise((r) => setTimeout(r, 300));
      return { asked: asked[0], toast: ui.toasts.slice(n).join(' / ') };
    } finally {
      window.confirm = () => true;
    }`),
  );
  // sin agente de teléfono no hay pregunta que mirar: se dice, no se aprueba
  if (ask.skipped) console.log(`– es: the phone question: not run here (${ask.skipped})`);
  else {
    const q = es('Continue on this phone?');
    check(
      'es: the phone question is in Spanish',
      !!ask.asked?.endsWith(`\n\n${q}`) && !/ needs about | of memory /.test(ask.asked ?? ''),
      `${JSON.stringify(ask.asked)} → ${ask.toast}`,
    );
  }
  const lb = await driver.run<string>(
    step(`
    document.querySelector('#view-scans .report-thumbs .thumb').click();
    await ui.until(() => document.querySelector('.lightbox img')?.naturalWidth, 15000, 'the lightbox');
    const cap = document.querySelector('.lightbox').textContent;
    return cap;`),
  );
  await shot('lightbox');
  await driver.run(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
  );
  // la primera miniatura es la vista de alineación, con su leyenda compuesta
  const legend = esFixed('{0}: green = marker found');
  check(
    'es: the enlarged view and its caption are in Spanish',
    lb.includes(legend) && !/marker found|missing/.test(lb),
    lb,
  );

  await screen('video');
  const video = await driver.run<{
    mov: string;
    zip: string;
    mp4: string;
    plan: string;
    info: string;
    toasts: string[];
  }>(
    step(`
    const save = () => ui.button(${rx(es('Save the video'), true)});
    await ui.until(() => save() && !save().disabled, 60000, 'the save button');
    let before = ui.downloads.length;
    save().click();
    const mov = await ui.until(() => ui.downloads.slice(before).find((x) => /\\.mov$/.test(x.name)), 180000, 'the MOV');
    await new Promise((r) => setTimeout(r, 500));
    const sels = [...document.querySelectorAll('#view-video select')];
    const kind = sels.find((s) => [...s.options].some((o) => o.value === 'frames'));
    kind.value = 'frames';
    kind.dispatchEvent(new Event('change'));
    before = ui.downloads.length;
    save().click();
    const zip = await ui.until(() => ui.downloads.slice(before).find((x) => /\\.zip$/.test(x.name)), 180000, 'the frames ZIP');
    kind.value = 'mp4';
    kind.dispatchEvent(new Event('change'));
    const quality = sels.find((s) => [...s.options].some((o) => o.value === 'custom'));
    quality.value = 'custom';
    quality.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 300));
    quality.value = 'high';
    quality.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 800));
    const plan = [...document.querySelectorAll('#view-video .hint')].map((h) => h.textContent).join(' | ');
    before = ui.downloads.length;
    save().click();
    const mp4 = await ui.until(() => ui.downloads.slice(before).find((x) => /\\.mp4$/.test(x.name)), 180000, 'the MP4');
    await new Promise((r) => setTimeout(r, 800));
    const play = await ui.until(() => {
      const b = document.querySelector('#view-video .player button');
      return b && !b.disabled && b;
    }, 60000, 'the preview');
    play.click();
    await new Promise((r) => setTimeout(r, 1500));
    const info = document.querySelector('#view-video .player-info').textContent;
    return { mov: mov.name, zip: zip.name, mp4: mp4.name, plan, info, toasts: ui.toasts.slice(0) };`),
  );
  // los tres avisos de guardado se componen con números y nombres: cada uno
  // tiene que haber salido con su forma en español
  const saved = [
    esFixed('Lossless MOV saved:'),
    esFixed('Lossless frames saved:'),
    esFixed('MP4 saved:'),
  ];
  const missingToasts = saved.filter((p) => !video.toasts.some((t) => t.includes(p)));
  check(
    'es: the MOV, PNG and MP4 saved notices are in Spanish',
    !!(video.mov && video.zip && video.mp4) && missingToasts.length === 0,
    missingToasts.length
      ? `not seen: ${missingToasts.join(' | ')}`
      : `${video.mov}, ${video.zip}, ${video.mp4}`,
  );
  const at = Number(/^(\d+) \//.exec(video.info)?.[1] ?? 0);
  check('es: the preview plays', at > 1, video.info);
  await screen('video');
  await screen('calibration');
  await screen('help');
  const help = await driver.run<string[]>(
    `return [...document.querySelectorAll('#view-help h2, #view-help h3')].map((h) => h.textContent.trim());`,
  );
  const sameHelp =
    help.length === HELP_HEADINGS.length && help.every((h, i) => h === HELP_HEADINGS[i]);
  check(
    'es: the Help page is the Spanish one',
    HELP_HEADINGS.length > 5 && sameHelp,
    sameHelp
      ? `${help.length} headings: ${help.slice(0, 3).join(', ')}…`
      : `page: ${help.join(', ')}`,
  );
  await goto('sheets');

  // 4. lo que llegó sin traducir
  const misses = await driver.run<string[]>('return [...(globalThis.__i18nMisses ?? [])];');
  check(
    'es: every text that reached the page was translated',
    misses.length === 0,
    misses.length ? `${misses.length} untranslated: ${misses.slice(0, 10).join(' | ')}` : 'none',
  );

  const stats = await driver.run<{ ms: number; batches: number }>('return globalThis.__i18nStats;');
  check(
    'es: the translator costs little',
    stats.ms < 2000,
    `${stats.ms.toFixed(0)} ms over ${stats.batches} batches of changes`,
  );

  // 5. y de vuelta, con la página quieta (la vista previa deja de correr)
  const back = await driver.run<{
    strays: string[];
    leftovers: string[];
    same: boolean;
    n: number;
    diff: string;
  }>(
    step(`
    let es1 = ui.snapshot();
    await ui.until(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      const now = ui.snapshot();
      const still = now.length === es1.length && now.every((t, i) => t === es1[i]);
      es1 = now;
      return still;
    }, 60000, 'the page to settle');
    const english = new Set(${JSON.stringify(ENGLISH_ONLY)});
    const strays = [...new Set(ui.snapshot().map((t) => t.replace(/^@[a-z-]+=/, '').replace(/\\s+/g, ' ').trim()).filter((t) => english.has(t)))];
    await ui.lang('en');
    const en = ui.snapshot();
    const spanish = new Set(${JSON.stringify(SPANISH_ONLY)});
    const pieces = ${JSON.stringify(SPANISH_PIECES)};
    const patterns = ${JSON.stringify(SPANISH_TEMPLATES)}.map((p) => new RegExp(p));
    const leftovers = en.map((t) => t.replace(/^@[a-z-]+=/, '').replace(/\\s+/g, ' ').trim()).filter((t) => spanish.has(t) || pieces.some((p) => t.includes(p)) || patterns.some((re) => re.test(t)));
    await ui.lang('es');
    const es2 = ui.snapshot();
    const diff = es1.flatMap((t, i) => (t === es2[i] ? [] : [JSON.stringify(t) + ' → ' + JSON.stringify(es2[i])]));
    return { strays, leftovers, same: es1.length === es2.length && diff.length === 0, n: es1.length, diff: diff.slice(0, 8).join(' | ') + (es1.length !== es2.length ? ' (' + es1.length + ' vs ' + es2.length + ' texts)' : '') };`),
  );
  check(
    'es: no English interface text is left on the Spanish page',
    back.strays.length === 0,
    back.strays.length
      ? back.strays.slice(0, 10).join(' | ')
      : `none of ${ENGLISH_ONLY.length} English texts`,
  );
  check(
    'EN after the Spanish run leaves no Spanish',
    back.leftovers.length === 0,
    back.leftovers.length ? back.leftovers.slice(0, 10).join(' | ') : 'none',
  );
  check(
    'ES again gives the same Spanish page',
    back.same,
    back.same ? `${back.n} texts` : back.diff,
  );

  // 6. recordado al recargar
  await openApp(driver, port, 'scans');
  const reload = await driver.run<{ lang: string; nav: string; shown: boolean }>(
    `const t0 = Date.now();
    while (document.documentElement.lang !== 'es' && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
    return { lang: document.documentElement.lang, nav: document.querySelector('#phase-nav .fname').textContent,
      shown: getComputedStyle(document.getElementById('app')).visibility === 'visible' };`,
  );
  check(
    'Spanish is remembered after a reload',
    reload.lang === 'es' && reload.nav === es('Sheets') && reload.shown,
    `lang=${reload.lang}, first tab "${reload.nav}", page ${reload.shown ? 'shown' : 'still hidden'}`,
  );
  await driver.run(step(`await ui.lang('en'); return true;`));
  return { checks, misses };
}

const { port, close } = await serveDist(DIST);
const report: Record<string, unknown> = {};
let passed = true;
let version = '';
for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  console.log(`\n── ${which}, ${name} (${viewport.width}×${viewport.height})`);
  const shots = join(ARTIFACT_DIR, 'i18n', `${which}-${name}`);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const driver = await launch(which, viewport);
  version = driver.version;
  let checks: Check[] = [];
  let misses: string[] = [];
  try {
    ({ checks, misses } = await runFlow(driver, port, shots));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'flow completed', ok: false, detail: msg });
    console.log(`✗ flow: ${msg}`);
    await writeFile(join(shots, 'failure.png'), await driver.screenshot()).catch(() => {});
    misses = await driver
      .run<string[]>('return [...(globalThis.__i18nMisses ?? [])];')
      .catch(() => []);
  }
  if (driver.pageErrors.length)
    checks.push({ name: 'no uncaught errors', ok: false, detail: driver.pageErrors.join(' / ') });
  await driver.close();
  report[name] = { viewport, checks, untranslated: misses };
  if (!checks.every((c) => c.ok)) passed = false;
}
close();

const artifact = { suite: 'i18n', browser: which, version, passed, runs: report };
const json = `${JSON.stringify(artifact, null, 2)}\n`;
const file = `i18n.${which}.json`;
await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(join(ARTIFACT_DIR, file), json);
await writeFile(
  join(ARTIFACT_DIR, `${file}.sha256`),
  `${createHash('sha256').update(json).digest('hex')}  ${file}\n`,
);
console.log(`\n${passed ? '✅ I18N OK' : '❌ I18N FAILED'} — artifacts/e2e/${file}`);
process.exit(passed ? 0 : 1);
