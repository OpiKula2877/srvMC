import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDatapack, listDatapacks, removeDatapack, setDatapackEnabled } from '../src/datapacks.ts';
import { cfb8 } from '../src/login/cfb8.ts';
import { atLeast, entityAnswer, limboKind, packFormat, packMeta, parseNumbers, VOID_DIMENSION, writeLimboPack } from '../src/login/limbo.ts';
import { cheapId, frame, FrameReader, mcHexDigest, openFrame, packetIds, readString, str, varInt } from '../src/login/protocol.ts';
import { LoginProxy, type Session } from '../src/login/proxy.ts';
import { checkPassword, LoginStore } from '../src/login/store.ts';
import { writeZip, collectFiles } from '../src/zip.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-login-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digest = (s: string) => mcHexDigest(createHash('sha1').update(s).digest());

describe('protocol pieces', () => {
  it('computes Minecraft server hashes', () => {
    expect(digest('Notch')).toBe('4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48');
    expect(digest('jeb_')).toBe('-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1');
    expect(digest('simon')).toBe('88e16a1019277b15d58faf0541e11910eb756f6');
  });

  it('cuts frames, with and without compression', () => {
    const r = new FrameReader();
    const a = frame(5, str('hello'), false);
    const b = frame(7, str('x'.repeat(300)), true);
    const both = Buffer.concat([a, b]);
    expect(r.push(both.subarray(0, 3))).toHaveLength(0);
    const out = r.push(both.subarray(3));
    expect(out).toHaveLength(2);
    expect(openFrame(out[0]!.body, false).id).toBe(5);
    expect(readString(openFrame(out[1]!.body, true).data, 0).value).toBe('x'.repeat(300));
    // A big packet the other side compressed: its id needs unpacking.
    const payload = Buffer.concat([varInt(9), str('y'.repeat(400))]);
    const body = Buffer.concat([varInt(payload.length), deflateSync(payload)]);
    expect(cheapId(body, true)).toBeNull();
    expect(openFrame(body, true).id).toBe(9);
  });

  it('knows the packet ids per version and falls back to the newest', () => {
    expect(packetIds(340).ids.chat).toBe(2);
    expect(packetIds(763).ids.command).toBe(4);
    expect(packetIds(777).ids).toEqual({ chat: 9, command: 7, signedCommand: 8, configAck: 16, finishConfig: 3 });
    const future = packetIds(900);
    expect(future.exact).toBe(false);
    expect(future.ids.command).toBe(7);
  });

  it('encrypts CFB8 the same way natively and in JavaScript', () => {
    const key = randomBytes(16);
    const data = randomBytes(5000);
    const js = cfb8(key, false, false);
    const enc = Buffer.concat([js.update(data.subarray(0, 77)), js.update(data.subarray(77))]);
    expect(enc.equals(cfb8(key, false, true).update(data))).toBe(true);
    expect(cfb8(key, true, false).update(enc).equals(data)).toBe(true);
  });
});

describe('limbo', () => {
  it('picks the limbo and the pack format by version', () => {
    expect(limboKind('1.16.1')).toBe('freeze');
    expect(limboKind('1.16.2')).toBe('void');
    expect(limboKind('26.3')).toBe('void');
    expect(atLeast('1.12.2', 1, 13)).toBe(false);
    expect(packFormat('1.20.1')).toBe(15);
    expect(packFormat('1.21.11')).toBe(94);
    expect(packFormat('26.3')).toBe(121);
    expect(JSON.parse(packMeta('1.20.1')).pack.pack_format).toBe(15);
    expect(JSON.parse(packMeta('26.3')).pack).toMatchObject({ min_format: 121, max_format: 1000 });
  });

  it('writes the void dimension into the active world', async () => {
    await writeFile(path.join(root, 'server.properties'), 'level-name=main\n');
    await writeLimboPack(root, '26.3');
    const dim = JSON.parse(await readFile(path.join(root, 'main', 'datapacks', 'srvmc-login', 'data', 'srvmc', 'dimension', 'void.json'), 'utf8'));
    expect(dim).toEqual(VOID_DIMENSION);
    expect(dim.generator.settings.layers).toEqual([]);
  });

  it('reads /data answers', () => {
    const re = entityAnswer('Steve');
    const line = '[12:00:00] [Server thread/INFO]: Steve has the following entity data: [12.5d, 64.0d, -3.25d]';
    expect(parseNumbers(re.exec(line)![1]!)).toEqual([12.5, 64, -3.25]);
    expect(re.test('Alex has the following entity data: 0')).toBe(false);
  });
});

describe('accounts', () => {
  it('stores scrypt hashes and places', async () => {
    const s = new LoginStore(root);
    await s.create('Steve', 'secret1');
    const again = new LoginStore(root);
    await new Promise((r) => setTimeout(r, 50));
    const acc = await again.get('steve');
    expect(acc?.name).toBe('Steve');
    expect(acc?.password).not.toContain('secret1');
    expect(await checkPassword('secret1', acc!.password)).toBe(true);
    expect(await checkPassword('wrong', acc!.password)).toBe(false);
    await s.setPlace('Steve', { dim: 'minecraft:overworld', x: 1, y: 2, z: 3, yaw: 0, pitch: 0, mode: 0 });
    expect((await s.getPlace('STEVE'))?.y).toBe(2);
  });
});

describe('datapacks', () => {
  it('adds, turns off and deletes packs', async () => {
    await writeFile(path.join(root, 'server.properties'), 'level-name=world\n');
    const src = path.join(root, 'src', 'MyPack');
    await mkdir(path.join(src, 'data'), { recursive: true });
    await writeFile(path.join(src, 'pack.mcmeta'), '{"pack":{"pack_format":15,"description":"x"}}');
    const zip = path.join(root, 'upload.zip');
    await writeZip(await collectFiles(path.join(root, 'src'), ['MyPack']), zip);
    expect(await addDatapack(root, zip, 'MyPack-1.0.zip')).toBe('MyPack');
    expect((await listDatapacks(root)).map((p) => [p.name, p.enabled])).toEqual([['MyPack', true]]);
    await setDatapackEnabled(root, 'MyPack', false);
    expect((await listDatapacks(root))[0]!.enabled).toBe(false);
    await removeDatapack(root, 'MyPack');
    expect(await listDatapacks(root)).toEqual([]);
    await expect(setDatapackEnabled(root, 'srvmc-login', false)).rejects.toThrow();
  });
});

/** A fake 1.20.1 server and client through the proxy. */
describe('proxy', () => {
  it('passes the game through and keeps /register away from the server', async () => {
    const PROTO = 763;
    const fromClient: number[] = [];
    let serverSocket: net.Socket | undefined;
    const backend = net.createServer((sock) => {
      serverSocket = sock;
      const r = new FrameReader();
      let compressed = false;
      sock.on('data', (d) => {
        for (const f of r.push(d)) {
          const { id, data } = openFrame(f.body, compressed);
          if (!compressed && id === 0 && data.length > 4 && fromClient.length === 1) {
            // login start: compression on, then login success
            sock.write(frame(3, varInt(64), false));
            compressed = true;
            sock.write(frame(2, Buffer.concat([randomBytes(16), str('Steve'), varInt(0)]), true));
          }
          fromClient.push(id);
        }
      });
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
    const backendPort = (backend.address() as net.AddressInfo).port;
    const chats: string[] = [];
    let session: Session | undefined;
    const proxy = new LoginProxy({
      decide: async () => ({ kind: 'pass' }),
      joined: (s) => {
        session = s;
      },
      chat: (_s, text) => {
        chats.push(text);
        return text.startsWith('register');
      },
      closed: () => undefined,
      warn: () => undefined,
    });
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, r));
    const publicPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await proxy.listen(publicPort, backendPort);

    const client = net.connect(publicPort, '127.0.0.1');
    await new Promise<void>((r) => client.once('connect', () => r()));
    const handshake = Buffer.concat([varInt(PROTO), str('localhost'), Buffer.from([0x63, 0xdd]), varInt(2)]);
    client.write(frame(0, handshake, false));
    client.write(frame(0, Buffer.concat([str('Steve'), Buffer.from([0]), randomBytes(16)]), false));
    // wait for compression + success to come back
    const got = new FrameReader();
    let compressed = false;
    const ids: number[] = [];
    await new Promise<void>((resolve) => {
      client.on('data', (d) => {
        for (const f of got.push(d)) {
          const { id } = openFrame(f.body, compressed);
          ids.push(id);
          if (id === 3 && !compressed) compressed = true;
          if (id === 2) resolve();
        }
      });
    });
    expect(ids).toEqual([3, 2]);
    await new Promise((r) => setTimeout(r, 50));
    expect(session?.name).toBe('Steve');
    // chat_command (id 4 on 1.20.1), then a movement packet (id 0x14)
    client.write(frame(4, Buffer.concat([str('register hunter2 hunter2'), Buffer.alloc(8), Buffer.alloc(8), varInt(0), varInt(0), Buffer.alloc(3)]), true));
    client.write(frame(4, Buffer.concat([str('time set day'), Buffer.alloc(8), Buffer.alloc(8), varInt(0), varInt(0), Buffer.alloc(3)]), true));
    client.write(frame(0x14, Buffer.alloc(25), true));
    await new Promise((r) => setTimeout(r, 150));
    expect(chats).toEqual(['register hunter2 hunter2', 'time set day']);
    // handshake, login start, then the passed command and the movement; not the /register
    expect(fromClient).toEqual([0, 0, 4, 0x14]);
    client.destroy();
    serverSocket?.destroy();
    proxy.close();
    await new Promise<void>((r) => backend.close(() => r()));
  });
});
