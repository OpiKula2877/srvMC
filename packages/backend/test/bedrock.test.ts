import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { bedrockUdpRange, editionOf, GAMERTAG_RE, portProtocol, type ServerConfig } from '@srvmc/shared';
import { skipInBackup } from '../src/backups.ts';
import { bedrockAddPlayer, bedrockPlayersInfo, bedrockRemovePlayer, quoted, rememberXuid } from '../src/bedrockplayers.ts';
import { recordsFor } from '../src/dnscheck.ts';
import { isDoneLine, parsePlayerEvent, ServerInstance } from '../src/instance.ts';
import { mappingsFor } from '../src/network.ts';
import { bedrockExe, bedrockPortProps, extractBedrock, md5FromHeader, pickLink } from '../src/providers/bedrock.ts';
import { parseDeviceLogin } from '../src/providers/hytale.ts';
import { findWorlds, importWorld, trashWorld, worldBase } from '../src/worlds.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-bedrock-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeZip(file: string, entries: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
    zip.end();
    zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
  });
}

describe('editions', () => {
  it('maps types to editions and port protocols', () => {
    expect(editionOf('paper')).toBe('java');
    expect(editionOf('bedrock-preview')).toBe('bedrock');
    expect(editionOf('hytale')).toBe('hytale');
    expect(portProtocol('fabric')).toBe('TCP');
    // Bedrock 26+: NetherNet handshake over TCP, gameplay over a pinned UDP block.
    expect(portProtocol('bedrock')).toBe('TCP');
    expect(portProtocol('hytale')).toBe('UDP');
    expect(bedrockUdpRange(19132)).toEqual([19132, 19151]);
    expect(GAMERTAG_RE.test('Big Steve')).toBe(true);
    expect(GAMERTAG_RE.test('NewTag#1234')).toBe(true);
    expect(GAMERTAG_RE.test('bad;name')).toBe(false);
  });
});

describe('Bedrock download', () => {
  const links = [
    { downloadType: 'serverBedrockWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.52.3.zip' },
    { downloadType: 'serverBedrockPreviewWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.21.zip' },
    { downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.52.3.zip' },
  ];

  it('picks the link for the platform and channel', () => {
    expect(pickLink(links, false, 'win32')).toEqual({ url: links[0]!.downloadUrl, version: '1.26.52.3' });
    expect(pickLink(links, true, 'win32')?.version).toBe('1.26.70.21');
    expect(pickLink(links, false, 'linux')?.url).toContain('bin-linux');
    expect(pickLink(links, true, 'linux')).toBeNull();
    expect(bedrockExe('win32')).toBe('bedrock_server.exe');
  });

  it('reads Content-MD5 as hex', () => {
    expect(md5FromHeader('mqiCf6BvLZi0jQ/pKAt4ag==')).toBe('9aa8827fa06f2d98b48d0fe9280b786a');
    expect(md5FromHeader(null)).toBeUndefined();
    expect(md5FromHeader('abc')).toBeUndefined();
  });

  it('unpacks over a server but keeps its settings', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(dir);
    await writeFile(path.join(dir, 'server.properties'), 'server-name=Moje\n');
    const zip = path.join(root, 'bds.zip');
    await makeZip(zip, { 'bedrock_server.exe': 'new', 'server.properties': 'server-name=Dedicated Server\n', 'behavior_packs/vanilla/manifest.json': '{}' });
    await extractBedrock(zip, dir);
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toBe('server-name=Moje\n');
    expect(await readFile(path.join(dir, 'bedrock_server.exe'), 'utf8')).toBe('new');
    expect((await readdir(dir)).sort()).toEqual(['bedrock_server.exe', 'behavior_packs', 'server.properties']);
  });
});

describe('console parsing', () => {
  it('knows when each edition is ready', () => {
    expect(isDoneLine('[2026-10-21 12:00:00:123 INFO] Server started.', 'bedrock')).toBe(true);
    expect(isDoneLine('[12:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"', 'bedrock')).toBe(false);
    expect(isDoneLine('[12:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"')).toBe(true);
    expect(isDoneLine('Listening on 0.0.0.0:5520', 'hytale')).toBe(true);
  });

  it('reads Bedrock joins with spaces and XUIDs', () => {
    expect(parsePlayerEvent('[2026-10-21 12:00:00:123 INFO] Player connected: Big Steve, xuid: 2535412345678901', 'bedrock')).toEqual({ join: 'Big Steve', xuid: '2535412345678901' });
    expect(parsePlayerEvent('[2026-10-21 12:00:00:123 INFO] Player disconnected: Big Steve, xuid: 2535412345678901, pfid: abc', 'bedrock')).toEqual({ leave: 'Big Steve' });
    expect(parsePlayerEvent('[12:00:00] [Server thread/INFO]: Steve joined the game', 'bedrock')).toEqual({});
  });

  it('reads the Hytale sign-in prompt', () => {
    const state: { link?: string; code?: string } = {};
    for (const line of [
      'Please visit the following URL to authenticate:',
      'https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=AbCd1234',
      'Or visit the following URL and enter the code:',
      'https://oauth.accounts.hytale.com/oauth2/device/verify',
      'Authorization code: AbCd1234',
    ])
      parseDeviceLogin(line, state);
    expect(state).toEqual({ link: 'https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=AbCd1234', code: 'AbCd1234' });
  });
});

describe('Bedrock players', () => {
  const inst = (dir: string) => new ServerInstance({ id: 'b', name: 'B', type: 'bedrock', version: '1.26.52.3', installed: true } as ServerConfig, dir);

  it('keeps the allow list by name and operators by XUID', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(dir);
    const i = inst(dir);
    await bedrockAddPlayer(i, 'whitelist', { name: 'Big Steve' });
    await rememberXuid(dir, 'Big Steve', '2535412345678901');
    await bedrockAddPlayer(i, 'ops', { name: 'big steve' });
    expect(JSON.parse(await readFile(path.join(dir, 'allowlist.json'), 'utf8'))).toEqual([{ ignoresPlayerLimit: false, name: 'Big Steve' }]);
    expect(JSON.parse(await readFile(path.join(dir, 'permissions.json'), 'utf8'))).toEqual([{ permission: 'operator', xuid: '2535412345678901' }]);
    const info = await bedrockPlayersInfo(i);
    expect(info).toMatchObject({ edition: 'bedrock', whitelist: [{ name: 'Big Steve' }], ops: [{ name: 'Big Steve', uuid: '2535412345678901' }], bans: [], ips: [] });
    await expect(bedrockAddPlayer(i, 'bans', { name: 'Griefer' })).rejects.toThrow(/zákazy nemá/);
    await expect(bedrockAddPlayer(i, 'whitelist', { name: 'big steve' })).rejects.toThrow(/už v seznamu/);
    await expect(bedrockAddPlayer(i, 'whitelist', { name: 'bad;name' })).rejects.toThrow(/gamertag/);
    await bedrockRemovePlayer(i, 'ops', 'Big Steve');
    await bedrockRemovePlayer(i, 'whitelist', 'BIG STEVE');
    expect(JSON.parse(await readFile(path.join(dir, 'permissions.json'), 'utf8'))).toEqual([]);
    expect(quoted('Big Steve')).toBe('"Big Steve"');
    expect(quoted('Steve')).toBe('Steve');
  });
});

describe('Bedrock worlds', () => {
  it('imports a .mcworld into worlds/ and lists it', async () => {
    const dir = path.join(root, 'srv');
    await mkdir(dir);
    await writeFile(path.join(dir, 'server.properties'), 'level-name=Bedrock level\n');
    const zip = path.join(root, 'Ostrov.mcworld');
    await makeZip(zip, { 'level.dat': 'x', 'levelname.txt': 'Ostrov', 'db/CURRENT': 'MANIFEST-1' });
    const base = worldBase(dir, 'bedrock');
    const name = await importWorld(dir, zip, 'Ostrov', undefined, base);
    expect(name).toBe('Ostrov');
    expect(await readdir(path.join(dir, 'worlds', 'Ostrov'))).toContain('level.dat');
    const worlds = await findWorlds(dir, base);
    expect(worlds.map((w) => [w.name, w.active])).toEqual([
      ['Bedrock level', true],
      ['Ostrov', false],
    ]);
    await trashWorld(dir, 'Ostrov', path.join(root, 'trash'), base);
    expect(await readdir(path.join(dir, 'worlds'))).toEqual([]);
  });
});

describe('backups skip program files', () => {
  it('leaves out what a reinstall brings back', () => {
    for (const rel of ['bedrock_server.exe', 'vcruntime140.dll', 'Assets.zip', 'Server/HytaleServer.jar', 'definitions/x.json']) expect(skipInBackup(rel)).toBe(true);
    for (const rel of ['worlds/Bedrock level/db/CURRENT', 'universe/worlds/default/config.json', 'plugins/x/run.exe', 'allowlist.json']) expect(skipInBackup(rel)).toBe(false);
  });
});

describe('Bedrock domains', () => {
  it('has no SRV records (Bedrock does not read them)', () => {
    expect(recordsFor({ zone: 'a.cz', sub: 'mc', target: 'ip' }, { port: 19134, publicIp: '203.0.113.42', srv: false })).toEqual([{ type: 'A', name: 'mc', value: '203.0.113.42' }]);
  });
});

describe('Bedrock ports (NetherNet)', () => {
  it('pins the gameplay UDP ports next to the handshake port', () => {
    expect(bedrockPortProps(19152)).toEqual({ 'server-port': '19152', 'server-udp-ports': '19152-19171' });
  });

  it('forwards TCP plus the UDP block for Bedrock, one rule otherwise', () => {
    const bedrock = mappingsFor({ type: 'bedrock', port: 19132, name: 'B' });
    expect(bedrock[0]).toEqual({ port: 19132, protocol: 'TCP', description: 'srvMC B' });
    expect(bedrock.filter((m) => m.protocol === 'UDP').map((m) => m.port)).toEqual(Array.from({ length: 20 }, (_, i) => 19132 + i));
    expect(mappingsFor({ type: 'paper', port: 25565, name: 'P' })).toEqual([{ port: 25565, protocol: 'TCP', description: 'srvMC P' }]);
    expect(mappingsFor({ type: 'hytale', port: 5520, name: 'H' })).toEqual([{ port: 5520, protocol: 'UDP', description: 'srvMC H' }]);
    expect(mappingsFor({ type: 'paper', port: 25565, name: 'P', geyserPort: 19132 }).slice(1)).toEqual([
      { port: 19132, protocol: 'TCP', description: 'srvMC P Bedrock' },
      { port: 19132, protocol: 'UDP', description: 'srvMC P Bedrock' },
    ]);
  });
});
