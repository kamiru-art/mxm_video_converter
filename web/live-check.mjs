import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--host-resolver-rules=MAP mxm.sebastianlopez.me 104.21.36.161'],
});
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 1000 });
const logs = [];
p.on('console', (m) => logs.push(m.text()));
p.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
await p.goto('https://mxm.sebastianlopez.me/', { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
await p.screenshot({ path: '/tmp/mxm-shots/live.png' });
console.log('TITLE:', await p.title());
console.log(logs.filter((l) => /mxm-core|PAGEERROR|error/i.test(l)).join('\n') || '(sin errores)');
await b.close();
