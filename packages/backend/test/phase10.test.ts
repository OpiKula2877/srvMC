import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cfClientOnly, cfDownloadUrl, cfFileName, cfFilePage, pickFile, type CfFile } from '../src/curseforge.ts';
import { ManualDownloads } from '../src/manual.ts';
import { copyPack, detectLoader, fileNameLoader, manifestLoader, packLaunch, variablesLoader, versionJsonLoader } from '../src/packs.ts';
import { makePaths } from '../src/paths.ts';

const file = (over: Partial<CfFile>): CfFile => ({
  id: 1,
  modId: 328085,
  displayName: 'x',
  fileName: 'x.jar',
  releaseType: 1,
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 10,
  downloadUrl: 'https://edge.forgecdn.net/files/1/1/x.jar',
  gameVersions: ['1.21.1', 'NeoForge'],
  hashes: [],
  dependencies: [],
  ...over,
});

describe('CurseForge', () => {
  it('links to the download page of a file', () => {
    expect(cfFilePage({ slug: 'create', classId: 6, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/create' } }, 7963363)).toBe('https://www.curseforge.com/minecraft/mc-mods/create/download/7963363');
    expect(cfFilePage({ slug: 'essentialsx', classId: 5 }, 12)).toBe('https://www.curseforge.com/minecraft/bukkit-plugins/essentialsx/download/12');
  });

  it('only writes safe file names', () => {
    expect(cfFileName(file({ fileName: 'create-1.21.1-6.0.10.jar' }))).toBe('create-1.21.1-6.0.10.jar');
    expect(cfFileName(file({ id: 9, fileName: '..' }))).toBe('curseforge-9.jar');
    expect(cfFileName(file({ id: 9, fileName: '../../evil.jar' }))).toBe('curseforge-9.jar');
    expect(cfFileName(file({ fileName: 'Pack Server 1.0.zip' }))).toBe('Pack Server 1.0.zip');
  });

  it('knows files without third-party downloads and client-only files', () => {
    expect(cfDownloadUrl(file({ downloadUrl: null }))).toBeNull();
    expect(cfDownloadUrl(file({}))).toMatch(/^https:/);
    expect(cfClientOnly(file({ gameVersions: ['1.21.1', 'Fabric', 'Client'] }))).toBe(true);
    expect(cfClientOnly(file({ gameVersions: ['1.21.1', 'Fabric', 'Client', 'Server'] }))).toBe(false);
  });

  it('picks the newest release for the version and loader', () => {
    const files = [
      file({ id: 1, releaseType: 2, fileDate: '2026-03-01T00:00:00Z' }),
      file({ id: 2, releaseType: 1, fileDate: '2026-01-01T00:00:00Z' }),
      file({ id: 3, releaseType: 1, fileDate: '2026-02-01T00:00:00Z', gameVersions: ['1.21.1', 'Forge'] }),
      file({ id: 4, releaseType: 1, fileDate: '2026-04-01T00:00:00Z', gameVersions: ['1.20.1', 'NeoForge'] }),
    ];
    expect(pickFile(files, '1.21.1', ['neoforge'])?.id).toBe(2);
    expect(pickFile(files, '1.21.1', ['fabric'])).toBeUndefined();
    // Plugins: the minor line counts, then the newest file at all.
    const plugins = [file({ id: 5, gameVersions: ['1.21'] }), file({ id: 6, gameVersions: ['1.8'], fileDate: '2026-05-01T00:00:00Z' })];
    expect(pickFile(plugins, '1.21.4', [])?.id).toBe(5);
    expect(pickFile([plugins[1]!], '1.21.4', [])?.id).toBe(6);
  });
});

describe('Modpack loaders', () => {
  it('reads CurseForge manifest loaders', () => {
    expect(manifestLoader('1.20.1', 'forge-47.2.0')).toEqual({ type: 'forge', build: '1.20.1-47.2.0', mc: '1.20.1' });
    expect(manifestLoader('1.21.1', 'neoforge-21.1.77')).toEqual({ type: 'neoforge', build: '21.1.77', mc: '1.21.1' });
    expect(manifestLoader('1.21.1', 'fabric-0.16.9')).toEqual({ type: 'fabric', build: '0.16.9', mc: '1.21.1' });
    expect(manifestLoader('1.21.1', 'liteloader-1')).toBeNull();
  });

  it('reads launcher version.json files', () => {
    expect(versionJsonLoader(JSON.stringify({ id: '1.12.2-forge-14.23.5.2860', libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2860' }] }))).toEqual({ type: 'forge', build: '1.12.2-14.23.5.2860', mc: '1.12.2' });
    expect(versionJsonLoader(JSON.stringify({ id: '1.7.10-Forge10.13.4.1614-1.7.10', libraries: [] }))).toEqual({ type: 'forge', build: '1.7.10-10.13.4.1614', mc: '1.7.10' });
    expect(versionJsonLoader(JSON.stringify({ inheritsFrom: '1.21.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.9' }] }))).toEqual({ type: 'fabric', build: '0.16.9', mc: '1.21.1' });
    expect(versionJsonLoader('not json')).toBeNull();
  });

  it('reads loaders from server pack files', () => {
    expect(fileNameLoader('forge-1.12.2-14.23.5.2860.jar')).toEqual({ type: 'forge', build: '1.12.2-14.23.5.2860', mc: '1.12.2' });
    expect(fileNameLoader('forge-1.7.10-10.13.4.1614-1.7.10-universal.jar')).toEqual({ type: 'forge', build: '1.7.10-10.13.4.1614-1.7.10', mc: '1.7.10' });
    expect(fileNameLoader('libraries/net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-server.jar')).toEqual({ type: 'forge', build: '1.20.1-47.3.0', mc: '1.20.1' });
    expect(variablesLoader('MINECRAFT_VERSION=1.21.1\nMODLOADER=NeoForge\nMODLOADER_VERSION=21.1.172\n')).toEqual({ type: 'neoforge', build: '21.1.172', mc: '1.21.1' });
  });
});

describe('Server packs on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'srvmc-pack-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects the loader and how to start a pack as it is', async () => {
    const pack = path.join(dir, 'pack');
    await mkdir(path.join(pack, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0'), { recursive: true });
    await writeFile(path.join(pack, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0', 'forge-1.20.1-47.3.0-server.jar'), 'x');
    await mkdir(path.join(pack, 'mods'), { recursive: true });
    await writeFile(path.join(pack, 'mods', 'create.jar'), 'x');
    await writeFile(path.join(pack, 'run.bat'), 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt %*');
    expect(await detectLoader(pack)).toEqual({ type: 'forge', build: '1.20.1-47.3.0', mc: '1.20.1' });
    // The args file is missing: the pack still needs its loader installed.
    expect(await packLaunch(pack)).toBeNull();
    const args = path.join(pack, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0', process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt');
    await writeFile(args, '-cp x');
    expect((await packLaunch(pack))?.[0]).toMatch(/^@libraries\/net\/minecraftforge\/forge\/1\.20\.1-47\.3\.0\/(win|unix)_args\.txt$/);

    await writeFile(path.join(pack, 'start.sh'), 'java -Xmx4G -jar forge-1.12.2-14.23.5.2860.jar nogui');
    await writeFile(path.join(pack, 'forge-1.12.2-14.23.5.2860.jar'), 'x');
    const out = path.join(dir, 'server');
    await copyPack(pack, out, 'content');
    expect(await stat(path.join(out, 'mods', 'create.jar')).catch(() => null)).not.toBeNull();
    expect(await stat(path.join(out, 'run.bat')).catch(() => null)).toBeNull();
    expect(await stat(path.join(out, 'libraries')).catch(() => null)).toBeNull();
    expect(await stat(path.join(out, 'forge-1.12.2-14.23.5.2860.jar')).catch(() => null)).toBeNull();
  });

  it('leaves client-only folders out of client files', async () => {
    const pack = path.join(dir, 'client');
    await mkdir(path.join(pack, 'config'), { recursive: true });
    await mkdir(path.join(pack, 'resourcepacks'), { recursive: true });
    await writeFile(path.join(pack, 'config', 'a.toml'), 'a=1');
    await writeFile(path.join(pack, 'resourcepacks', 'r.zip'), 'x');
    await writeFile(path.join(pack, 'options.txt'), 'x');
    const out = path.join(dir, 'server');
    expect(await copyPack(pack, out, 'client')).toBe(1);
    expect(await readFile(path.join(out, 'config', 'a.toml'), 'utf8')).toBe('a=1');
  });
});

describe('Manual downloads', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-manual-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('picks the file up from Downloads by size and hash, even renamed', async () => {
    const paths = makePaths(path.join(root, 'home'));
    const downloads = path.join(root, 'Downloads');
    await mkdir(downloads, { recursive: true });
    const body = Buffer.from('create mod jar contents');
    const sha1 = createHash('sha1').update(body).digest('hex');
    const manual = new ManualDownloads(paths, downloads);
    const got: string[] = [];
    const item = await manual.add('srv', { title: 'Create', fileName: 'create-1.21.1-6.0.10.jar', url: 'https://www.curseforge.com/minecraft/mc-mods/create/download/7963363', size: body.length, sha1 }, async (cached) => {
      got.push(await readFile(cached, 'utf8'));
    });
    expect(item.done).toBe(false);
    expect(manual.list('srv')).toHaveLength(1);

    // A different file of the same size is not taken.
    await writeFile(path.join(downloads, 'other.jar'), Buffer.alloc(body.length, 1));
    await writeFile(path.join(downloads, 'create-1.21.1-6.0.10 (1).jar.crdownload'), body);
    await manual.scan();
    expect(got).toHaveLength(0);

    await writeFile(path.join(downloads, 'create-1.21.1-6.0.10 (1).jar'), body);
    await manual.scan();
    expect(got).toEqual(['create mod jar contents']);
    expect(manual.list('srv')).toHaveLength(0);
    expect(await stat(path.join(downloads, 'create-1.21.1-6.0.10 (1).jar')).catch(() => null)).toBeNull();
    expect(await stat(path.join(downloads, 'other.jar')).catch(() => null)).not.toBeNull();

    // Needed again later (another server): it comes straight from the cache.
    const again = await manual.add('srv2', { title: 'Create', fileName: 'create-1.21.1-6.0.10.jar', url: 'x', size: body.length, sha1 }, async () => undefined);
    expect(again.done).toBe(true);
    manual.cancel('srv');
  });

  it('waits for all files and fails when the user cancels', async () => {
    const paths = makePaths(path.join(root, 'home'));
    const downloads = path.join(root, 'Downloads');
    await mkdir(downloads, { recursive: true });
    const manual = new ManualDownloads(paths, downloads);
    const seen: number[] = [];
    const wait = manual.waitAll('srv', [{ title: 'A', fileName: 'a.jar', url: 'x', size: 5, md5: 'deadbeef' }], async () => undefined, (items) => seen.push(items.length));
    await new Promise((r) => setTimeout(r, 10));
    manual.cancel('srv');
    await expect(wait).rejects.toThrow(/cancelled/);
    expect(seen.at(-1)).toBe(1);
  });
});
