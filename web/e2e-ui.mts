// Prueba de punta a punta de la INTERFAZ, a clics, sobre el index.html real
// (la otra, e2e-run.mts, prueba el pipeline por dentro). En un navegador y a
// un tamaño de ventana, hace lo que haría alguien que entra por primera vez:
//
//   ① el ejemplo de seis fotogramas → Generate sheets (el ZIP se descarga)
//   ② simular los escaneos de esas hojas → procesarlos
//   ③ guardar el video sin pérdida (MOV y ZIP de PNG) → verlo en la vista
//      previa de la página, que es como se ve en un teléfono
//
// En cada pantalla comprueba que nada se sale por la derecha (scroll
// horizontal: el fallo típico en un teléfono) y guarda una captura. El MOV
// descargado sale de la página y lo verifica el ffprobe de la máquina.
//
//   npm run test:ui                         Chrome, escritorio y móvil
//   npm run test:ui -- --browser=zen        Zen (o Firefox)
//   npm run test:ui -- --browser=safari     Safari
//
// Artefacto: artifacts/e2e/ui.<navegador>.json con cada comprobación, y las
// capturas en artifacts/e2e/ui/<navegador>-<ventana>/.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, Viewport } from './e2e-browsers.mts';
import { browserFromArgs, launch, serveDist } from './e2e-browsers.mts';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));
const which = browserFromArgs();
const VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844, mobile: true },
};

/** Instrumentos de la prueba, dentro de la página: los clics por texto,
 *  las esperas con tope, los avisos (toasts) oídos al aparecer, y las
 *  descargas interceptadas en vez de abrir el diálogo del navegador. */
const INSTRUMENT = `
  if (window.__ui) return true;
  const toasts = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes)
      if (n.nodeType === 1) toasts.push(n.className + ': ' + n.textContent);
  }).observe(document.getElementById('toasts'), { childList: true });
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
  };
  return true;
`;

/** Un paso: el cuerpo corre en la página, con `ui` a mano. */
function step(body: string): string {
  return `const ui = window.__ui; ${body}`;
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
): Promise<{ checks: Check[]; mov: Buffer | null }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  };
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(shots, `${name}.png`), await driver.screenshot());
  };
  /** Pantalla: navega, espera a que se monte, mide y captura. */
  const screen = async (view: string): Promise<void> => {
    await driver.run(
      step(
        `location.hash = '#${view}'; await new Promise((r) => setTimeout(r, 600)); return true;`,
      ),
    );
    const over = await driver.run<number>(step('return ui.overflow();'));
    check(`${view}: no sideways scroll`, over <= 0, `${over} px wider than the window`);
    await shot(view);
  };

  await driver.open(`http://127.0.0.1:${port}/#sheets`);
  await driver.run(`
    const t0 = Date.now();
    while (!document.querySelector('#view-sheets .paper')) {
      if (Date.now() - t0 > 30000) throw new Error('the page did not mount');
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;`);
  await driver.run(INSTRUMENT);
  const width = await driver.run<number>('return window.innerWidth;');
  check('window', true, `${width} px wide`);
  await screen('sheets');

  // ① el ejemplo y sus hojas
  const sheets = await driver.run<string>(
    step(`
    ui.button(/example/).click();
    await ui.until(() => ui.toasts.some((t) => /example frames ready/.test(t)), 60000, 'the example');
    ui.button(/Generate sheets/).click();
    const zip = await ui.until(() => ui.downloads.find((d) => /\\.zip$/.test(d.name)), 180000, 'the sheets ZIP');
    return zip.name + ' ' + zip.blob.size + ' bytes';`),
  );
  check('sheets generated and downloaded', /\.zip \d+ bytes$/.test(sheets), sheets);
  await shot('sheets-done');

  // ② escaneos simulados y procesados
  await screen('scans');
  const scans = await driver.run<string>(
    step(`
    ui.button(/Simulate them/).click();
    await ui.until(() => ui.toasts.some((t) => /Processing finished/.test(t)), 240000, 'processing the scans');
    return ui.toasts.filter((t) => /simulated scan|Processing finished/.test(t)).join(' / ');`),
  );
  check('scans simulated and processed', /Processing finished/.test(scans), scans);
  await shot('scans-done');

  // ③ el video sin pérdida: MOV, ZIP de PNG, y la vista previa
  await screen('video');
  const plan = await driver.run<string>(
    step(`
    return await ui.until(() => {
      const t = [...document.querySelectorAll('#view-video .hint')].map((h) => h.textContent).find((x) => /^Lossless:/.test(x));
      return t;
    }, 60000, 'the output plan');`),
  );
  // los recortes de la fase ② salen todos del mismo tamaño: se copian tal cual
  check(
    'video plan: lossless, every drawing copied as it is',
    /every drawing is copied as it is/.test(plan),
    plan,
  );
  const mov = await driver.run<string>(
    step(`
    ui.button(/Save the video/).click();
    const d = await ui.until(() => ui.downloads.find((x) => /\\.mov$/.test(x.name)), 180000, 'the MOV');
    await ui.until(() => ui.toasts.some((t) => /Lossless MOV saved/.test(t)), 30000, 'the saved toast');
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(d.blob);
    });`),
  );
  const movBytes = Buffer.from(mov, 'base64');
  check('MOV saved', movBytes.length > 1000, `${movBytes.length} bytes`);
  const frames = await driver.run<string>(
    step(`
    const sel = [...document.querySelectorAll('#view-video select')].find((s) => [...s.options].some((o) => o.value === 'frames'));
    sel.value = 'frames';
    sel.dispatchEvent(new Event('change'));
    ui.button(/Save the video/).click();
    const d = await ui.until(() => ui.downloads.find((x) => /\\.zip$/.test(x.name) && x !== ui.downloads[0]), 180000, 'the frames ZIP');
    return d.name + ' ' + d.blob.size + ' bytes';`),
  );
  check('PNG frames ZIP saved', /\.zip \d+ bytes$/.test(frames), frames);
  const preview = await driver.run<string>(
    step(`
    const play = await ui.until(() => {
      const b = document.querySelector('#view-video .player button');
      return b && !b.disabled && b;
    }, 60000, 'the preview');
    play.click();
    await new Promise((r) => setTimeout(r, 1500));
    return document.querySelector('#view-video .player-info').textContent;`),
  );
  const at = Number(/^(\d+) \//.exec(preview)?.[1] ?? 0);
  check('preview plays in the page', at > 1, preview);
  await shot('video-done');

  await screen('calibration');
  await screen('help');
  return { checks, mov: movBytes };
}

const { port, close } = await serveDist(DIST);
const report: Record<string, unknown> = {};
let passed = true;
let version = '';
for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  console.log(`\n── ${which}, ${name} (${viewport.width}×${viewport.height})`);
  const shots = join(ARTIFACT_DIR, 'ui', `${which}-${name}`);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const driver = await launch(which, viewport);
  version = driver.version;
  let checks: Check[] = [];
  try {
    const out = await runFlow(driver, port, shots);
    checks = out.checks;
    if (out.mov) {
      // el MOV de la página, visto por el ffprobe de la máquina: PNG, del
      // tamaño de los recortes, un fotograma por posición de la línea de tiempo
      const file = join(shots, 'demo.mov');
      await writeFile(file, out.mov);
      const r = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,width,height,pix_fmt,nb_read_frames',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8' },
      );
      const st = (JSON.parse(r.stdout || '{}') as { streams?: Record<string, unknown>[] })
        .streams?.[0];
      const ok = st?.codec_name === 'png' && Number(st?.nb_read_frames) === 6;
      checks.push({
        name: 'MOV decodes with ffmpeg: 6 PNG frames',
        ok,
        detail: JSON.stringify(st ?? r.stderr),
      });
      console.log(`${ok ? '✓' : '✗'} MOV decodes with ffmpeg: ${JSON.stringify(st)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'flow completed', ok: false, detail: msg });
    console.log(`✗ flow: ${msg}`);
    await writeFile(join(shots, 'failure.png'), await driver.screenshot()).catch(() => {});
  }
  if (driver.pageErrors.length)
    checks.push({ name: 'no uncaught errors', ok: false, detail: driver.pageErrors.join(' / ') });
  await driver.close();
  report[name] = { viewport, checks };
  if (!checks.every((c) => c.ok)) passed = false;
}
close();

const artifact = { suite: 'ui-flow', browser: which, version, passed, runs: report };
const json = `${JSON.stringify(artifact, null, 2)}\n`;
const file = `ui.${which}.json`;
await writeFile(join(ARTIFACT_DIR, file), json);
await writeFile(
  join(ARTIFACT_DIR, `${file}.sha256`),
  `${createHash('sha256').update(json).digest('hex')}  ${file}\n`,
);
console.log(`\n${passed ? '✅ UI OK' : '❌ UI FAILED'} — artifacts/e2e/${file}`);
process.exit(passed ? 0 : 1);
