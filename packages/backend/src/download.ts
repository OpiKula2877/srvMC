import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fetchOk } from './http.ts';
import type { Paths } from './paths.ts';

export interface DownloadSpec {
  url: string;
  fileName: string;
  sha1?: string;
  sha256?: string;
  md5?: string;
  size?: number;
  /** Sent with the request only (an API key); not part of the cache key. */
  headers?: Record<string, string>;
}

export type ProgressFn = (done: number, total: number | null) => void;

type HashAlgo = 'sha1' | 'sha256' | 'md5';

function hashOf(spec: DownloadSpec): { algo: HashAlgo; value: string } | null {
  if (spec.sha256) return { algo: 'sha256', value: spec.sha256.toLowerCase() };
  if (spec.sha1) return { algo: 'sha1', value: spec.sha1.toLowerCase() };
  if (spec.md5) return { algo: 'md5', value: spec.md5.toLowerCase() };
  return null;
}

/** Folder in the cache for one download. Files with a known hash are keyed by it, the rest by URL. */
export function cacheDirFor(paths: Paths, spec: DownloadSpec): string {
  const h = hashOf(spec);
  const key = h ? `${h.algo}-${h.value}` : `url-${createHash('sha256').update(spec.url).digest('hex').slice(0, 32)}`;
  return path.join(paths.cache, key);
}

export async function hashFile(file: string, algo: HashAlgo): Promise<string> {
  const hash = createHash(algo);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Downloads a file into the shared cache (or reuses a cached copy) and returns its path.
 * The hash is checked after every download and on every cache hit.
 */
export async function downloadToCache(paths: Paths, spec: DownloadSpec, onProgress?: ProgressFn): Promise<string> {
  if (spec.fileName.includes('/') || spec.fileName.includes('\\') || spec.fileName.startsWith('.')) {
    throw new Error(`Invalid file name: ${spec.fileName}`);
  }
  const dir = cacheDirFor(paths, spec);
  const file = path.join(dir, spec.fileName);
  const expected = hashOf(spec);

  if (await exists(file)) {
    if (!expected || (await hashFile(file, expected.algo)) === expected.value) {
      const { size } = await stat(file);
      onProgress?.(size, size);
      return file;
    }
    await rm(file, { force: true });
  }

  await mkdir(dir, { recursive: true });
  const part = `${file}.part`;
  const res = await fetchOk(spec.url, { timeoutMs: 30 * 60_000, ...(spec.headers && { headers: spec.headers }) });
  const total = Number(res.headers.get('content-length')) || spec.size || null;
  if (!res.body) throw new Error(`Empty response for ${spec.url}`);

  const hash = expected ? createHash(expected.algo) : null;
  let done = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      hash?.update(chunk);
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        onProgress?.(done, total);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), meter, createWriteStream(part));
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }

  if (hash && expected) {
    const actual = hash.digest('hex');
    if (actual !== expected.value) {
      await rm(part, { force: true });
      throw new Error(`Checksum mismatch for ${spec.fileName}: expected ${expected.value}, got ${actual}`);
    }
  }
  await rename(part, file);
  onProgress?.(done, total ?? done);
  return file;
}
