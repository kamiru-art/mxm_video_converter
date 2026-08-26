// Browser end-to-end test runner: serves web/dist itself and drives the
// e2e.html page (full pipeline: sheets → scan → calibration → cyanotype →
// video) in headless Chrome. Used locally (`npm run test:e2e`) and in CI.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const DIST = new URL('./dist', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = join(DIST, path);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium binary found. Set CHROME_PATH.');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.text().startsWith('[E2E]')) console.log(m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${port}/e2e.html`);
try {
  await page.waitForFunction(() => document.title.startsWith('E2E-'), { timeout: 180000 });
} catch {
  console.log('Timed out waiting for the E2E page to finish.');
}
const title = await page.title();
const log = await page.$eval('#log', (el) => el.textContent).catch(() => '(no log)');
console.log('---\nRESULT:', title);
console.log(log);
await browser.close();
server.close();
process.exit(title === 'E2E-OK' ? 0 : 1);
