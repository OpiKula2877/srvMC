import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import { startBackend, type Backend } from '@srvmc/backend';
import { t } from '@srvmc/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
// SRVMC_PORT lets a second copy (e.g. a packaged build under test) run next to a development one.
const PREFERRED_PORT = Number(process.env.SRVMC_PORT) || 8420;

let backend: Backend | undefined;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let hintShown = false;

// Built by scripts/make-icons.mjs; tray@2x.png is picked up automatically on high-DPI screens.
const appIcon = () => nativeImage.createFromPath(path.join(here, 'assets', 'icon.png'));
const trayIcon = () => nativeImage.createFromPath(path.join(here, 'assets', 'tray.png'));

function showWindow(): void {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isInternal(url: string): boolean {
  return !!backend && url.startsWith(backend.url);
}

function createWindow(): void {
  if (!backend) return;
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'srvMC',
    backgroundColor: '#0F1215',
    autoHideMenuBar: true,
    show: false,
    icon: appIcon(),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win?.show());

  // Links to the outside world open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isInternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  // Closing the window keeps the servers running in the tray.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
    if (!hintShown && tray && process.platform === 'win32') {
      hintShown = true;
      tray.displayBalloon({ title: t('srvMC keeps running'), content: t('The servers run in the background. Quit it from the notification area.'), iconType: 'info' });
    }
  });
  win.on('closed', () => {
    win = undefined;
  });
  void win.loadURL(backend.url);
}

/** Tray texts follow the app's language, so they are set again when it changes. */
function trayTexts(): void {
  if (!tray) return;
  tray.setToolTip(t('srvMC – Minecraft server manager'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('Open srvMC'), click: showWindow },
      { type: 'separator' },
      { label: t('Quit (stops the servers)'), click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  tray = new Tray(trayIcon());
  trayTexts();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

async function boot(): Promise<void> {
  // Tokens (DuckDNS, playit.gg) are sealed with the Windows user's key (DPAPI).
  const secretBox = safeStorage.isEncryptionAvailable()
    ? {
        encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (sealed: string) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
      }
    : undefined;
  // The app's own window is always the owner: it proves it with a token only this process knows.
  const localToken = randomBytes(24).toString('hex');
  // Mods the user downloads by hand land where the browser saves files; srvMC picks them up there.
  const restart = () => {
    app.relaunch();
    app.quit();
  };
  const options = { webDir: path.join(here, 'web'), autoStartServers: true, secretBox, localToken, downloadsDir: app.getPath('downloads'), onRestart: restart, onLanguage: trayTexts };
  try {
    backend = await startBackend({ ...options, port: PREFERRED_PORT });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      dialog.showErrorBox(t('srvMC did not start'), (err as Error).message);
      app.exit(1);
      return;
    }
    backend = await startBackend({ ...options, port: 0 });
  }
  const origin = `127.0.0.1:${backend.port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`http://${origin}/*`, `ws://${origin}/*`] }, (details, done) => {
    done({ requestHeaders: { ...details.requestHeaders, 'x-srvmc-local': localToken } });
  });
  createTray();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    // Stay alive in the tray.
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (!backend) return;
    // Stop every server cleanly (they get the "stop" command) before the process exits.
    event.preventDefault();
    const running = backend;
    backend = undefined;
    void running.close().finally(() => app.quit());
  });
  void app.whenReady().then(boot);
}
