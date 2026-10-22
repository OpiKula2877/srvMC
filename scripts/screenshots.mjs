// Makes the README screenshots from the demo build of the panel (made-up servers and players).
// Build it first:  npm run build:demo -w @srvmc/web
// Then run:        npx electron scripts/screenshots.mjs
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

app.commandLine.appendSwitch('force-device-scale-factor', '1.25');
const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'packages/web/dist-demo');
const OUT = path.join(ROOT, 'docs/screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Clicks the first element whose text is exactly `text` (buttons, links, tabs). */
const click = (text) => `(() => { const el = [...document.querySelectorAll('button, a, [role=tab]')].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); el?.click(); return !!el; })()`;
/** Opens the custom dropdown that has the given label. */
const openDropdown = (label) => `(() => { const f = [...document.querySelectorAll('.dd')].find((e) => e.firstElementChild?.textContent?.trim() === ${JSON.stringify(label)}); f?.querySelector('.dd-btn')?.click(); return !!f; })()`;

const SHOTS = [
  { name: 'overview', hash: '#/' },
  { name: 'console', hash: '#/server/survival' },
  { name: 'graphs', hash: '#/server/survival/grafy' },
  { name: 'players', hash: '#/server/survival/hraci' },
  { name: 'motd', hash: '#/server/survival/moznosti' },
  { name: 'mods', hash: '#/server/survival/mody' },
  { name: 'statistics', hash: '#/server/survival/statistiky' },
  { name: 'users', hash: '#/users', steps: [click('New account'), openDropdown('Role')] },
  { name: 'new-server', hash: '#/new' },
  { name: 'phone', hash: '#/server/survival/grafy', width: 390, height: 844 },
];

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (/^\/api\/servers\/survival\/icon$/.test(url.pathname)) file = path.join(ROOT, 'packages/web/src/demo/ok-icon.png');
    if (!(file.startsWith(DIST) || file.endsWith('ok-icon.png')) || !(await stat(file).catch(() => null))?.isFile()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Each shot closes its window; the app must not quit in between.
app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/?lang=en`;
  await mkdir(OUT, { recursive: true });
  for (const shot of SHOTS) {
    const win = new BrowserWindow({ width: shot.width ?? 1440, height: shot.height ?? 900, show: false, useContentSize: true, enableLargerThanScreen: true, backgroundColor: '#0f1215', webPreferences: { offscreen: true } });
    // A fresh page per shot: the demo data starts from scratch every time.
    await win.loadURL(`${base}&shot=${shot.name}${shot.hash}`).catch((err) => console.log('load', shot.name, err.message));
    await wait(1800);
    for (const step of shot.steps ?? []) {
      const ok = await win.webContents.executeJavaScript(step);
      if (!ok) console.log('step did nothing:', shot.name, step.slice(0, 80));
      await wait(500);
    }
    await wait(600);
    const image = await win.webContents.capturePage();
    await writeFile(path.join(OUT, `${shot.name}.png`), image.toPNG());
    console.log('saved', shot.name, image.getSize());
    win.destroy();
  }
  server.close();
  app.quit();
});
