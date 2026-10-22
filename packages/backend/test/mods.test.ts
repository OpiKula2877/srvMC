import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { ServerConfig } from '@srvmc/shared';
import { authStack, getAuthState, setAuthMode, setYamlValue } from '../src/auth.ts';
import { checkUploadedJar, contentTargets, effectiveType, modrinthLoaders, removeContent, setEnabled, targetFor } from '../src/content.ts';
import { ServerInstance } from '../src/instance.ts';
import { describeJar, readJarMeta } from '../src/jarmeta.ts';
import { searchFacets } from '../src/modrinth.ts';
import { packLoader, safePackPath, serverFiles, type MrpackIndex } from '../src/providers/modpack.ts';
import { jarName } from '../src/sources.ts';

type Cfg = Pick<ServerConfig, 'type' | 'modpack' | 'build'>;
const cfg = (type: ServerConfig['type'], extra: Partial<ServerConfig> = {}): Cfg => ({ type, ...extra });
const modpackOn = (loader: ServerConfig['type']): Cfg =>
  cfg('modpack', { modpack: { source: 'modrinth', projectId: 'p', versionId: 'v', title: 'Pack', versionNumber: '1', loader } });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-mods-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeJar(file: string, entries: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
    zip.end();
    zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
  });
}

describe('jar metadata', () => {
  it('reads a Bukkit plugin', () => {
    const meta = describeJar(new Map([['plugin.yml', 'name: Essentials\nversion: "2.21.0" # build\nmain: com.earth2me.Essentials\n']]));
    expect(meta).toEqual({ kind: 'plugin', loaders: ['bukkit', 'paper'], name: 'Essentials', version: '2.21.0' });
  });

  it('marks client-only Fabric mods and ignores version placeholders', () => {
    const meta = describeJar(new Map([['fabric.mod.json', JSON.stringify({ id: 'sodium', name: 'Sodium', version: '${version}', environment: 'client' })]]));
    expect(meta).toMatchObject({ kind: 'mod', loaders: ['fabric', 'quilt'], name: 'Sodium', clientOnly: true });
    expect(meta.version).toBeUndefined();
  });

  it('tells NeoForge from Forge mods', () => {
    expect(describeJar(new Map([['META-INF/neoforge.mods.toml', 'displayName = "Create"\nversion = "6.0.0"']]))).toMatchObject({ kind: 'mod', loaders: ['neoforge'], name: 'Create', version: '6.0.0' });
    expect(describeJar(new Map([['META-INF/mods.toml', 'displayName="JEI"']])).loaders).toEqual(['forge', 'neoforge']);
  });

  it('reads a real jar file and survives a broken one', async () => {
    const jar = path.join(root, 'test.jar');
    await makeJar(jar, { 'plugin.yml': 'name: Test\nversion: 1.0\n', 'com/x/Main.class': 'x' });
    expect(await readJarMeta(jar)).toMatchObject({ kind: 'plugin', name: 'Test', version: '1.0' });
    const broken = path.join(root, 'broken.jar');
    await writeFile(broken, '<html>not a jar</html>');
    expect((await readJarMeta(broken)).kind).toBe('unknown');
  });
});

describe('content targets', () => {
  it('maps each server type to its folders and sources', () => {
    expect(contentTargets(cfg('vanilla'))).toEqual([]);
    expect(contentTargets(cfg('paper'))).toEqual([{ kind: 'plugin', folder: 'plugins', sources: ['modrinth', 'hangar', 'spigot', 'curseforge'] }]);
    expect(contentTargets(cfg('fabric'))[0]).toEqual({ kind: 'mod', folder: 'mods', sources: ['modrinth', 'curseforge'] });
    expect(contentTargets(cfg('arclight')).map((t) => t.folder)).toEqual(['mods', 'plugins']);
  });

  it('treats a modpack server like its loader', () => {
    expect(effectiveType(modpackOn('fabric'))).toBe('fabric');
    expect(contentTargets(modpackOn('neoforge'))[0]!.folder).toBe('mods');
    expect(modrinthLoaders(modpackOn('quilt'), 'mod')).toEqual(['quilt', 'fabric']);
  });

  it('picks Modrinth loaders, Arclight by its build', () => {
    expect(modrinthLoaders(cfg('purpur'), 'plugin')[0]).toBe('purpur');
    expect(modrinthLoaders(cfg('spigot'), 'plugin')).toEqual(['spigot', 'bukkit']);
    expect(modrinthLoaders(cfg('arclight', { build: 'arclight-fabric-1.21.1-1.0.2.jar' }), 'mod')).toEqual(['fabric']);
    expect(modrinthLoaders(cfg('arclight', { build: 'arclight-forge-1.20.1-1.0.5.jar' }), 'mod')).toEqual(['forge']);
  });

  it('refuses folders the server does not use', () => {
    expect(() => targetFor(cfg('vanilla'), 'plugins')).toThrow(/Vanilla/);
    expect(() => targetFor(cfg('paper'), 'mods')).toThrow();
  });

  it('builds search facets that hide client-only mods', () => {
    expect(searchFacets(['fabric'], '1.21.11', 'mod', true)).toEqual([['categories:fabric'], ['versions:1.21.11'], ['project_type:mod'], ['server_side:required', 'server_side:optional']]);
    expect(searchFacets(['paper', 'spigot'], '1.21.11', 'plugin', false)).toEqual([['categories:paper', 'categories:spigot'], ['versions:1.21.11']]);
  });
});

describe('uploaded jars', () => {
  const plugins = targetFor(cfg('paper'), 'plugins');
  const mods = targetFor(cfg('fabric'), 'mods');

  it('accepts what fits and explains what does not', () => {
    expect(() => checkUploadedJar(cfg('paper'), plugins, { kind: 'plugin', loaders: ['bukkit', 'paper'] })).not.toThrow();
    expect(() => checkUploadedJar(cfg('paper'), plugins, { kind: 'mod', loaders: ['fabric', 'quilt'] })).toThrow(/plugins go here/);
    expect(() => checkUploadedJar(cfg('fabric'), mods, { kind: 'plugin', loaders: ['bukkit'] })).toThrow(/mods go here/);
    expect(() => checkUploadedJar(cfg('fabric'), mods, { kind: 'mod', loaders: ['neoforge'] })).toThrow(/NeoForge.*Fabric/);
    expect(() => checkUploadedJar(cfg('fabric'), mods, { kind: 'mod', loaders: ['fabric'], name: 'Sodium', clientOnly: true })).toThrow(/client-only/);
    expect(() => checkUploadedJar(cfg('fabric'), mods, { kind: 'unknown', loaders: [] })).toThrow(/does not look like/);
  });
});

describe('modpacks', () => {
  it('finds the loader of a pack', () => {
    expect(packLoader({ minecraft: '1.21.1', 'fabric-loader': '0.16.9' })).toEqual({ type: 'fabric', build: '0.16.9', mc: '1.21.1' });
    expect(packLoader({ minecraft: '1.20.1', forge: '47.3.0' })).toEqual({ type: 'forge', build: '1.20.1-47.3.0', mc: '1.20.1' });
    expect(packLoader({ minecraft: '1.21.1', neoforge: '21.1.77' }).type).toBe('neoforge');
    expect(() => packLoader({ 'fabric-loader': '0.16.9' })).toThrow(/Minecraft version/);
  });

  it('keeps pack paths inside the server and blocks scripts', () => {
    expect(safePackPath('mods/create.jar')).toBe('mods/create.jar');
    expect(safePackPath('config\\create.toml')).toBe('config/create.toml');
    for (const bad of ['../evil.jar', '/etc/passwd', 'C:/Windows/x.dll', 'mods//x.jar', 'start.bat', 'run.ps1']) expect(safePackPath(bad)).toBeNull();
  });

  it('skips files the server does not need', () => {
    const file = (p: string, server?: string) => ({ path: p, hashes: { sha1: 'x' }, env: server ? { client: 'required', server } : undefined, downloads: [], fileSize: 1 });
    const index = { formatVersion: 1, game: 'minecraft', name: 'P', versionId: '1', dependencies: {}, files: [file('mods/a.jar', 'required'), file('mods/shaders.jar', 'unsupported'), file('mods/b.jar')] } as MrpackIndex;
    expect(serverFiles(index).map((f) => f.path)).toEqual(['mods/a.jar', 'mods/b.jar']);
  });
});

describe('login mode', () => {
  it('knows which servers can mix paid and unpaid accounts', () => {
    expect(authStack(cfg('paper'))?.folder).toBe('plugins');
    expect(authStack(cfg('quilt'))?.folder).toBe('mods');
    expect(authStack(modpackOn('fabric'))?.folder).toBe('mods');
    expect(authStack(cfg('forge'))).toBeNull();
    expect(authStack(cfg('vanilla'))).toBeNull();
  });

  it('edits one YAML value and keeps the rest', () => {
    const before = '# AuthMe\nsettings:\n    # comment\n    sessions:\n        enabled: false\n    enablePremium: false\n    serverName: x\nsecurity:\n    minPasswordLength: 5\n';
    const after = setYamlValue(before, 'settings', 'enablePremium', 'true');
    expect(after).toBe(before.replace('enablePremium: false', 'enablePremium: true'));
    // A nested key with the same name is not touched; the value goes to the section's own level.
    const nested = setYamlValue('settings:\n  sessions:\n    enablePremium: false\nother: 1\n', 'settings', 'enablePremium', 'true');
    expect(nested).toBe('settings:\n  enablePremium: true\n  sessions:\n    enablePremium: false\nother: 1\n');
    expect(setYamlValue('', 'settings', 'enablePremium', 'true')).toBe('settings:\n  enablePremium: true\n');
    expect(setYamlValue('a: 1\r\n', 'settings', 'x', 'y')).toBe('a: 1\r\nsettings:\r\n  x: y\r\n');
  });

  it('reads the mode from server.properties', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(dir);
    const inst = new ServerInstance({ id: 't', name: 'T', type: 'vanilla', version: '1.21.11', installed: true } as ServerConfig, dir);
    expect(await getAuthState(inst)).toEqual({ mode: 'online', hybridSupported: false });
    await writeFile(path.join(dir, 'server.properties'), 'online-mode=false\n');
    expect((await getAuthState(inst)).mode).toBe('offline');
  });

  it('lets unpaid clients in only with chat signatures off, and refuses hybrid without a plugin stack', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(dir);
    const inst = new ServerInstance({ id: 't', name: 'T', type: 'vanilla', version: '1.21.11', installed: true } as ServerConfig, dir);
    const ctx = { paths: {} as never, trashDir: path.join(root, 'trash') };
    await setAuthMode(inst, ctx, 'offline');
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toMatch(/online-mode=false[\s\S]*enforce-secure-profile=false|enforce-secure-profile=false[\s\S]*online-mode=false/);
    await setAuthMode(inst, ctx, 'online');
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toContain('enforce-secure-profile=true');
    await expect(setAuthMode(inst, ctx, 'hybrid')).rejects.toThrow(/Vanilla/);
  });
});

describe('managing installed jars', () => {
  it('switches a jar off and on, and moves removed jars to the trash', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(path.join(dir, 'plugins'), { recursive: true });
    await makeJar(path.join(dir, 'plugins', 'Test.jar'), { 'plugin.yml': 'name: Test\n' });
    const inst = new ServerInstance({ id: 't', name: 'T', type: 'paper', version: '1.21.11', installed: true } as ServerConfig, dir);

    await setEnabled(inst, 'plugins', 'Test.jar', false);
    expect(await readdir(path.join(dir, 'plugins'))).toEqual(['Test.jar.disabled']);
    await setEnabled(inst, 'plugins', 'Test.jar.disabled', true);
    expect(await readdir(path.join(dir, 'plugins'))).toEqual(['Test.jar']);
    await expect(setEnabled(inst, 'plugins', '../server.properties', false)).rejects.toThrow(/Invalid/);
    await expect(setEnabled(inst, 'mods', 'Test.jar', false)).rejects.toThrow();

    const trash = path.join(root, 'trash');
    await removeContent(inst, { paths: {} as never, trashDir: trash }, 'plugins', 'Test.jar');
    expect(await readdir(path.join(dir, 'plugins'))).toEqual([]);
    const [stamp] = await readdir(trash);
    expect(await readFile(path.join(trash, stamp!, 'plugins', 'Test.jar'))).toBeTruthy();
  });
});

describe('plugin file names', () => {
  it('makes safe jar names from titles', () => {
    expect(jarName('LuckPerms', '5.4.150')).toBe('LuckPerms-5.4.150.jar');
    expect(jarName('Příliš žluťoučký kůň!')).toBe('Prilis_zlutoucky_kun.jar');
    expect(jarName('...')).toBe('plugin.jar');
  });
});
