// Renders docs/demo.html into docs/demo.gif. Needs Chrome and ffmpeg; no npm packages.
//   node docs/render-demo.mjs [path/to/chrome] [--stills 1,2.5,10]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FPS = 12;
const PORT = 9377;
const args = process.argv.slice(2);
const stillsAt = args.includes('--stills') ? args[args.indexOf('--stills') + 1].split(',').map(Number) : null;
const chrome = args.find((a) => /chrome|edge/i.test(a)) || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(existsSync);

const out = mkdtempSync(path.join(tmpdir(), 'showonce-demo-'));
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(out, 'profile')}`, pathToFileURL(path.join(here, 'demo.html')).href,
], { stdio: 'ignore' });

async function pageSocket() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = pages.find((p) => p.type === 'page' && p.url.includes('demo.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome did not start');
}

try {
  const ws = new WebSocket(await pageSocket());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    waiting.set(nextId, resolve);
    ws.send(JSON.stringify({ id: nextId++, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  const { result } = await send('Runtime.evaluate', { expression: 'DURATION' });
  const times = stillsAt || Array.from({ length: Math.ceil(result.value * FPS) }, (_, i) => i / FPS);
  for (const [i, t] of times.entries()) {
    await send('Runtime.evaluate', { expression: `render(${t})` });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(out, `f${String(i).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
  }
  ws.close();

  if (stillsAt) {
    console.log(out);
  } else {
    const gif = path.join(here, 'demo.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(out, 'f%04d.png'),
      '-vf', 'scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
      '-loop', '0', gif]);
    console.log(`${gif} (${times.length} frames)`);
  }
} finally {
  browser.kill();
}
