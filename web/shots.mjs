import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 1100 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
for (const view of ['escaneos', 'calibracion', 'video', 'ayuda']) {
  await p.goto(`http://localhost:4517/#${view}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  await p.screenshot({ path: `/tmp/mxm-shots/view-${view}.png` });
}
console.log('errors:', errs.length ? errs : 'none');
await b.close();
