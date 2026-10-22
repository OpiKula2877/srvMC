// Datapacks of the active Java world: <world>/datapacks/<name>(.zip). Turned-off packs move to
// <world>/datapacks-off/, because the game loads every folder or zip it finds in datapacks/.
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { editionOf, t, type DatapackInfo, type ServerConfig } from '@srvmc/shared';
import { UserError } from './providers/index.ts';
import { activeWorldName } from './worlds.ts';

const ON = 'datapacks';
const OFF = 'datapacks-off';
/** srvMC's own packs, managed by srvMC and not touched from the panel. */
export const OWN_PACKS = new Set(['srvmc-login']);
const NAME_RE = /^[\w .()+-]{1,80}(\.zip)?$/;

export function datapacksSupported(cfg: Pick<ServerConfig, 'type'>): boolean {
  return editionOf(cfg.type) === 'java' && cfg.type !== 'velocity';
}

async function worldDir(serverDir: string): Promise<string> {
  return path.join(serverDir, await activeWorldName(serverDir));
}

function checkName(name: string): void {
  if (!NAME_RE.test(name) || name.startsWith('.') || name.includes('..')) throw new UserError(t('Invalid datapack name.'));
}

async function exists(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null));
}

async function isPack(dir: string): Promise<boolean> {
  return exists(path.join(dir, 'pack.mcmeta'));
}

export async function listDatapacks(serverDir: string): Promise<DatapackInfo[]> {
  const world = await worldDir(serverDir);
  const out: DatapackInfo[] = [];
  for (const [folder, enabled] of [
    [ON, true],
    [OFF, false],
  ] as const) {
    const dir = path.join(world, folder);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (!s) continue;
      if (s.isFile() && !name.toLowerCase().endsWith('.zip')) continue;
      if (s.isDirectory() && !(await isPack(path.join(dir, name)))) continue;
      out.push({ name, enabled, kind: s.isDirectory() ? 'folder' : 'zip', size: s.isFile() ? s.size : undefined, mtime: s.mtimeMs, ...(OWN_PACKS.has(name) && { locked: true }) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Puts an uploaded zip in place. A zip with pack.mcmeta at its root stays a zip; one with the pack
 * inside a single folder (as many downloads come) is unpacked to that folder.
 */
export async function addDatapack(serverDir: string, zipFile: string, fileName: string): Promise<string> {
  const world = await worldDir(serverDir);
  const target = path.join(world, ON);
  await mkdir(target, { recursive: true });
  const tmp = path.join(serverDir, `.srvmc-datapack-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    await extractZip(zipFile, { dir: tmp });
    const base = fileName.replace(/\.zip$/i, '').replace(/[^\w .()+-]/g, '_').slice(0, 76) || 'datapack';
    if (await isPack(tmp)) {
      const name = `${base}.zip`;
      checkName(name);
      if ((await exists(path.join(target, name))) || (await exists(path.join(world, OFF, name)))) throw new UserError(t('The datapack {name} is already there.', { name }));
      await rename(zipFile, path.join(target, name));
      return name;
    }
    const inner = (await readdir(tmp, { withFileTypes: true })).filter((e) => e.isDirectory());
    const packDir = inner.length === 1 && (await isPack(path.join(tmp, inner[0]!.name))) ? inner[0]!.name : null;
    if (!packDir) throw new UserError(t('This is not a datapack (pack.mcmeta is missing).'));
    const name = packDir.replace(/[^\w .()+-]/g, '_').slice(0, 80);
    checkName(name);
    if (OWN_PACKS.has(name) || (await exists(path.join(target, name))) || (await exists(path.join(world, OFF, name)))) {
      throw new UserError(t('The datapack {name} is already there.', { name }));
    }
    await rename(path.join(tmp, packDir), path.join(target, name));
    return name;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function setDatapackEnabled(serverDir: string, name: string, enabled: boolean): Promise<void> {
  checkName(name);
  if (OWN_PACKS.has(name)) throw new UserError(t('srvMC manages this datapack itself.'));
  const world = await worldDir(serverDir);
  const from = path.join(world, enabled ? OFF : ON, name);
  if (!(await exists(from))) return;
  await mkdir(path.join(world, enabled ? ON : OFF), { recursive: true });
  await rename(from, path.join(world, enabled ? ON : OFF, name));
}

export async function removeDatapack(serverDir: string, name: string): Promise<void> {
  checkName(name);
  if (OWN_PACKS.has(name)) throw new UserError(t('srvMC manages this datapack itself.'));
  const world = await worldDir(serverDir);
  for (const folder of [ON, OFF]) await rm(path.join(world, folder, name), { recursive: true, force: true });
}
