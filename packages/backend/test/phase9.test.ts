import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PanelUser } from '@srvmc/shared';
import { allowed, canSee, need } from '../src/access.ts';
import { bluemapConfigDir, confValue, geyserTarget, setConf } from '../src/addons.ts';
import { startBackend, type Backend } from '../src/app.ts';
import { checkWebhook, embed } from '../src/discord.ts';
import { makePaths } from '../src/paths.ts';
import { foldLog, logDay, readGameStats } from '../src/playerstats.ts';
import { aliasFor, forwardingMethod, setYamlPath } from '../src/proxy.ts';
import { replaceTomlTable, setTomlKey, velocityConfig, velocityJava } from '../src/providers/velocity.ts';
import { hashPassword, UserStore, verifyPassword } from '../src/users.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-p9-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const user = (role: PanelUser['role'], servers: PanelUser['servers'] = 'all'): PanelUser => ({ id: 'u', name: 'u', role, servers, createdAt: 0 });

describe('access rules', () => {
  it('maps requests to capabilities', () => {
    expect(need('GET', '/api/auth/me')).toBeNull();
    expect(need('GET', '/index.html')).toBeNull();
    expect(need('GET', '/api/servers')).toEqual({ cap: 'view' });
    expect(need('POST', '/api/servers')).toEqual({ cap: 'admin' });
    expect(need('POST', '/api/servers/abc/start')).toEqual({ cap: 'power', serverId: 'abc' });
    expect(need('POST', '/api/servers/abc/command')).toEqual({ cap: 'console', serverId: 'abc' });
    expect(need('GET', '/api/servers/abc/log')).toEqual({ cap: 'console', serverId: 'abc' });
    expect(need('GET', '/api/servers/abc/files?path=x')).toEqual({ cap: 'manage', serverId: 'abc' });
    expect(need('GET', '/api/servers/abc/worlds/w/download')).toEqual({ cap: 'manage', serverId: 'abc' });
    expect(need('DELETE', '/api/servers/abc')).toEqual({ cap: 'admin', serverId: 'abc' });
    expect(need('PATCH', '/api/servers/abc')).toEqual({ cap: 'manage', serverId: 'abc' });
    expect(need('PUT', '/api/network/duckdns')).toEqual({ cap: 'admin' });
    expect(need('GET', '/api/users')).toEqual({ cap: 'owner' });
  });

  it('lets each role do its part', () => {
    const mod = user('moderator', ['a']);
    expect(allowed(mod, { cap: 'console', serverId: 'a' })).toBe(true);
    expect(allowed(mod, { cap: 'console', serverId: 'b' })).toBe(false);
    expect(allowed(mod, { cap: 'manage', serverId: 'a' })).toBe(false);
    expect(allowed(user('starter', ['a']), { cap: 'power', serverId: 'a' })).toBe(true);
    expect(allowed(user('starter', ['a']), { cap: 'console', serverId: 'a' })).toBe(false);
    expect(allowed(user('admin'), { cap: 'owner' })).toBe(false);
    expect(allowed(user('owner'), { cap: 'owner' })).toBe(true);
    expect(canSee(user('admin', []), 'x')).toBe(true);
  });
});

describe('accounts', () => {
  it('hashes passwords with scrypt', async () => {
    const h = await hashPassword('tajne-heslo');
    expect(h).toMatch(/^scrypt\$32768\$/);
    expect(await verifyPassword('tajne-heslo', h)).toBe(true);
    expect(await verifyPassword('spatne', h)).toBe(false);
  });

  it('makes the first account an owner and protects the last owner', async () => {
    const store = new UserStore(path.join(root, 'users.json'));
    await store.load();
    const first = await store.create({ name: 'Samuel', password: 'heslo1234', role: 'starter' });
    expect(first.role).toBe('owner');
    const mod = await store.create({ name: 'mod', password: 'heslo1234', role: 'moderator', servers: ['s1'] });
    await expect(store.create({ name: 'MOD', password: 'heslo1234', role: 'starter' })).rejects.toThrow(/Another account/);
    await expect(store.create({ name: 'x', password: 'heslo1234', role: 'starter' })).rejects.toThrow(/2–32/);
    await expect(store.create({ name: 'kratke', password: '123', role: 'starter' })).rejects.toThrow(/8 characters/);
    await expect(store.update(first.id, { role: 'admin' })).rejects.toThrow(/last owner must stay/);
    await expect(store.remove(first.id)).rejects.toThrow(/last owner cannot/);
    expect(await store.verify('SAMUEL', 'heslo1234')).toMatchObject({ id: first.id });
    expect(await store.verify('Samuel', 'nope')).toBeNull();
    expect(await store.verify('nikdo', 'heslo1234')).toBeNull();

    const token = await store.startSession(mod.id);
    expect(store.session(token)?.name).toBe('mod');
    await store.update(mod.id, { password: 'nove-heslo' });
    expect(store.session(token)).toBeNull();
    await store.forgetServer('s1');
    expect(store.get(mod.id)?.servers).toEqual([]);
    await store.setLan(true);
    const again = new UserStore(path.join(root, 'users.json'));
    await again.load();
    expect(again.lan).toBe(true);
    expect(again.list()).toHaveLength(2);
  });
});

describe('Discord', () => {
  it('accepts only Discord webhooks and never pings', () => {
    expect(checkWebhook(' https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-1234 ')).toContain('discord.com');
    expect(() => checkWebhook('https://evil.example/api/webhooks/1/abc')).toThrow();
    expect(() => checkWebhook('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')).toThrow();
    const e = embed('Survival', 'join', '**@everyone** se připojil');
    expect(e.allowed_mentions).toEqual({ parse: [] });
    expect(e.embeds[0]).toMatchObject({ title: 'Survival', color: 0x6aa9ff });
  });
});

describe('player statistics', () => {
  it('counts sessions from logs, across midnight and server stops', () => {
    const store = { backfilled: false, players: {} };
    const day = new Date(2026, 9, 20).getTime();
    foldLog(
      store,
      [
        '[23:00:00] [User Authenticator #1/INFO]: UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
        '[23:00:01] [Server thread/INFO]: Steve joined the game',
        '[23:30:00 INFO]: Alex joined the game',
        '[00:30:01] [Server thread/INFO]: Steve left the game',
        '[01:00:00] [Server thread/INFO]: Stopping server',
      ],
      day,
    );
    const steve = (store.players as Record<string, { playMs: number; sessions: number; uuid?: string }>).steve!;
    expect(steve.playMs).toBe(90 * 60_000);
    expect(steve.sessions).toBe(1);
    expect(steve.uuid).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5');
    expect((store.players as Record<string, { playMs: number }>).alex!.playMs).toBe(90 * 60_000);
    expect(logDay('2026-10-21-3.log.gz')).toBe(new Date(2026, 9, 21).getTime());
    expect(logDay('latest.log')).toBeNull();
  });

  it('reads 26.x and Forge log lines', () => {
    const store = { backfilled: true, players: {} };
    const day = new Date(2026, 9, 22).getTime();
    foldLog(
      store,
      [
        '[22říj2026 17:00:00.137] [User Authenticator #1/INFO] [net.minecraft.server.network.ServerLoginPacketListenerImpl/]: UUID of player OpiKula is 0ce9d7b5-20a0-4629-92f5-0e79943ed8bc',
        '[22říj2026 17:00:01.863] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: System chat: OpiKula joined the game',
        '[22říj2026 17:30:01.129] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: System chat: OpiKula left the game',
      ],
      day,
    );
    const p = (store.players as Record<string, { playMs: number; sessions: number; uuid?: string }>).opikula!;
    expect(p.sessions).toBe(1);
    expect(p.playMs).toBe(30 * 60_000);
    expect(p.uuid).toBe('0ce9d7b5-20a0-4629-92f5-0e79943ed8bc');
  });

  it('reads Minecraft stats files', () => {
    const g = readGameStats({
      stats: {
        'minecraft:custom': { 'minecraft:play_time': 72000, 'minecraft:deaths': 3, 'minecraft:mob_kills': 12, 'minecraft:walk_one_cm': 150000, 'minecraft:sprint_one_cm': 50000 },
        'minecraft:mined': { 'minecraft:stone': 100, 'minecraft:dirt': 20 },
      },
    });
    expect(g).toEqual({ playTicks: 72000, deaths: 3, mobKills: 12, playerKills: undefined, blocksMined: 120, distanceKm: 2 });
  });
});

describe('add-ons', () => {
  it('knows where Geyser and BlueMap go', () => {
    expect(geyserTarget('paper')).toMatchObject({ platform: 'spigot', folder: 'plugins' });
    expect(geyserTarget('neoforge')).toMatchObject({ platform: 'neoforge', folder: 'mods' });
    expect(geyserTarget('forge')).toBeNull();
    expect(geyserTarget('velocity')?.platform).toBe('velocity');
    expect(bluemapConfigDir('fabric')).toBe('config/bluemap');
    expect(bluemapConfigDir('velocity')).toBeNull();
  });

  it('edits BlueMap HOCON values', () => {
    const conf = '# comment\naccept-download: false\nrender-thread-count: 1\n';
    expect(setConf(conf, 'accept-download', 'true')).toBe('# comment\naccept-download: true\nrender-thread-count: 1\n');
    expect(confValue('port: 8100\n', 'port')).toBe('8100');
    expect(setConf('a: 1', 'port', '8101')).toBe('a: 1\nport: 8101\n');
  });
});

describe('Velocity network', () => {
  it('sets nested YAML for Paper and keeps the rest', () => {
    const paper = 'proxies:\n  bungee-cord:\n    online-mode: true\n  velocity:\n    enabled: false\n    online-mode: false\n    secret: \'\'\nmisc:\n  x: 1\n';
    let t = setYamlPath(paper, ['proxies', 'velocity', 'enabled'], 'true');
    t = setYamlPath(t, ['proxies', 'velocity', 'secret'], "'abc'");
    expect(t).toBe(paper.replace('enabled: false', 'enabled: true').replace("secret: ''", "secret: 'abc'"));
    expect(setYamlPath('', ['proxies', 'velocity', 'enabled'], 'true')).toBe('proxies:\n  velocity:\n    enabled: true');
    expect(setYamlPath('proxies:\n  bungee-cord:\n    online-mode: true\n', ['proxies', 'velocity', 'enabled'], 'true')).toBe('proxies:\n  velocity:\n    enabled: true\n  bungee-cord:\n    online-mode: true\n');
    // A key of the same name deeper down is not the one we want.
    expect(setYamlPath('a:\n  b:\n    enabled: false\nenabled: x\n', ['enabled'], 'true')).toBe('a:\n  b:\n    enabled: false\nenabled: true\n');
  });

  it('names servers and picks the forwarding method', () => {
    expect(aliasFor('Survival s kamarády!')).toBe('survival-s-kamarady');
    expect(aliasFor('***')).toBe('server');
    expect(forwardingMethod('purpur')).toBe('paper');
    expect(forwardingMethod('quilt')).toBe('fabric');
    expect(forwardingMethod('spigot')).toBeNull();
  });

  it('writes velocity.toml from the default template', () => {
    const template = [
      'config-version = "2.7"',
      'bind = "0.0.0.0:25565"',
      'motd = "<#09add3>A Velocity Server"',
      'player-info-forwarding-mode = "NONE"',
      'forwarding-secret-file = "forwarding.secret"',
      '',
      '[servers]',
      'lobby = "127.0.0.1:30066"',
      'try = [',
      '    "lobby"',
      ']',
      '',
      '[forced-hosts]',
      '"lobby.example.com" = [',
      '    "lobby"',
      ']',
      '',
      '[advanced]',
      'compression-threshold = 256',
    ].join('\n');
    const out = velocityConfig(template, 25577, 'Moje síť', [
      { alias: 'lobby', port: 25565 },
      { alias: 'survival', port: 25566 },
    ]);
    expect(out).toContain('bind = "0.0.0.0:25577"');
    expect(out).toContain('player-info-forwarding-mode = "modern"');
    expect(out).toContain('[servers]\nlobby = "127.0.0.1:25565"\nsurvival = "127.0.0.1:25566"\ntry = ["lobby", "survival"]');
    expect(out).toContain('[forced-hosts]\n\n[advanced]\ncompression-threshold = 256');
    expect(out).not.toContain('30066');
    expect(setTomlKey('a = 1\n[t]\nb = 2', 'b', '3')).toBe('a = 1\nb = 3\n[t]\nb = 2');
    expect(replaceTomlTable('x = 1', 'servers', ['a = "b"'])).toBe('x = 1\n\n[servers]\na = "b"\n');
    expect(velocityJava('4.3.0')).toBe(25);
    expect(velocityJava('3.4.0-SNAPSHOT')).toBe(21);
  });
});

describe('panel sign-in over HTTP', () => {
  let backend: Backend;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'srvmc-auth-'));
    backend = await startBackend({ port: 0, paths: makePaths(dir), localToken: 'desktop-token' });
  });
  afterAll(async () => {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (method: string, url: string, opts: { body?: unknown; cookie?: string; local?: boolean } = {}) => {
    const res = await fetch(`${backend.url}${url}`, {
      method,
      headers: {
        'x-srvmc': '1',
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        ...(opts.cookie && { cookie: opts.cookie }),
        ...(opts.local && { 'x-srvmc-local': 'desktop-token' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
  };

  it('is open on this computer until the first account, then asks to sign in', async () => {
    expect((await call('GET', '/api/auth/me')).body).toMatchObject({ authRequired: false, local: true, user: { role: 'owner' } });
    expect((await call('GET', '/api/servers')).status).toBe(200);

    expect((await call('POST', '/api/users', { body: { name: 'samuel', password: 'heslo-1234', role: 'owner' } })).status).toBe(200);
    expect((await call('GET', '/api/servers')).status).toBe(401);
    expect((await call('GET', '/api/auth/me')).body).toMatchObject({ authRequired: true, user: null });
    // The desktop window keeps working without signing in.
    expect((await call('GET', '/api/servers', { local: true })).status).toBe(200);
    expect((await call('GET', '/api/servers', { local: true, cookie: 'srvmc_session=forged' })).status).toBe(200);

    const bad = await call('POST', '/api/auth/login', { body: { name: 'samuel', password: 'wrong-password' } });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/api/auth/login', { body: { name: 'samuel', password: 'heslo-1234' } });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/srvmc_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+/);
    const cookie = ok.cookie!.split(';')[0]!;
    expect((await call('GET', '/api/servers', { cookie })).status).toBe(200);
    expect((await call('GET', '/api/users', { cookie })).body).toHaveLength(1);

    // A moderator sees only listed servers and cannot create or manage.
    await call('POST', '/api/users', { cookie, body: { name: 'mod', password: 'heslo-1234', role: 'moderator', servers: [] } });
    const modCookie = (await call('POST', '/api/auth/login', { body: { name: 'mod', password: 'heslo-1234' } })).cookie!.split(';')[0]!;
    expect((await call('GET', '/api/servers', { cookie: modCookie })).body).toEqual([]);
    expect((await call('POST', '/api/servers', { cookie: modCookie, body: {} })).status).toBe(403);
    expect((await call('GET', '/api/users', { cookie: modCookie })).status).toBe(403);
    expect((await call('PUT', '/api/network/duckdns', { cookie: modCookie, body: { domain: 'x', token: 'y' } })).status).toBe(403);

    await call('POST', '/api/auth/logout', { cookie: modCookie });
    expect((await call('GET', '/api/servers', { cookie: modCookie })).status).toBe(401);
  });

  it('slows down password guessing', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call('POST', '/api/auth/login', { body: { name: 'samuel', password: `guess-${i}xx` } })).status;
    expect(last).toBe(429);
  });
});
