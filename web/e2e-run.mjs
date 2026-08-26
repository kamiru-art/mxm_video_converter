import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.text().startsWith('[E2E]')) console.log(m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:4517/e2e.html');
try {
  await page.waitForFunction(() => document.title.startsWith('E2E-'), { timeout: 120000 });
} catch {}
const title = await page.title();
const log = await page.$eval('#log', (el) => el.textContent);
console.log('---\nTITLE:', title);
console.log(log);
await browser.close();
process.exit(title === 'E2E-OK' ? 0 : 1);
