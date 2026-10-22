// World pre-generation through the Chunky plugin/mod: install, commands, progress from the console.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PregenRequest, PregenStatus, ServerType } from '@srvmc/shared';
import type { ServerInstance } from './instance.ts';
import { effectiveType } from './content.ts';
import { installProject } from './modrinth.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/index.ts';
import { activeWorldName } from './worlds.ts';
import { t } from '@srvmc/shared';

interface Platform {
  loaders: string[];
  folder: 'plugins' | 'mods';
}

const PLATFORMS: Partial<Record<ServerType, Platform>> = {
  paper: { loaders: ['paper', 'spigot', 'bukkit'], folder: 'plugins' },
  purpur: { loaders: ['paper', 'spigot', 'bukkit'], folder: 'plugins' },
  spigot: { loaders: ['spigot', 'bukkit'], folder: 'plugins' },
  // Arclight loads Bukkit plugins next to its mods.
  arclight: { loaders: ['spigot', 'bukkit', 'paper'], folder: 'plugins' },
  fabric: { loaders: ['fabric'], folder: 'mods' },
  quilt: { loaders: ['quilt', 'fabric'], folder: 'mods' },
  forge: { loaders: ['forge'], folder: 'mods' },
  neoforge: { loaders: ['neoforge'], folder: 'mods' },
};

export function pregenPlatform(type: ServerType): Platform | undefined {
  return PLATFORMS[type];
}

export async function isChunkyInstalled(inst: ServerInstance): Promise<boolean> {
  const platform = pregenPlatform(effectiveType(inst.cfg));
  if (!platform) return false;
  const names = await readdir(path.join(inst.dir, platform.folder)).catch(() => [] as string[]);
  return names.some((n) => /^chunky.*\.jar$/i.test(n));
}

export async function installChunky(inst: ServerInstance, paths: Paths): Promise<string[]> {
  const platform = pregenPlatform(effectiveType(inst.cfg));
  if (!platform) throw new UserError(t('A Vanilla server has no plugins or mods. Pre-generation needs Paper or Fabric.'));
  return installProject(paths, 'chunky', platform.loaders, inst.cfg.version, path.join(inst.dir, platform.folder));
}

const UPDATE_RE = /Task running for (\S+?)\. Processed: (\d+) chunks \(([\d.,]+)%\), ETA: ([\d:]+), Rate: ([\d.,]+) cps/;
const DONE_RE = /Task finished for (\S+?)\. Processed: (\d+) chunks \(([\d.,]+)%\)/;
const PAUSED_RE = /Task (?:paused|stopped) for (\S+?)\./;
const CANCEL_RE = /Task cancelled for (\S+?)\.|Cancelling all tasks/;
const CONTINUE_RE = /Task continuing for (\S+?)\./;

const num = (s: string) => Number(s.replace(',', '.'));

/** Folds one console line into the pre-generation status; returns null when the line is unrelated. */
export function applyChunkyLine(status: PregenStatus, text: string): PregenStatus | null {
  let m = UPDATE_RE.exec(text);
  if (m) return { ...status, state: 'running', world: m[1], chunks: Number(m[2]), pct: num(m[3]!), eta: m[4], rate: num(m[5]!) };
  m = DONE_RE.exec(text);
  if (m) return { ...status, state: 'done', world: m[1], chunks: Number(m[2]), pct: 100, eta: undefined, rate: undefined };
  m = PAUSED_RE.exec(text);
  if (m) return { ...status, state: 'paused', world: m[1], rate: undefined };
  if (CANCEL_RE.test(text)) return { ...status, state: 'idle', pct: 0, chunks: 0, eta: undefined, rate: undefined };
  m = CONTINUE_RE.exec(text);
  if (m) return { ...status, state: 'running', world: m[1] };
  return null;
}

/** Chunky names worlds the way the platform does: Bukkit folder names, or dimension ids on mod loaders. */
export async function chunkyWorld(inst: ServerInstance, dim: PregenRequest['dimension']): Promise<string> {
  if (pregenPlatform(effectiveType(inst.cfg))?.folder === 'mods') return { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' }[dim];
  const base = await activeWorldName(inst.dir);
  return { overworld: base, nether: `${base}_nether`, end: `${base}_the_end` }[dim];
}

export async function startPregen(inst: ServerInstance, req: PregenRequest): Promise<void> {
  if (inst.status !== 'running') throw new UserError(t('Pre-generation runs only on a running server.'));
  if (!(await isChunkyInstalled(inst))) throw new UserError(t('Install Chunky first.'));
  const radius = Math.round(req.radius);
  if (!Number.isInteger(radius) || radius < 100 || radius > 100_000) throw new UserError(t('The radius must be 100–100,000 blocks.'));
  const world = await chunkyWorld(inst, req.dimension);
  inst.sendCommand(`chunky world ${world}`);
  inst.sendCommand('chunky center 0 0');
  inst.sendCommand(`chunky shape ${req.shape === 'circle' ? 'circle' : 'square'}`);
  inst.sendCommand(`chunky radius ${radius}`);
  if (req.setBorder && req.dimension === 'overworld') {
    inst.sendCommand('worldborder center 0 0');
    inst.sendCommand(`worldborder set ${radius * 2}`);
  }
  const prompt = inst.waitForLine(/A task was already started|Task started for|Task running for/, 5000);
  inst.sendCommand('chunky start');
  // An unfinished earlier task makes Chunky ask whether to replace it; the panel always starts fresh.
  if ((await prompt)?.includes('already started')) inst.sendCommand('chunky confirm');
  inst.pregen = { ...inst.pregen, state: 'running', world, pct: 0, chunks: 0 };
  inst.emit('status');
}

export function pregenCommand(inst: ServerInstance, action: 'pause' | 'continue' | 'cancel'): void {
  if (inst.status !== 'running') throw new UserError(t('The server is not running.'));
  inst.sendCommand(`chunky ${action}`);
  if (action === 'cancel') inst.sendCommand('chunky confirm');
}
