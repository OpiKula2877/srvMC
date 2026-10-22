// Where players wait before they log in. From 1.16.2 on, srvMC's own datapack adds an empty
// dimension (srvmc:void) and everyone waits at 0 50 0 there. Older versions have no custom
// dimensions: the player stays put, blinded and unable to move.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activeWorldName } from '../worlds.ts';

export const LIMBO_PACK = 'srvmc-login';
export const VOID_DIM = 'srvmc:void';

/** "1.20.1" → [1, 20, 1]; "26.3" → [26, 3, 0]. Snapshots and unknown names count as the newest. */
export function mcVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return [999, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function atLeast(v: string, a: number, b: number, c = 0): boolean {
  const [x, y, z] = mcVersion(v);
  return x !== a ? x > a : y !== b ? y > b : z >= c;
}

export type LimboKind = 'void' | 'freeze';
export const limboKind = (version: string): LimboKind => (atLeast(version, 1, 16, 2) ? 'void' : 'freeze');

/** Data pack format by game version (from each version's version.json). */
const FORMATS: [string, number][] = [
  ['26.3', 121],
  ['26.2', 107],
  ['26.1', 101],
  ['1.21.11', 94],
  ['1.21.9', 88],
  ['1.21.7', 81],
  ['1.21.6', 80],
  ['1.21.5', 71],
  ['1.21.4', 61],
  ['1.21.2', 57],
  ['1.21', 48],
  ['1.20.5', 41],
  ['1.20.3', 26],
  ['1.20.2', 18],
  ['1.20', 15],
  ['1.19.4', 12],
  ['1.19', 10],
  ['1.18.2', 9],
  ['1.18', 8],
  ['1.17', 7],
  ['1.16.2', 6],
];

export function packFormat(version: string): number {
  for (const [v, f] of FORMATS) {
    const [a, b, c] = mcVersion(v);
    if (atLeast(version, a, b, c)) return f;
  }
  return 6;
}

export function packMeta(version: string): string {
  const f = packFormat(version);
  // From format 82 on (1.21.9) packs give a range; a wide top keeps the pack loading on newer versions.
  const pack = f >= 82 ? { description: 'srvMC login limbo', min_format: f, max_format: 1000 } : { description: 'srvMC login limbo', pack_format: f };
  return `${JSON.stringify({ pack }, null, 2)}\n`;
}

/**
 * The empty dimension. One file fits every version from 1.16.2: unknown fields are ignored, the old
 * "structures" and the newer "structure_overrides" are both there.
 */
export const VOID_DIMENSION = {
  type: 'minecraft:overworld',
  generator: {
    type: 'minecraft:flat',
    settings: { biome: 'minecraft:the_void', layers: [], lakes: false, features: false, structures: { structures: {} }, structure_overrides: [] },
  },
};

/** Writes (or refreshes) the limbo pack into the active world. */
export async function writeLimboPack(serverDir: string, version: string): Promise<void> {
  const root = path.join(serverDir, await activeWorldName(serverDir), 'datapacks', LIMBO_PACK);
  const dimDir = path.join(root, 'data', 'srvmc', 'dimension');
  await mkdir(dimDir, { recursive: true });
  const meta = packMeta(version);
  const metaFile = path.join(root, 'pack.mcmeta');
  if ((await readFile(metaFile, 'utf8').catch(() => '')) !== meta) await writeFile(metaFile, meta, 'utf8');
  await writeFile(path.join(dimDir, 'void.json'), `${JSON.stringify(VOID_DIMENSION, null, 2)}\n`, 'utf8');
}

export async function hasLimboPack(serverDir: string): Promise<boolean> {
  return !!(await readFile(path.join(serverDir, await activeWorldName(serverDir), 'datapacks', LIMBO_PACK, 'pack.mcmeta')).catch(() => null));
}

export async function removeLimboPack(serverDir: string): Promise<void> {
  await rm(path.join(serverDir, await activeWorldName(serverDir), 'datapacks', LIMBO_PACK), { recursive: true, force: true });
}

const MODE_NAMES = ['survival', 'creative', 'adventure', 'spectator'];

/** Game mode for a command: names from 1.13, numbers before. */
export function modeArg(version: string, mode: number): string {
  return atLeast(version, 1, 13) ? (MODE_NAMES[mode] ?? 'survival') : String(mode);
}

/** "Steve has the following entity data: [1.5d, 64.0d, -3.2d]" and the like. */
export function entityAnswer(name: string): RegExp {
  return new RegExp(`^.*?${name.replace(/[.]/g, '\\.')} has the following entity data: (.+)$`);
}

export function parseNumbers(value: string): number[] {
  return [...value.matchAll(/-?\d+(?:\.\d+)?(?:E-?\d+)?/gi)].map((m) => Number(m[0]));
}

export function parseString(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

/** A tellraw line in srvMC Login's colors. JSON text also reads as SNBT on 1.21.5+. */
export function tellraw(name: string, text: string, color = 'gold'): string {
  return `tellraw ${name} ${JSON.stringify({ text: '', extra: [{ text: '[Login] ', color: 'dark_aqua' }, { text, color }] })}`;
}
