import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type Backend } from '../src/app.ts';
import { makePaths } from '../src/paths.ts';

let root: string;
let web: string;
let backend: Backend;

function get(urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: backend.port, path: urlPath, headers: { host: `127.0.0.1:${backend.port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cache: String(res.headers['cache-control'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'srvmc-app-'));
  web = path.join(root, 'web');
  await mkdir(path.join(web, 'assets'), { recursive: true });
  await writeFile(path.join(web, 'index.html'), '<div id="root"></div>');
  backend = await startBackend({ port: 0, paths: makePaths(path.join(root, 'data')), webDir: web });
});

afterAll(async () => {
  await backend.close();
  await rm(root, { recursive: true, force: true });
});

describe('panel serving', () => {
  it('serves files added after start (a rebuilt panel) and never caches index.html', async () => {
    await writeFile(path.join(web, 'assets', 'index-NEW.js'), 'console.log(1)');
    const js = await get('/assets/index-NEW.js');
    expect(js.status).toBe(200);
    expect(js.type).toMatch(/javascript/);

    const index = await get('/');
    expect(index.body).toContain('id="root"');
    expect(index.cache).toBe('no-store');

    const deep = await get('/server/abc');
    expect(deep.status).toBe(200);
    expect(deep.cache).toBe('no-store');
  });

  it('answers unknown API paths with JSON 404, not the panel', async () => {
    const r = await get('/api/nothing');
    expect(r.status).toBe(404);
    expect(r.type).toMatch(/json/);
  });

  it('rejects a foreign Host header', async () => {
    const r = await get('/api/servers', { host: 'evil.example' });
    expect(r.status).toBe(403);
  });
});
