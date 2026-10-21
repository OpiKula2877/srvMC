import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

export interface ZipItem {
  abs: string;
  /** Path inside the zip, with forward slashes. */
  rel: string;
  size: number;
  mtime: Date;
}

// Region files, NBT data and jars are already compressed; storing them is much faster and barely bigger.
const STORE_RE = /\.(mca|mcc|mcr|dat|dat_old|png|jpe?g|jar|zip|gz|ogg)$/i;

/** Walks folders (or files) under `root`, skipping anything `skip` rejects. Symlinks are never followed. */
export async function collectFiles(root: string, relPaths: string[], skip: (rel: string) => boolean = () => false): Promise<ZipItem[]> {
  const out: ZipItem[] = [];
  const stack = [...relPaths];
  while (stack.length) {
    const rel = stack.pop()!;
    if (skip(rel)) continue;
    const abs = path.join(root, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const name of await readdir(abs)) stack.push(rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) {
      out.push({ abs, rel, size: st.size, mtime: st.mtime });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Opens the file only when the zip writer gets to it, so thousands of entries don't exhaust file handles. */
class LazyFile extends Readable {
  private src?: ReadStream;
  constructor(
    private readonly file: string,
    private readonly onBytes: (n: number) => void,
  ) {
    super();
  }
  override _read(): void {
    if (this.src) {
      this.src.resume();
      return;
    }
    this.src = createReadStream(this.file);
    this.src.on('data', (chunk) => {
      this.onBytes(chunk.length);
      if (!this.push(chunk)) this.src!.pause();
    });
    this.src.on('end', () => this.push(null));
    this.src.on('error', (err) => this.destroy(err));
  }
  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    this.src?.destroy();
    cb(err);
  }
}

export function zipStream(items: ZipItem[], onBytes: (n: number) => void = () => undefined): Readable {
  const zip = new yazl.ZipFile();
  for (const it of items) {
    zip.addReadStream(new LazyFile(it.abs, onBytes), it.rel, { mtime: it.mtime, compress: !STORE_RE.test(it.rel), size: it.size });
  }
  zip.end();
  return zip.outputStream as Readable;
}

export async function writeZip(items: ZipItem[], outFile: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const total = items.reduce((n, i) => n + i.size, 0);
  let done = 0;
  let last = 0;
  const tmp = `${outFile}.part`;
  try {
    await pipeline(
      zipStream(items, (n) => {
        done += n;
        const now = Date.now();
        if (now - last > 300) {
          last = now;
          onProgress?.(done, total);
        }
      }),
      createWriteStream(tmp),
    );
    await rename(tmp, outFile);
    onProgress?.(total, total);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
