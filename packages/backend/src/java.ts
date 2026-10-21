import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { downloadToCache } from './download.ts';
import { fetchJson } from './http.ts';
import type { Paths } from './paths.ts';

export function adoptiumOs(platform: NodeJS.Platform = process.platform): 'windows' | 'mac' | 'linux' {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

export function adoptiumArch(arch: string = process.arch): 'x64' | 'aarch64' {
  return arch === 'arm64' ? 'aarch64' : 'x64';
}

export function javaBinary(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(home, 'bin', 'java.exe');
  if (platform === 'darwin') return path.join(home, 'Contents', 'Home', 'bin', 'java');
  return path.join(home, 'bin', 'java');
}

export function runtimeDir(paths: Paths, major: number): string {
  return path.join(paths.runtimes, `temurin-${major}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function installedRuntimes(paths: Paths): Promise<number[]> {
  let names: string[] = [];
  try {
    names = await readdir(paths.runtimes);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    const m = /^temurin-(\d+)$/.exec(name);
    if (m && (await exists(javaBinary(path.join(paths.runtimes, name))))) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

interface AdoptiumAsset {
  release_name: string;
  binary: { package: { name: string; link: string; checksum: string; size: number } };
}

export function adoptiumUrl(major: number, imageType: 'jre' | 'jdk'): string {
  const q = new URLSearchParams({ architecture: adoptiumArch(), image_type: imageType, os: adoptiumOs(), vendor: 'eclipse' });
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${q}`;
}

function untar(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', file, '-C', dest], { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

export type JavaProgress = (text: string, pct: number | null) => void;

/** 'jre' runs servers; 'jdk' adds the compiler that BuildTools (Maven) needs. */
export type JavaKind = 'jre' | 'jdk';

const pending = new Map<string, Promise<string>>();

/** Returns the path of a Java executable for `major`, downloading Eclipse Temurin on first use. */
export function ensureJava(paths: Paths, major: number, onProgress?: JavaProgress, kind: JavaKind = 'jre'): Promise<string> {
  const key = `${major}-${kind}`;
  const running = pending.get(key);
  if (running) return running;
  const job = installJava(paths, major, kind, onProgress).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function installJava(paths: Paths, major: number, kind: JavaKind, onProgress?: JavaProgress): Promise<string> {
  const home = kind === 'jdk' ? `${runtimeDir(paths, major)}-jdk` : runtimeDir(paths, major);
  const bin = javaBinary(home);
  if (await exists(bin)) return bin;

  let asset: AdoptiumAsset | undefined;
  // A JRE is enough to run a server; when no JRE exists for a version, the JDK works too.
  for (const imageType of kind === 'jdk' ? (['jdk'] as const) : (['jre', 'jdk'] as const)) {
    const assets = await fetchJson<AdoptiumAsset[]>(adoptiumUrl(major, imageType)).catch(() => []);
    asset = assets[0];
    if (asset) break;
  }
  if (!asset) throw new Error(`Java ${major} není pro tento systém k dispozici.`);

  const pkg = asset.binary.package;
  const label = kind === 'jdk' ? `Java ${major} JDK` : `Javu ${major}`;
  onProgress?.(`Stahuji ${label} (${asset.release_name})`, 0);
  const file = await downloadToCache(paths, { url: pkg.link, fileName: pkg.name, sha256: pkg.checksum, size: pkg.size }, (done, total) =>
    onProgress?.(`Stahuji ${label}`, total ? Math.round((done / total) * 100) : null),
  );

  onProgress?.(`Rozbaluji ${label}`, null);
  const tmp = path.join(paths.runtimes, `.tmp-${major}-${kind}-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    if (pkg.name.endsWith('.zip')) await extractZip(file, { dir: tmp });
    else await untar(file, tmp);
    const entries = await readdir(tmp);
    const top = entries.length === 1 ? path.join(tmp, entries[0]!) : tmp;
    await rm(home, { recursive: true, force: true });
    await rename(top, home);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (!(await exists(bin))) throw new Error(`Java ${major} se nepodařilo rozbalit.`);
  return bin;
}
