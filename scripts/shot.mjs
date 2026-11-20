// Снимки игры в headless Chromium (программный WebGL).
// node scripts/shot.mjs [url-база] — по умолчанию запускает vite preview на 4179.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    const p = join(base, d, 'chrome-linux64/chrome');
    if (existsSync(p)) return p;
  }
  throw new Error('chromium не найден');
}

const shots = (process.env.SHOTS || [
  'garage:shot=garage&steps=60',
  'intro:shot=intro&steps=110',
  'drive:shot=drive&s=260&steps=120',
  'curve:shot=drive&s=2400&steps=120&lane=0',
  'fast:shot=drive&s=5200&steps=150&v=190&lane=-1',
].join(',')).split(',');

const w = Number(process.env.W || 1280), h = Number(process.env.H || 720);
let base = process.argv[2];
let server;
if (!base) {
  server = spawn('npx', ['vite', 'preview', '--port', '4179', '--strictPort'], { stdio: 'ignore' });
  base = 'http://localhost:4179/';
  await new Promise((r) => setTimeout(r, 1500));
}
mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  for (const s of shots) {
    const [name, q] = s.split(':');
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
    const t0 = Date.now();
    await page.goto(`${base}?${q}&q=${process.env.Q || 'high'}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
    await page.screenshot({ path: `shots/${name}.png`, timeout: 240000 });
    console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)} с`, logs.length ? '\n  ' + logs.slice(0, 8).join('\n  ') : '');
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
