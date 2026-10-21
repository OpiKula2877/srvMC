import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheDirFor, downloadToCache } from '../src/download.ts';
import { makePaths, type Paths } from '../src/paths.ts';

const body = Buffer.from('server jar bytes '.repeat(1000));
const sha1 = createHash('sha1').update(body).digest('hex');

let server: Server;
let base: string;
let hits = 0;
let paths: Paths;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  paths = makePaths(await mkdtemp(path.join(os.tmpdir(), 'srvmc-test-')));
});

afterAll(async () => {
  server.close();
  await rm(paths.root, { recursive: true, force: true });
});

describe('download cache', () => {
  it('downloads, verifies the hash and reuses the cached copy', async () => {
    const spec = { url: `${base}/server.jar`, fileName: 'server.jar', sha1 };
    const progress: number[] = [];
    const file = await downloadToCache(paths, spec, (done) => progress.push(done));
    expect(await readFile(file)).toEqual(body);
    expect(progress.at(-1)).toBe(body.length);

    const again = await downloadToCache(paths, spec);
    expect(again).toBe(file);
    expect(hits).toBe(1);
  });

  it('replaces a corrupted cached file', async () => {
    const spec = { url: `${base}/server.jar`, fileName: 'server.jar', sha1 };
    await writeFile(path.join(cacheDirFor(paths, spec), 'server.jar'), 'broken');
    const before = hits;
    const file = await downloadToCache(paths, spec);
    expect(await readFile(file)).toEqual(body);
    expect(hits).toBe(before + 1);
  });

  it('rejects a download whose hash does not match', async () => {
    const spec = { url: `${base}/other.jar`, fileName: 'other.jar', sha1: '0'.repeat(40) };
    await expect(downloadToCache(paths, spec)).rejects.toThrow(/Checksum mismatch/);
  });

  it('refuses file names that would leave the cache folder', async () => {
    await expect(downloadToCache(paths, { url: `${base}/x`, fileName: '../evil.jar' })).rejects.toThrow(/Invalid file name/);
  });
});
