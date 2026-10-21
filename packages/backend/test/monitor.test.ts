import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogLine, ScheduledTask } from '@srvmc/shared';
import { analyzeCrash, describeCrash, errorText, exitText, findSuspects } from '../src/crash.ts';
import { checkDiskRoom, folderSize } from '../src/disk.ts';
import { bucketize, dayFile, MetricHistory, parseLines } from '../src/history.ts';
import { nextTaskRun, sanitizeTasks } from '../src/scheduler.ts';
import { BUKKIT_TPS, forgeTps, TICK_QUERY, tpsProbeFor } from '../src/tps.ts';
import { mcString, packet, readMcString, readVarInt, takePackets, WakeListener, writeVarInt } from '../src/wake.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-monitor-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const task = (t: Partial<ScheduledTask>): ScheduledTask => ({ id: 'a', action: 'restart', repeat: 'days', time: '04:00', days: [0, 1, 2, 3, 4, 5, 6], warn: true, enabled: true, ...t });

describe('scheduler times', () => {
  it('runs daily at the time, strictly after now', () => {
    expect(nextTaskRun(task({}), at(2026, 10, 21, 3, 0))).toBe(at(2026, 10, 21, 4, 0));
    expect(nextTaskRun(task({}), at(2026, 10, 21, 4, 0))).toBe(at(2026, 10, 22, 4, 0));
  });

  it('respects weekdays (0 = Sunday)', () => {
    // 2026-10-21 is a Wednesday; the next Monday is 26th.
    expect(nextTaskRun(task({ days: [1] }), at(2026, 10, 21, 12))).toBe(at(2026, 10, 26, 4, 0));
    expect(nextTaskRun(task({ days: [] }), at(2026, 10, 21))).toBeNull();
    expect(nextTaskRun(task({ enabled: false }), at(2026, 10, 21))).toBeNull();
  });

  it('repeats intervals counted from the time, across midnight', () => {
    const every6h = task({ repeat: 'interval', everyMin: 360, time: '04:00' });
    expect(nextTaskRun(every6h, at(2026, 10, 21, 0, 30))).toBe(at(2026, 10, 21, 4, 0));
    expect(nextTaskRun(every6h, at(2026, 10, 21, 4, 0))).toBe(at(2026, 10, 21, 10, 0));
    expect(nextTaskRun(every6h, at(2026, 10, 21, 23, 0))).toBe(at(2026, 10, 22, 4, 0));
    expect(nextTaskRun(task({ repeat: 'interval', everyMin: 15, time: '00:00' }), at(2026, 10, 21, 10, 7))).toBe(at(2026, 10, 21, 10, 15));
  });

  it('validates tasks and keeps run history of known ones', () => {
    const existing = [task({ id: 'keep', lastRun: 5, lastResult: 'ok' })];
    const [kept, created] = sanitizeTasks(
      [
        { id: 'keep', action: 'restart', repeat: 'days', time: '05:30', days: [1, 1, 9, 3] },
        { id: 'forged', action: 'command', repeat: 'interval', time: '00:00', everyMin: 30, command: '/say hi\nop me', lastRun: 1 },
      ],
      existing,
    );
    expect(kept).toMatchObject({ id: 'keep', days: [1, 3], lastRun: 5, warn: true });
    expect(created!.id).not.toBe('forged');
    expect(created).toMatchObject({ command: 'say hi op me', everyMin: 30, warn: false, days: [] });
    expect(created!.lastRun).toBeUndefined();
    expect(() => sanitizeTasks([{ action: 'format c:', time: '04:00', days: [1] }])).toThrow(/Neznámá/);
    expect(() => sanitizeTasks([{ action: 'stop', time: '25:00', days: [1] }])).toThrow(/HH:MM/);
    expect(() => sanitizeTasks([{ action: 'stop', time: '04:00', days: [] }])).toThrow(/den/);
    expect(() => sanitizeTasks([{ action: 'stop', repeat: 'interval', time: '04:00', everyMin: 1 }])).toThrow(/Interval/);
    expect(() => sanitizeTasks([{ action: 'command', time: '04:00', days: [1], command: ' ' }])).toThrow(/příkaz/);
  });
});

describe('load history', () => {
  it('folds points into buckets', () => {
    const m = 60_000;
    const pts = [
      { t: 0, cpu: 10, memMb: 1000, players: 1, tps: 20 },
      { t: m, cpu: 30, memMb: 1500, players: 3, tps: 18.5 },
      { t: 5 * m, cpu: 5, memMb: 900, players: 0, tps: null },
    ];
    expect(bucketize(pts, 5 * m)).toEqual([
      { t: 0, cpu: 20, memMb: 1500, players: 3, tps: 18.5 },
      { t: 5 * m, cpu: 5, memMb: 900, players: 0, tps: null },
    ]);
  });

  it('skips broken lines', () => {
    expect(parseLines('{"t":1,"cpu":2,"memMb":3,"players":0,"tps":null}\n{"t":2,"cpu"\n\n')).toHaveLength(1);
  });

  it('records minutes to disk, answers ranges and purges old days', async () => {
    const h = new MetricHistory(path.join(root, 'metrics'));
    const now = Date.now();
    const minute = Math.floor(now / 60_000) * 60_000;
    h.record('s1', { t: minute - 120_000, cpu: 10, memMb: 1000, players: 1 });
    h.record('s1', { t: minute - 119_000, cpu: 20, memMb: 1200, players: 2, tps: 19 });
    h.record('s1', { t: minute - 60_000, cpu: 40, memMb: 800, players: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await h.flush('s1');
    const pts = await h.query('s1', '1h', now);
    expect(pts).toEqual([
      { t: minute - 120_000, cpu: 15, memMb: 1200, players: 2, tps: 19 },
      { t: minute - 60_000, cpu: 40, memMb: 800, players: 0, tps: null },
    ]);
    expect((await h.query('s1', '24h', now)).length).toBeGreaterThanOrEqual(1);

    const old = path.join(root, 'metrics', 's1', dayFile(now - 40 * 86_400_000));
    await writeFile(old, '');
    await h.purge(now);
    expect(await readdir(path.join(root, 'metrics', 's1'))).not.toContain(path.basename(old));
    await h.remove('s1');
    expect(await readdir(path.join(root, 'metrics'))).toEqual([]);
  });
});

describe('TPS', () => {
  it('reads Bukkit, Forge and vanilla answers', () => {
    expect(BUKKIT_TPS.parse('[12:00:00 INFO]: TPS from last 1m, 5m, 15m: *20.0, 19.98, 19.5')).toBe(20);
    expect(BUKKIT_TPS.parse('[12:00:00 INFO]: TPS from last 1m, 5m, 15m: 14,2, 15.0, 16.0')).toBe(14.2);
    const forge = forgeTps('forge tps');
    expect(forge.parse('[Server thread/INFO]: Overall: Mean tick time: 2.345 ms. Mean TPS: 20.000')).toBe(20);
    expect(forge.parse('[Server thread/INFO]: Overall: 17.523 TPS (57.068 ms/tick)')).toBe(17.5);
    expect(forge.answer.test('Dim minecraft:overworld (minecraft:overworld): 20.000 TPS (0.517 ms/tick)')).toBe(true);
    expect(forge.parse('Dim minecraft:overworld (minecraft:overworld): 20.000 TPS (0.517 ms/tick)')).toBeNull();
    expect(TICK_QUERY.parse('Average time per tick: 3.2ms (Target: 50.0ms)')).toBe(20);
    expect(TICK_QUERY.parse('Average time per tick: 100,0ms (Target: 50.0ms)')).toBe(10);
    expect(TICK_QUERY.answer.test('[12:00:00] [Server thread/INFO]: The game is running normally')).toBe(true);
    expect(TICK_QUERY.answer.test('[12:00:00] [Server thread/INFO]: Steve joined the game')).toBe(false);
  });

  it('picks the command per server type and version', () => {
    expect(tpsProbeFor({ type: 'paper', version: '1.21.11' })?.command).toBe('tps');
    expect(tpsProbeFor({ type: 'neoforge', version: '1.21.1' })?.command).toBe('neoforge tps');
    expect(tpsProbeFor({ type: 'neoforge', version: '1.20.1' })?.command).toBe('forge tps');
    expect(tpsProbeFor({ type: 'fabric', version: '26.1.2' })?.command).toBe('tick query');
    expect(tpsProbeFor({ type: 'vanilla', version: '1.20.1' })).toBeNull();
    expect(tpsProbeFor({ type: 'vanilla', version: '25w14a' })).toBeNull();
    expect(tpsProbeFor({ type: 'modpack', version: '1.21.1', modpack: { source: 'modrinth', projectId: 'p', versionId: 'v', title: 'P', versionNumber: '1', loader: 'forge' } })?.command).toBe('forge tps');
  });
});

describe('crash analysis', () => {
  it('names well-known causes', () => {
    expect(describeCrash('java.lang.OutOfMemoryError: Java heap space', { port: 25565 })).toEqual({ summary: expect.stringMatching(/paměť/), permanent: false });
    expect(describeCrash('**** FAILED TO BIND TO PORT!', { port: 25570 })).toEqual({ summary: expect.stringMatching(/25570/), permanent: true });
    expect(describeCrash('Incompatible mods found!', { port: 1 })?.permanent).toBe(true);
    expect(describeCrash('just an error', { port: 1 })).toBeNull();
  });

  it('finds suspect mods and plugins', () => {
    const forge = 'Suspected Mods: \n\tCreate (create), Version: 6.0.0\n\t\tIssue tracker URL: x\n\tMinecraft (minecraft), Version: 1.21.1';
    expect(findSuspects(forge)).toEqual(['Create']);
    expect(findSuspects("\t - Mod 'Sodium' (sodium) 0.6.0 requires version 0.16 of 'Fabric Loader'")).toEqual(['Sodium']);
    expect(findSuspects('at me.lucko.Foo.bar(Foo.java:1) ~[LuckPerms-Bukkit-5.5.71.jar:?]\n at net.minecraft.X ~[paper-26.3.jar:26.3-211]')).toEqual(['LuckPerms-Bukkit-5.5.71']);
    expect(findSuspects('Mixin apply for mod lithium failed lithium.mixins.json')).toEqual(['lithium']);
  });

  it('ignores mods named by startup warnings and explains forced kills', () => {
    const lines: LogLine[] = [
      { t: 1, level: 'warn', text: "[main/WARN]: Reference map 'x.refmap.json' for modernfix-fabric.mixins.json from mod modernfix could not be read" },
      { t: 2, level: 'error', text: '[main/ERROR]: Incompatible mods found!' },
      { t: 3, level: 'info', text: "\t - Mod 'Sodium' (sodium) 0.6.0 requires version 0.16 of 'Fabric Loader'" },
      { t: 4, level: 'info', text: '[main/INFO]: next' },
    ];
    expect(findSuspects(errorText(lines))).toEqual(['Sodium']);
    expect(exitText(4294967295)).toMatch(/násilně/);
    expect(exitText(4294967294)).toBe('Server skončil s kódem -2.');
    expect(exitText(1)).toBe('Server skončil s kódem 1.');
  });

  it('reads the newest crash report of the run', async () => {
    await mkdir(path.join(root, 'crash-reports'));
    const old = path.join(root, 'crash-reports', 'crash-old.txt');
    await writeFile(old, 'Description: Old');
    await utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await writeFile(path.join(root, 'crash-reports', 'crash-new-server.txt'), 'Description: Ticking entity\n\njava.lang.NullPointerException: Cannot invoke "x"\n\tat com.simibubi.create.Foo ~[create-6.0.jar:?]\n');
    const log: LogLine[] = [{ t: Date.now(), level: 'error', text: 'Something broke' }];
    const info = await analyzeCrash({ dir: root, since: Date.now() - 60_000, log, port: 25565, code: 1 });
    expect(info).toMatchObject({ report: 'crash-new-server.txt', suspects: ['create-6.0'] });
    expect(info.summary).toBe('Ticking entity · NullPointerException: Cannot invoke "x"');
    const none = await analyzeCrash({ dir: path.join(root, 'nothing'), since: Date.now(), log: [], port: 1, code: 137 });
    expect(none.summary).toBe('Server skončil s kódem 137.');
  });
});

describe('disk limit', () => {
  it('measures folders and refuses what would cross the limit', async () => {
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await writeFile(path.join(root, 'a', 'x.bin'), Buffer.alloc(1000));
    await writeFile(path.join(root, 'a', 'b', 'y.bin'), Buffer.alloc(24));
    expect(await folderSize(root)).toBe(1024);
    expect(() => checkDiskRoom({}, 5000, 1e12)).not.toThrow();
    expect(() => checkDiskRoom({ diskLimitMb: 1000 }, 900, 50 * 1024 * 1024)).not.toThrow();
    expect(() => checkDiskRoom({ diskLimitMb: 1000 }, 900, 200 * 1024 * 1024)).toThrow(/Překročil bys/);
    expect(() => checkDiskRoom({ diskLimitMb: 1000 }, 1200)).toThrow(/překročil limit/);
  });
});

describe('wake on join', () => {
  it('encodes VarInts and strings like Minecraft', () => {
    expect([...writeVarInt(300)]).toEqual([0xac, 0x02]);
    expect(writeVarInt(-1).length).toBe(5);
    expect(readVarInt(Buffer.from([0xac, 0x02]), 0)).toEqual({ value: 300, size: 2 });
    expect(readVarInt(Buffer.from([0x80]), 0)).toBeNull();
    expect(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0)).toThrow();
    expect(readMcString(mcString('Ahoj ž'), 0)).toEqual({ value: 'Ahoj ž', size: 8 });
    const two = Buffer.concat([packet(0, Buffer.from([1])), packet(1, Buffer.from([2, 3]))]);
    expect(takePackets(Buffer.concat([two, Buffer.from([5])]))).toMatchObject({ packets: [{ id: 0 }, { id: 1 }], rest: Buffer.from([5]) });
  });

  async function freePort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r));
    return port;
  }

  function exchange(port: number, data: Buffer, expectClose: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const s = net.connect(port, '127.0.0.1', () => s.write(data));
      s.on('data', (c) => {
        chunks.push(c);
        if (!expectClose) {
          const { packets } = takePackets(Buffer.concat(chunks));
          if (packets.length) {
            s.destroy();
            resolve(Buffer.concat(chunks));
          }
        }
      });
      s.on('close', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });
  }

  const handshake = (port: number, next: number) =>
    packet(0, writeVarInt(773), mcString('localhost'), Buffer.from([(port >> 8) & 255, port & 255]), writeVarInt(next));

  it('answers the server list ping and wakes on a join attempt', async () => {
    const port = await freePort();
    let joined: string | null | undefined;
    let listener!: WakeListener;
    const woke = new Promise<void>((r) => {
      listener = new WakeListener({
        port,
        kickMessage: 'Probouzí se',
        status: async () => ({ motd: 'Test\n§6Spí', maxPlayers: 10 }),
        onJoin: (name) => {
          joined = name;
          r();
        },
      });
    });
    await listener.open();
    expect(listener.listening).toBe(true);

    const status = await exchange(port, Buffer.concat([handshake(port, 1), packet(0)]), false);
    const json = JSON.parse(readMcString(takePackets(status).packets[0]!.data, 0)!.value);
    expect(json).toMatchObject({ version: { protocol: 773 }, players: { max: 10, online: 0 }, description: { text: 'Test\n§6Spí' } });

    const ping = await exchange(port, Buffer.concat([handshake(port, 1), packet(1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))]), true);
    expect([...takePackets(ping).packets[0]!.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const login = await exchange(port, Buffer.concat([handshake(port, 2), packet(0, mcString('Steve'), Buffer.alloc(16))]), true);
    expect(JSON.parse(readMcString(takePackets(login).packets[0]!.data, 0)!.value)).toEqual({ text: 'Probouzí se' });
    await woke;
    expect(joined).toBe('Steve');
    expect(listener.listening).toBe(false);
    // The port is free again for the real server.
    const again = net.createServer();
    await new Promise<void>((resolve, reject) => again.once('error', reject).listen(port, resolve));
    await new Promise((r) => again.close(r));
  });

  it('drops garbage and legacy pings', async () => {
    const port = await freePort();
    const listener = new WakeListener({ port, kickMessage: '', status: async () => ({ motd: '', maxPlayers: 1 }), onJoin: () => undefined });
    await listener.open();
    expect((await exchange(port, Buffer.from([0xfe, 0x01]), true)).length).toBe(0);
    expect((await exchange(port, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), true)).length).toBe(0);
    expect(listener.listening).toBe(true);
    await listener.close();
  });
});
