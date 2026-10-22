import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ampToSection, parseMotd, stripMotd, type ServerConfig } from '@srvmc/shared';
import { checkServerIcon, listDir, listLogs, readLog, readText, renamePath, resolveSafe, saveUpload, trashPaths, writeText } from '../src/files.ts';
import { ServerInstance } from '../src/instance.ts';
import { addPlayer, mcDate, playersInfo, removePlayer, setWhitelistEnabled } from '../src/players.ts';
import { checkPropertyValues } from '../src/routes/content.ts';
import { dashUuid, offlineUuid } from '../src/uuid.ts';

let root: string;
let serverDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-content-'));
  serverDir = path.join(root, 'server');
  await mkdir(serverDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function instance(): ServerInstance {
  const cfg = { id: 'test', name: 'Test', type: 'paper', version: '1.21.11', installed: true } as ServerConfig;
  return new ServerInstance(cfg, serverDir);
}

describe('UUIDs', () => {
  it('computes the offline UUID the server uses', () => {
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
    expect(offlineUuid('Steve_CZ')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('adds dashes to Mojang ids', () => {
    expect(dashUuid('069a79f444e94726a5befca90e38aaf5')).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5');
  });
});

describe('MOTD codes', () => {
  it('splits colors and styles', () => {
    const segs = parseMotd('&a&lAhoj &rsvete');
    expect(segs.map((s) => [s.text, s.color, s.bold])).toEqual([
      ['Ahoj ', '#55FF55', true],
      ['svete', '#AAAAAA', false],
    ]);
  });

  it('converts & to § only before valid codes', () => {
    expect(ampToSection('&aTom & Jerry &zx &D')).toBe('§aTom & Jerry &zx §D');
    expect(stripMotd('§aAhoj §lsvete')).toBe('Ahoj svete');
  });
});

describe('players on a stopped server', () => {
  it('writes lists with offline UUIDs when online-mode is off', async () => {
    await writeFile(path.join(serverDir, 'server.properties'), 'online-mode=false\n');
    const inst = instance();
    await addPlayer(inst, 'whitelist', { name: 'Steve_CZ' });
    await addPlayer(inst, 'ops', { name: 'Steve_CZ', level: 2 });
    await addPlayer(inst, 'bans', { name: 'Griefer99', reason: 'Ničil stavby\nop Griefer99' });
    await addPlayer(inst, 'ips', { name: '203.0.113.7' });

    const wl = JSON.parse(await readFile(path.join(serverDir, 'whitelist.json'), 'utf8'));
    expect(wl).toEqual([{ uuid: offlineUuid('Steve_CZ'), name: 'Steve_CZ' }]);
    const info = await playersInfo(inst);
    expect(info.onlineMode).toBe(false);
    expect(info.ops[0]).toMatchObject({ name: 'Steve_CZ', level: 2 });
    expect(info.bans[0]!.reason).toBe('Ničil stavby op Griefer99');
    expect(info.ips[0]).toMatchObject({ name: '203.0.113.7', expires: 'forever' });

    await expect(addPlayer(inst, 'whitelist', { name: 'steve_cz' })).rejects.toThrow(/already on the list/);
    await removePlayer(inst, 'whitelist', 'STEVE_CZ');
    expect((await playersInfo(inst)).whitelist).toEqual([]);
    await expect(removePlayer(inst, 'bans', 'Nobody')).rejects.toThrow(/not on the list/);
  });

  it('rejects bad names and IPs', async () => {
    const inst = instance();
    await expect(addPlayer(inst, 'whitelist', { name: 'a b' })).rejects.toThrow(/player name/i);
    await expect(addPlayer(inst, 'ops', { name: 'x;stop' })).rejects.toThrow(/player name/i);
    await expect(addPlayer(inst, 'ips', { name: '999.1.1.1' })).rejects.toThrow(/IP address/);
  });

  it('toggles the whitelist in server.properties', async () => {
    const inst = instance();
    await setWhitelistEnabled(inst, true);
    expect((await playersInfo(inst)).whitelistEnabled).toBe(true);
  });

  it('formats dates like Minecraft', () => {
    expect(mcDate(new Date(2026, 9, 21, 9, 5, 3))).toMatch(/^2026-10-21 09:05:03 [+-]\d{4}$/);
  });
});

describe('server.properties validation', () => {
  it('accepts valid values and rejects the rest', () => {
    expect(checkPropertyValues({ 'max-players': '50', pvp: 'false', gamemode: 'creative', 'custom-key': 'x' })).toEqual({
      'max-players': '50',
      pvp: 'false',
      gamemode: 'creative',
      'custom-key': 'x',
    });
    expect(() => checkPropertyValues({ 'max-players': '0' })).toThrow();
    expect(() => checkPropertyValues({ pvp: 'yes' })).toThrow();
    expect(() => checkPropertyValues({ gamemode: 'god' })).toThrow();
    expect(() => checkPropertyValues({ 'server-port': '1' })).toThrow(/Settings tab/);
    expect(() => checkPropertyValues({ 'Bad Key': '1' })).toThrow();
  });
});

describe('file manager', () => {
  it('refuses paths outside the server folder', async () => {
    await expect(resolveSafe(serverDir, '../escape.txt')).rejects.toThrow();
    await expect(resolveSafe(serverDir, 'C:/Windows/win.ini')).rejects.toThrow();
    await expect(resolveSafe(serverDir, 'a/../../b')).rejects.toThrow();
    await expect(resolveSafe(serverDir, 'con')).rejects.toThrow();
    expect(await resolveSafe(serverDir, 'plugins/Essentials/config.yml')).toBe(path.join(serverDir, 'plugins', 'Essentials', 'config.yml'));
  });

  it('refuses to follow a link that points outside', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await symlink(outside, path.join(serverDir, 'link'), 'junction');
    await expect(resolveSafe(serverDir, 'link/secret.txt')).rejects.toThrow(/outside/);
    await expect(readText(serverDir, 'link/secret.txt')).rejects.toThrow(/outside/);
  });

  it('lists, writes, reads, renames and trashes', async () => {
    await mkdir(path.join(serverDir, 'plugins'));
    await writeText(serverDir, 'plugins/config.yml', 'motd: ahoj\n');
    await writeFile(path.join(serverDir, 'paper.jar'), Buffer.from([0x50, 0x4b, 0, 0, 1]));

    const list = await listDir(serverDir, '');
    expect(list.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:plugins', 'file:paper.jar']);
    expect((await readText(serverDir, 'plugins/config.yml')).content).toBe('motd: ahoj\n');
    await expect(readText(serverDir, 'paper.jar')).rejects.toThrow(/not a text file/);

    await renamePath(serverDir, 'plugins/config.yml', 'plugins/config.old.yml');
    await expect(renamePath(serverDir, 'paper.jar', 'plugins')).rejects.toThrow(/already exists/);

    const trash = await trashPaths(serverDir, ['plugins'], path.join(root, 'trash'));
    expect(await stat(path.join(serverDir, 'plugins')).catch(() => null)).toBeNull();
    expect(await readFile(path.join(trash, 'plugins', 'config.old.yml'), 'utf8')).toBe('motd: ahoj\n');
    await expect(trashPaths(serverDir, [''], path.join(root, 'trash'))).rejects.toThrow();
  });

  it('streams uploads with a size limit', async () => {
    await saveUpload(serverDir, '', 'mod.jar', Readable.from([Buffer.alloc(1000)]), 2000, false);
    expect((await stat(path.join(serverDir, 'mod.jar'))).size).toBe(1000);
    await expect(saveUpload(serverDir, '', 'mod.jar', Readable.from([Buffer.alloc(10)]), 2000, false)).rejects.toThrow(/already exists/);
    await expect(saveUpload(serverDir, '', 'big.jar', Readable.from([Buffer.alloc(3000)]), 2000, false)).rejects.toThrow(/too big/);
    expect(await stat(path.join(serverDir, 'big.jar.srvmc-upload')).catch(() => null)).toBeNull();
    await expect(saveUpload(serverDir, '', '..\\evil.jar', Readable.from([Buffer.alloc(1)]), 2000, false)).rejects.toThrow();
  });
});

describe('logs', () => {
  it('lists and reads plain and gzipped logs', async () => {
    await mkdir(path.join(serverDir, 'logs'));
    await mkdir(path.join(serverDir, 'crash-reports'));
    await writeFile(path.join(serverDir, 'logs', 'latest.log'), 'line 1\n');
    await writeFile(path.join(serverDir, 'logs', '2026-10-20-1.log.gz'), gzipSync('old log\n'));
    await writeFile(path.join(serverDir, 'crash-reports', 'crash-2026-10-20.txt'), 'boom');
    const logs = await listLogs(serverDir);
    expect(logs.map((l) => l.name).sort()).toEqual(['2026-10-20-1.log.gz', 'crash-2026-10-20.txt', 'latest.log']);
    expect((await readLog(serverDir, 'log', '2026-10-20-1.log.gz')).text).toBe('old log\n');
    await expect(readLog(serverDir, 'log', '../server.properties')).rejects.toThrow();
  });
});

describe('server icon', () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  it('accepts only 64×64 PNG', () => {
    expect(() => checkServerIcon(png(64, 64))).not.toThrow();
    expect(() => checkServerIcon(png(128, 128))).toThrow(/64×64/);
    expect(() => checkServerIcon(Buffer.from('GIF89a'))).toThrow(/PNG/);
  });
});
