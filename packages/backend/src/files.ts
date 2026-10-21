import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import extractZip from 'extract-zip';
import { MAX_TEXT_FILE, type DirListing, type FileContent, type FileEntry, type LogFileInfo } from '@srvmc/shared';
import { UserError } from './providers/index.ts';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A single path segment that is safe on Windows and cannot climb out of its folder. */
export function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[ .]$/.test(name) &&
    !WINDOWS_RESERVED.test(name)
  );
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Normalizes a panel path ("plugins/Essentials/config.yml") to segments, rejecting anything odd. */
export function splitRel(rel: string): string[] {
  if (rel.includes('\0')) throw new UserError('Neplatná cesta.');
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) if (!validName(p)) throw new UserError(`Neplatný název: ${p}`);
  return parts;
}

/**
 * Resolves `rel` inside `root`. Besides rejecting "..", it follows symlinks and junctions on the
 * nearest existing ancestor so a link inside the server folder cannot point the panel elsewhere.
 */
export async function resolveSafe(root: string, rel: string): Promise<string> {
  const target = path.join(root, ...splitRel(rel));
  if (!isInside(root, target)) throw new UserError('Cesta mimo složku serveru.');
  const realRoot = await realpath(root);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isInside(realRoot, real)) throw new UserError('Cesta mimo složku serveru.');
      break;
    } catch (err) {
      if (err instanceof UserError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function listDir(root: string, rel: string): Promise<DirListing> {
  const dir = await resolveSafe(root, rel);
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new UserError('Složka neexistuje.');
  const entries: FileEntry[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.endsWith('.srvmc-tmp') || d.name.endsWith('.srvmc-upload') || d.name.startsWith('.srvmc')) continue;
    const st = await lstat(path.join(dir, d.name)).catch(() => null);
    if (!st) continue;
    entries.push({ name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'cs') : a.type === 'dir' ? -1 : 1));
  return { path: relOf(root, dir), entries };
}

export async function readText(root: string, rel: string): Promise<FileContent> {
  const file = await resolveSafe(root, rel);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) throw new UserError('Soubor neexistuje.');
  if (s.size > MAX_TEXT_FILE) throw new UserError('Soubor je moc velký na úpravu v panelu (max 2 MB). Stáhni si ho.');
  const buf = await readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw new UserError('Tohle není textový soubor. Můžeš ho stáhnout.');
  return { path: relOf(root, file), content: buf.toString('utf8'), size: s.size, mtime: s.mtimeMs };
}

export async function writeText(root: string, rel: string, content: string): Promise<FileContent> {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE) throw new UserError('Text je moc dlouhý (max 2 MB).');
  const file = await resolveSafe(root, rel);
  if (file === root) throw new UserError('Neplatný soubor.');
  const parent = await stat(path.dirname(file)).catch(() => null);
  if (!parent?.isDirectory()) throw new UserError('Nadřazená složka neexistuje.');
  const existing = await stat(file).catch(() => null);
  if (existing?.isDirectory()) throw new UserError('Na tomto místě je složka.');
  await writeFile(`${file}.srvmc-tmp`, content, 'utf8');
  await rename(`${file}.srvmc-tmp`, file);
  const s = await stat(file);
  return { path: relOf(root, file), content, size: s.size, mtime: s.mtimeMs };
}

export async function makeDir(root: string, rel: string): Promise<void> {
  const dir = await resolveSafe(root, rel);
  if (await stat(dir).catch(() => null)) throw new UserError('Takový název už existuje.');
  await mkdir(dir, { recursive: true });
}

export async function renamePath(root: string, from: string, to: string): Promise<void> {
  const src = await resolveSafe(root, from);
  const dst = await resolveSafe(root, to);
  if (src === root || dst === root) throw new UserError('Kořenovou složku nejde přejmenovat.');
  if (!(await stat(src).catch(() => null))) throw new UserError('Soubor neexistuje.');
  if (await stat(dst).catch(() => null)) throw new UserError('Cíl už existuje.');
  await rename(src, dst);
}

/** Moves files to the srvMC trash instead of deleting them, so a mistake can be undone by hand. */
export async function trashPaths(root: string, rels: string[], trashDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashDir, stamp);
  for (const rel of rels) {
    const src = await resolveSafe(root, rel);
    if (src === root) throw new UserError('Celou složku serveru tady smazat nejde.');
    if (!(await lstat(src).catch(() => null))) continue;
    const target = path.join(dest, path.relative(root, src));
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(src, target);
    } catch {
      // Different drive: copy, then remove.
      await cp(src, target, { recursive: true });
      await rm(src, { recursive: true, force: true });
    }
  }
  return dest;
}

/** Extracts a zip next to itself into a new folder named after it. extract-zip rejects entries that escape. */
export async function unzipHere(root: string, rel: string): Promise<string> {
  const zip = await resolveSafe(root, rel);
  if (!zip.toLowerCase().endsWith('.zip')) throw new UserError('Rozbalit jde jen .zip.');
  const base = path.basename(zip, path.extname(zip));
  let target = path.join(path.dirname(zip), base);
  for (let i = 2; await stat(target).catch(() => null); i++) target = path.join(path.dirname(zip), `${base} (${i})`);
  await extractZip(zip, { dir: target });
  return relOf(root, target);
}

/** Streams an upload to a temp file, enforcing the size limit, then moves it into place. */
export async function saveUpload(root: string, dirRel: string, name: string, body: Readable, maxBytes: number, overwrite: boolean): Promise<void> {
  if (!validName(name)) throw new UserError('Neplatný název souboru.');
  const dir = await resolveSafe(root, dirRel);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new UserError('Cílová složka neexistuje.');
  const target = await resolveSafe(root, `${dirRel}/${name}`);
  const existing = await stat(target).catch(() => null);
  if (existing?.isDirectory()) throw new UserError('Na tomto místě je složka.');
  if (existing && !overwrite) throw new UserError(`Soubor ${name} už existuje.`);
  const tmp = `${target}.srvmc-upload`;
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _e, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new UserError('Soubor je moc velký.'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(body, limit, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function openForDownload(root: string, rel: string): Promise<{ stream: Readable; name: string; size: number }> {
  const file = await resolveSafe(root, rel);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) throw new UserError('Stáhnout jde jen soubor.');
  return { stream: createReadStream(file), name: path.basename(file), size: s.size };
}

// ---- Logs ----

const LOG_NAME_RE = /^[\w.-]+$/;
const LOG_DIRS: Record<LogFileInfo['kind'], string> = { log: 'logs', crash: 'crash-reports' };
/** The viewer gets at most this many bytes, from the end of the log. */
const LOG_VIEW_LIMIT = 4 * 1024 * 1024;

export async function listLogs(root: string): Promise<LogFileInfo[]> {
  const out: LogFileInfo[] = [];
  for (const kind of ['log', 'crash'] as const) {
    const dir = path.join(root, LOG_DIRS[kind]);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const ok = kind === 'log' ? /\.log(\.gz)?$/.test(name) : name.endsWith('.txt');
      if (!ok || !LOG_NAME_RE.test(name)) continue;
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (s?.isFile()) out.push({ name, kind, size: s.size, mtime: s.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function logPath(root: string, kind: LogFileInfo['kind'], name: string): string {
  if (!LOG_NAME_RE.test(name) || !(kind in LOG_DIRS)) throw new UserError('Neplatný název logu.');
  return path.join(root, LOG_DIRS[kind], name);
}

export async function readLog(root: string, kind: LogFileInfo['kind'], name: string): Promise<{ text: string; truncated: boolean }> {
  const file = logPath(root, kind, name);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) throw new UserError('Log neexistuje.');
  let buf: Buffer;
  if (name.endsWith('.gz')) {
    buf = gunzipSync(await readFile(file), { maxOutputLength: 64 * 1024 * 1024 });
  } else if (s.size > LOG_VIEW_LIMIT) {
    const fh = await open(file, 'r');
    try {
      buf = Buffer.alloc(LOG_VIEW_LIMIT);
      await fh.read(buf, 0, LOG_VIEW_LIMIT, s.size - LOG_VIEW_LIMIT);
    } finally {
      await fh.close();
    }
  } else {
    buf = await readFile(file);
  }
  const truncated = buf.length > LOG_VIEW_LIMIT || s.size > LOG_VIEW_LIMIT;
  const tail = buf.length > LOG_VIEW_LIMIT ? buf.subarray(buf.length - LOG_VIEW_LIMIT) : buf;
  return { text: tail.toString('utf8'), truncated };
}

// ---- Server icon ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minecraft only shows server-icon.png when it is a 64×64 PNG. */
export function checkServerIcon(buf: Buffer): void {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new UserError('Ikona musí být PNG.');
  }
  if (buf.readUInt32BE(16) !== 64 || buf.readUInt32BE(20) !== 64) throw new UserError('Ikona musí mít přesně 64×64 px.');
}
