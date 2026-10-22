// Hytale (Early Access, experimental): the official hytale-downloader fetches Server/HytaleServer.jar
// and Assets.zip after the user signs in with their Hytale account (device code). Runs on Java 25.
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { fetchOk } from '../http.ts';
import { runProgram } from '../installer.ts';
import { UserError, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const DOWNLOADER_ZIP = 'https://downloader.hytale.com/hytale-downloader.zip';
const WEEK = 7 * 24 * 3600_000;

export const downloaderExe = (platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? 'hytale-downloader-windows-amd64.exe' : 'hytale-downloader-linux-amd64';

/** Sign-in prompt of Hytale's OAuth device flow (downloader and the server's /auth login device). */
export function parseDeviceLogin(line: string, state: { link?: string; code?: string }): boolean {
  const url = /(https:\/\/[^\s"']*hytale\.com[^\s"']*)/i.exec(line)?.[1];
  if (url && (!state.link || url.includes('user_code='))) {
    state.link = url;
    return true;
  }
  const code = /(?:authorization|user|device)?\s*code:\s*([A-Za-z0-9-]{4,})/i.exec(line)?.[1];
  if (code) {
    state.code = code;
    return true;
  }
  return false;
}

/** On Windows the downloader must carry a valid Authenticode signature of Hypixel Studios. */
function checkSignature(exe: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath $env:SRVMC_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, env: { ...process.env, SRVMC_FILE: exe } }, (err, out) => {
      const [status, subject = ''] = String(out).trim().split('|');
      if (err || status !== 'Valid' || !/Hypixel Studios/i.test(subject)) reject(new UserError(t('The downloaded hytale-downloader has no valid Hypixel Studios signature. srvMC will not run it.')));
      else resolve();
    });
  });
}

async function ensureDownloader(tools: string): Promise<string> {
  const exe = path.join(tools, downloaderExe());
  const s = await stat(exe).catch(() => null);
  if (!s || Date.now() - s.mtimeMs > WEEK) {
    await mkdir(tools, { recursive: true });
    const zip = path.join(tools, 'hytale-downloader.zip');
    await writeFile(zip, Buffer.from(await (await fetchOk(DOWNLOADER_ZIP, { timeoutMs: 120_000 })).arrayBuffer()));
    await extractZip(zip, { dir: tools });
    await rm(zip, { force: true });
  }
  await checkSignature(exe);
  return exe;
}

export const hytale: Provider = {
  type: 'hytale',

  // The real version is only known after signing in; the wizard offers the release channel.
  async listVersions() {
    return [{ id: 'latest', type: 'release' }];
  },

  async listBuilds() {
    return [
      { id: 'release', label: 'Release', channel: 'stable' },
      { id: 'pre-release', label: 'Pre-release', channel: 'beta' },
    ];
  },

  async plan(_version, build) {
    const patchline = build === 'pre-release' ? 'pre-release' : 'release';
    return {
      files: [],
      javaMajor: 25,
      build: patchline,
      async install(ctx) {
        // One sign-in serves every Hytale server: the downloader keeps its credentials next to itself.
        const tools = path.join(ctx.paths.runtimes, 'hytale-downloader');
        ctx.progress('Stahuji hytale-downloader', null);
        const exe = await ensureDownloader(tools);
        const zip = path.join(tools, `game-${Date.now()}.zip`);
        const login: { link?: string; code?: string } = {};
        try {
          ctx.progress(t('Starting hytale-downloader'), null);
          await runProgram(exe, ['-download-path', zip, '-skip-update-check', ...(patchline === 'release' ? [] : ['-patchline', patchline])], {
            cwd: tools,
            timeoutMs: 30 * 60_000,
            onLine: (line) => {
              ctx.log(`[hytale-downloader] ${line}`);
              if (parseDeviceLogin(line, login) && login.link) {
                ctx.progress(login.code ? t('Sign in to a Hytale account – code {code}. Then the download starts by itself.', { code: login.code }) : t('Sign in to a Hytale account. Then the download starts by itself.'), null, login.link);
              } else if (/download|%/i.test(line)) {
                const pct = /(\d{1,3}(?:\.\d+)?)%/.exec(line)?.[1];
                ctx.progress('Stahuji soubory Hytale serveru', pct ? Math.min(100, Math.round(Number(pct))) : null);
              }
            },
          });
          ctx.progress('Rozbaluji Hytale server', null);
          await extractZip(zip, { dir: ctx.dir });
        } finally {
          await rm(zip, { force: true });
        }
        if (!(await stat(path.join(ctx.dir, 'Server', 'HytaleServer.jar')).catch(() => null))) throw new UserError(t('Server/HytaleServer.jar is missing from the download.'));
        if (!(await stat(path.join(ctx.dir, 'Assets.zip')).catch(() => null))) throw new UserError(t('Assets.zip is missing from the download.'));
        ctx.log(t('After the first start the server has to sign in to a Hytale account – srvMC shows a link for it.'));
        return ['-jar', path.posix.join('Server', 'HytaleServer.jar'), '--assets', 'Assets.zip'];
      },
    };
  },
};

/** The downloader prints the game version it would fetch (needs saved credentials). */
export function hytaleVersion(runtimes: string): Promise<string | null> {
  const tools = path.join(runtimes, 'hytale-downloader');
  return new Promise((resolve) => {
    execFile(path.join(tools, downloaderExe()), ['-print-version', '-skip-update-check'], { cwd: tools, windowsHide: true, timeout: 20_000 }, (err, out) => {
      resolve(err ? null : (/\d{4}\.\d{2}\.\d{2}-[0-9a-f]+/.exec(String(out))?.[0] ?? null));
    });
  });
}
