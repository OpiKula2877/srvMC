import { lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import type { Edition, WorldInfo } from '@srvmc/shared';
import { trashPaths, validName } from './files.ts';
import { nbtPath, readNbt } from './nbt.ts';
import { readServerProperties, updateServerProperties } from './properties.ts';
import { UserError } from './providers/index.ts';

const DIM_SUFFIXES = ['_nether', '_the_end'] as const;

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

export async function activeWorldName(serverDir: string): Promise<string> {
  const { values } = await readServerProperties(serverDir);
  return values.get('level-name') || 'world';
}

/** Where world folders live: next to server.properties (Java) or in worlds/ (Bedrock). */
export function worldBase(serverDir: string, edition: Edition): string {
  return edition === 'bedrock' ? path.join(serverDir, 'worlds') : serverDir;
}

/** Folders of a world that exist on disk: the world itself plus Paper-style _nether and _the_end. */
export async function worldFolders(serverDir: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const folder of [name, `${name}_nether`, `${name}_the_end`]) {
    if ((await stat(path.join(serverDir, folder)).catch(() => null))?.isDirectory()) out.push(folder);
  }
  return out;
}

export interface LevelMeta {
  version?: string;
  seed?: string;
  lastPlayed?: number;
  levelName?: string;
}

/** Minecraft 26.x keeps world generation settings (with the seed) outside level.dat. */
async function readSeed26(worldDir: string): Promise<unknown> {
  try {
    const file = path.join(worldDir, 'dimensions', 'minecraft', 'overworld', 'data', 'minecraft', 'world_gen_settings.dat');
    return nbtPath(readNbt(await readFile(file)), 'data', 'seed');
  } catch {
    return undefined;
  }
}

export async function readLevelMeta(worldDir: string): Promise<LevelMeta> {
  try {
    const root = readNbt(await readFile(path.join(worldDir, 'level.dat')));
    const version = nbtPath(root, 'Data', 'Version', 'Name');
    const seed = nbtPath(root, 'Data', 'WorldGenSettings', 'seed') ?? nbtPath(root, 'Data', 'RandomSeed') ?? (await readSeed26(worldDir));
    const lastPlayed = nbtPath(root, 'Data', 'LastPlayed');
    const levelName = nbtPath(root, 'Data', 'LevelName');
    return {
      version: typeof version === 'string' ? version : undefined,
      seed: typeof seed === 'bigint' || typeof seed === 'number' ? String(seed) : undefined,
      lastPlayed: typeof lastPlayed === 'bigint' ? Number(lastPlayed) : undefined,
      levelName: typeof levelName === 'string' ? levelName : undefined,
    };
  } catch {
    return {};
  }
}

export async function findWorlds(serverDir: string, base = serverDir): Promise<WorldInfo[]> {
  const active = await activeWorldName(serverDir);
  const dirs = (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  const withLevel = new Set<string>();
  for (const d of dirs) if (await isFile(path.join(base, d.name, 'level.dat'))) withLevel.add(d.name);

  const bases = [...withLevel].filter((name) => {
    const suffix = DIM_SUFFIXES.find((s) => name.endsWith(s));
    return !suffix || !withLevel.has(name.slice(0, -suffix.length));
  });

  const worlds: WorldInfo[] = [];
  for (const name of bases) {
    const folders = await worldFolders(base, name);
    let sizeBytes = 0;
    for (const f of folders) sizeBytes += await dirSize(path.join(base, f));
    worlds.push({ name, folders, sizeBytes, active: name === active, ...(await readLevelMeta(path.join(base, name))) });
  }
  // A freshly chosen level-name has no folder yet; the server generates it on the next start.
  if (!worlds.some((w) => w.name === active)) worlds.push({ name: active, folders: [], sizeBytes: 0, active: true });
  return worlds.sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name, 'cs') : a.active ? -1 : 1));
}

export function checkWorldName(name: string): void {
  // Bedrock's default world is "Bedrock level": spaces are fine inside a name.
  if (!validName(name) || name.length > 64 || DIM_SUFFIXES.some((s) => name.endsWith(s)) || /^\s|\s$/.test(name)) {
    throw new UserError('Neplatný název světa. Použij písmena, číslice, pomlčku nebo podtržítko.');
  }
}

export async function setActiveWorld(serverDir: string, name: string, extra: Record<string, string> = {}): Promise<void> {
  checkWorldName(name);
  await updateServerProperties(serverDir, { 'level-name': name, ...extra });
}

export async function trashWorld(serverDir: string, name: string, trashDir: string, base = serverDir): Promise<void> {
  checkWorldName(name);
  const folders = await worldFolders(base, name);
  if (folders.length === 0) throw new UserError('Svět neexistuje.');
  await trashPaths(
    serverDir,
    folders.map((f) => path.relative(serverDir, path.join(base, f)).split(path.sep).join('/')),
    trashDir,
  );
}

/** Turns a zip name or folder name into a safe world folder name. */
export function sanitizeWorldName(raw: string): string {
  const base = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const cleaned = base.replace(/(_nether|_the_end)$/i, '');
  return cleaned || 'world';
}

async function uniqueName(serverDir: string, name: string): Promise<string> {
  let candidate = name;
  for (let i = 2; (await worldFolders(serverDir, candidate)).length > 0; i++) candidate = `${name}-${i}`;
  return candidate;
}

/** Folders under `root` (max 3 levels deep) that contain a level.dat. */
async function findLevelDirs(root: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  if (await isFile(path.join(root, 'level.dat'))) out.push(root);
  if (depth >= 3) return out;
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && d.name !== '__MACOSX') out.push(...(await findLevelDirs(path.join(root, d.name), depth + 1)));
  }
  return out;
}

/**
 * Imports a world from a zip. Handles a zip with level.dat at its root, a zip with one world folder,
 * and a zip with Paper-style world, world_nether and world_the_end folders.
 */
export async function importWorld(serverDir: string, zipFile: string, desiredName: string, onProgress?: (pct: number) => void, base = serverDir): Promise<string> {
  const tmp = path.join(serverDir, `.srvmc-import-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  await mkdir(base, { recursive: true });
  try {
    let seen = 0;
    await extractZip(zipFile, {
      dir: tmp,
      onEntry: (_entry, zip) => {
        seen++;
        if (seen % 50 === 0) onProgress?.(Math.round((seen / Math.max(1, zip.entryCount)) * 100));
      },
    });
    const levelDirs = await findLevelDirs(tmp);
    if (levelDirs.length === 0) throw new UserError('V zipu není svět Minecraftu (chybí level.dat).');

    const byDepth = (p: string) => path.relative(tmp, p).split(path.sep).filter(Boolean).length;
    const main =
      levelDirs.filter((d) => !DIM_SUFFIXES.some((s) => d.endsWith(s))).sort((a, b) => byDepth(a) - byDepth(b))[0] ??
      levelDirs.sort((a, b) => byDepth(a) - byDepth(b))[0]!;
    const sourceBase = main === tmp ? desiredName : path.basename(main);
    const name = await uniqueName(base, sanitizeWorldName(desiredName || sourceBase));

    await rename(main, path.join(base, name));
    if (main !== tmp) {
      for (const suffix of DIM_SUFFIXES) {
        const sibling = `${main}${suffix}`;
        if (levelDirs.includes(sibling)) await rename(sibling, path.join(base, `${name}${suffix}`));
      }
    }
    // A copied world often carries the old server's lock file.
    await rm(path.join(base, name, 'session.lock'), { force: true });
    return name;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
