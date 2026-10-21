import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupInfo, PregenStatus, ServerConfig } from '@srvmc/shared';
import { BackupService, backupFileName, backupsToRotate, nextBackupTime, parseBackupName, skipInBackup } from '../src/backups.ts';
import { applyChunkyLine } from '../src/chunky.ts';
import { ServerManager } from '../src/manager.ts';
import { readNbt } from '../src/nbt.ts';
import { ensureDirs, makePaths, type Paths } from '../src/paths.ts';
import { ServerStore } from '../src/store.ts';
import { findWorlds, importWorld, readLevelMeta, sanitizeWorldName } from '../src/worlds.ts';
import { collectFiles, zipStream } from '../src/zip.ts';

// Tiny NBT writer for test fixtures.
function nbtString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
type Tag = ['string', string] | ['long', bigint] | ['int', number] | ['compound', Record<string, Tag>];
function payload(tag: Tag): Buffer {
  if (tag[0] === 'string') return nbtString(tag[1]);
  if (tag[0] === 'long') {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(tag[1]);
    return b;
  }
  if (tag[0] === 'int') {
    const b = Buffer.alloc(4);
    b.writeInt32BE(tag[1]);
    return b;
  }
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(tag[1])) parts.push(Buffer.from([{ string: 8, long: 4, int: 3, compound: 10 }[v[0]]]), nbtString(k), payload(v));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function levelDat(name: string, version: string, seed: bigint): Buffer {
  const data: Tag = ['compound', { LevelName: ['string', name], LastPlayed: ['long', 1792500000000n], Version: ['compound', { Name: ['string', version], Id: ['int', 4440] }], WorldGenSettings: ['compound', { seed: ['long', seed] }] }];
  return gzipSync(Buffer.concat([Buffer.from([10]), nbtString(''), payload(['compound', { Data: data }])]));
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-worlds-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeWorld(dir: string, name: string, extra: Record<string, string> = {}): Promise<void> {
  await mkdir(path.join(dir, name, 'region'), { recursive: true });
  await writeFile(path.join(dir, name, 'level.dat'), levelDat(name, '26.3', -4172000123n));
  await writeFile(path.join(dir, name, 'region', 'r.0.0.mca'), Buffer.alloc(4096, 7));
  for (const [f, c] of Object.entries(extra)) await writeFile(path.join(dir, name, f), c);
}

async function zipFolder(src: string, rels: string[], out: string): Promise<void> {
  await pipeline(zipStream(await collectFiles(src, rels)), createWriteStream(out));
}

describe('level.dat', () => {
  it('reads name, version and seed', async () => {
    await makeWorld(root, 'world');
    const raw = readNbt(await readFile(path.join(root, 'world', 'level.dat')));
    expect(Object.keys(raw)).toEqual(['Data']);
    expect(await readLevelMeta(path.join(root, 'world'))).toEqual({ version: '26.3', seed: '-4172000123', lastPlayed: 1792500000000, levelName: 'world' });
  });

  it('survives a broken file', async () => {
    await mkdir(path.join(root, 'bad'));
    await writeFile(path.join(root, 'bad', 'level.dat'), gzipSync(Buffer.from([10, 0, 0, 3])));
    expect(await readLevelMeta(path.join(root, 'bad'))).toEqual({});
  });
});

describe('worlds', () => {
  it('groups Paper dimension folders and marks the active world', async () => {
    for (const n of ['world', 'world_nether', 'world_the_end', 'kreativ']) await makeWorld(root, n);
    await writeFile(path.join(root, 'server.properties'), 'level-name=kreativ\n');
    const worlds = await findWorlds(root);
    expect(worlds.map((w) => [w.name, w.folders.length, w.active])).toEqual([
      ['kreativ', 1, true],
      ['world', 3, false],
    ]);
    expect(worlds[1]!.sizeBytes).toBeGreaterThan(3 * 4096);
  });

  it('shows a world that will be generated on next start', async () => {
    await writeFile(path.join(root, 'server.properties'), 'level-name=novy\n');
    expect(await findWorlds(root)).toEqual([{ name: 'novy', folders: [], sizeBytes: 0, active: true }]);
  });

  it('cleans names for folders', () => {
    expect(sanitizeWorldName('Můj svět (2026)')).toBe('Muj_svet_2026');
    expect(sanitizeWorldName('world_nether')).toBe('world');
    expect(sanitizeWorldName('...')).toBe('world');
  });

  it('imports a zip with level.dat at its root', async () => {
    const src = path.join(root, 'src');
    await makeWorld(src, 'w');
    const zip = path.join(root, 'a.zip');
    await pipeline(zipStream(await collectFiles(path.join(src, 'w'), ['level.dat', 'region'])), createWriteStream(zip));
    const server = path.join(root, 'server');
    await mkdir(server);
    expect(await importWorld(server, zip, 'Hrad')).toBe('Hrad');
    expect((await readdir(path.join(server, 'Hrad'))).sort()).toEqual(['level.dat', 'region']);
  });

  it('imports Paper-style folders and renames them together', async () => {
    const src = path.join(root, 'src');
    for (const n of ['survival', 'survival_nether', 'survival_the_end']) await makeWorld(src, n, { 'session.lock': 'x' });
    const zip = path.join(root, 'b.zip');
    await zipFolder(src, ['survival', 'survival_nether', 'survival_the_end'], zip);
    const server = path.join(root, 'server');
    await makeWorld(server, 'survival');
    const name = await importWorld(server, zip, '');
    expect(name).toBe('survival-2');
    expect((await readdir(server)).sort()).toEqual(['survival', 'survival-2', 'survival-2_nether', 'survival-2_the_end']);
    expect(await readdir(path.join(server, 'survival-2'))).not.toContain('session.lock');
  });

  it('finds a world nested inside folders', async () => {
    const src = path.join(root, 'src');
    await makeWorld(path.join(src, 'saves'), 'Ostrov');
    const zip = path.join(root, 'c.zip');
    await zipFolder(src, ['saves'], zip);
    const server = path.join(root, 'server');
    await mkdir(server);
    expect(await importWorld(server, zip, '')).toBe('Ostrov');
  });

  it('refuses a zip without a world', async () => {
    const src = path.join(root, 'src');
    await mkdir(src);
    await writeFile(path.join(src, 'readme.txt'), 'nic');
    const zip = path.join(root, 'd.zip');
    await zipFolder(src, ['readme.txt'], zip);
    const server = path.join(root, 'server');
    await mkdir(server);
    await expect(importWorld(server, zip, '')).rejects.toThrow(/level\.dat/);
    expect(await readdir(server)).toEqual([]);
  });
});

describe('backup helpers', () => {
  it('names and parses backup files', () => {
    const name = backupFileName('auto', new Date(2026, 9, 21, 4, 0, 5));
    expect(name).toBe('2026-10-21_04-00-05_auto.zip');
    expect(parseBackupName(name)).toEqual({ kind: 'auto', createdAt: new Date(2026, 9, 21, 4, 0, 5).getTime() });
    expect(parseBackupName('../evil.zip')).toBeNull();
  });

  it('skips files the server recreates', () => {
    expect(skipInBackup('libraries')).toBe(true);
    expect(skipInBackup('world/session.lock')).toBe(true);
    expect(skipInBackup('.srvmc-import-123/x')).toBe(true);
    expect(skipInBackup('world/region/r.0.0.mca')).toBe(false);
    expect(skipInBackup('plugins/Essentials/config.yml')).toBe(false);
  });

  it('rotates automatic backups only', () => {
    const b = (h: number, kind: BackupInfo['kind']): BackupInfo => ({ file: `${h}`, kind, createdAt: h, size: 1 });
    const list = [b(1, 'auto'), b(2, 'manual'), b(3, 'auto'), b(4, 'safety'), b(5, 'auto')];
    expect(backupsToRotate(list, 2).map((x) => x.file)).toEqual(['3', '1']);
  });

  it('computes the next scheduled run', () => {
    const from = new Date(2026, 9, 21, 13, 20); // Wednesday
    expect(nextBackupTime('hourly', '04:00', from)).toEqual(new Date(2026, 9, 21, 14, 0));
    expect(nextBackupTime('6h', '04:00', from)).toEqual(new Date(2026, 9, 21, 18, 0));
    expect(nextBackupTime('daily', '04:00', from)).toEqual(new Date(2026, 9, 22, 4, 0));
    expect(nextBackupTime('daily', '20:30', from)).toEqual(new Date(2026, 9, 21, 20, 30));
    expect(nextBackupTime('weekly', '04:00', from)).toEqual(new Date(2026, 9, 26, 4, 0));
    expect(nextBackupTime('off', '04:00', from)).toBeNull();
  });
});

describe('backup and restore', () => {
  let paths: Paths;
  let manager: ServerManager;
  const id = 'srv1';

  beforeEach(async () => {
    paths = makePaths(path.join(root, 'data'));
    await ensureDirs(paths);
    const cfg = { id, name: 'T', type: 'paper', version: '26.3', port: 25599, ramMinMb: 512, ramMaxMb: 1024, jvmFlags: 'aikar', extraJvmArgs: '', eulaAccepted: true, autoStart: false, installed: true, createdAt: '', backupKeep: 2 } as ServerConfig;
    await writeFile(paths.serversFile, JSON.stringify({ version: 1, servers: [cfg] }));
    const dir = path.join(paths.servers, id);
    await makeWorld(dir, 'world', { 'session.lock': 'locked' });
    await mkdir(path.join(dir, 'plugins'));
    await writeFile(path.join(dir, 'plugins', 'a.yml'), 'puvodni');
    await mkdir(path.join(dir, 'libraries'));
    await writeFile(path.join(dir, 'libraries', 'big.jar'), Buffer.alloc(10_000));
    manager = new ServerManager(paths, new ServerStore(paths.serversFile));
    await manager.init();
  });

  it('backs up, rotates and restores the server folder', async () => {
    const backups = new BackupService(manager, paths);
    const first = await backups.create(id, 'manual');
    expect(first.kind).toBe('manual');

    const dir = path.join(paths.servers, id);
    await writeFile(path.join(dir, 'plugins', 'a.yml'), 'zmeneno');
    await rm(path.join(dir, 'world', 'region'), { recursive: true });

    await backups.restore(id, first.file);
    expect(await readFile(path.join(dir, 'plugins', 'a.yml'), 'utf8')).toBe('puvodni');
    expect(await readdir(path.join(dir, 'world', 'region'))).toEqual(['r.0.0.mca']);
    expect(await readdir(path.join(dir, 'libraries'))).toEqual(['big.jar']);

    const list = await backups.list(id);
    expect(list.map((b) => b.kind).sort()).toEqual(['manual', 'safety']);
    expect((await readdir(path.join(paths.trash, id))).length).toBe(1);
    expect(manager.get(id).task).toBeUndefined();
  });
});

describe('Chunky console lines', () => {
  const idle: PregenStatus = { installed: true, state: 'idle', pct: 0, chunks: 0 };
  it('tracks progress, pause and completion', () => {
    const running = applyChunkyLine(idle, '[12:00:01 INFO]: [Chunky] Task running for world. Processed: 1234 chunks (12.34%), ETA: 0:10:05, Rate: 98.7 cps, Current: -12, 40')!;
    expect(running).toMatchObject({ state: 'running', world: 'world', chunks: 1234, pct: 12.34, eta: '0:10:05', rate: 98.7 });
    expect(applyChunkyLine(running, '[Chunky] Task paused for world.')!.state).toBe('paused');
    expect(applyChunkyLine(running, '[Chunky] Task finished for minecraft:overworld. Processed: 10000 chunks (100.00%), Total time: 0:01:23')).toMatchObject({ state: 'done', pct: 100, world: 'minecraft:overworld' });
    expect(applyChunkyLine(running, '[Chunky] Task cancelled for world.')!.state).toBe('idle');
    expect(applyChunkyLine(running, 'Steve joined the game')).toBeNull();
  });
});
