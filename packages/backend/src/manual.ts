// Files only their website may hand out (CurseForge mods whose authors turned off third-party
// downloads). The user opens the download page, the browser saves the file into Downloads, and
// srvMC picks it up there: same size and hash as the file it waits for, then into the cache.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ManualDownload } from '@srvmc/shared';
import { cacheDirFor, hashFile } from './download.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';
import { t } from '@srvmc/shared';

export interface ManualFile {
  title: string;
  fileName: string;
  url: string;
  size: number;
  sha1?: string;
  md5?: string;
}

interface Waiting {
  serverId: string;
  item: ManualDownload;
  file: ManualFile;
  deliver: (cached: string) => Promise<void>;
  onCancel?: () => void;
}

const PARTIAL = /\.(crdownload|part|partial|tmp|download)$/i;
const SCAN_MS = 2000;

/** Where the cache keeps a file with this hash, the same place downloadToCache would put it. */
export function cachedPath(paths: Paths, f: ManualFile): string {
  return path.join(cacheDirFor(paths, { url: f.url, fileName: f.fileName, sha1: f.sha1, md5: f.sha1 ? undefined : f.md5 }), f.fileName);
}

export class ManualDownloads extends EventEmitter {
  private readonly waiting = new Map<string, Waiting>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  /** Files already checked and not wanted, by path and size, so big files are hashed once. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly paths: Paths,
    readonly downloadsDir: string,
  ) {
    super();
  }

  list(serverId: string): ManualDownload[] {
    return [...this.waiting.values()].filter((w) => w.serverId === serverId).map((w) => w.item);
  }

  /**
   * Waits for one file: resolves `deliver` with the file in the cache. A file already in the cache
   * (downloaded for another server) is delivered at once.
   */
  async add(serverId: string, file: ManualFile, deliver: (cached: string) => Promise<void>, onCancel?: () => void): Promise<ManualDownload> {
    const item: ManualDownload = { id: randomBytes(6).toString('hex'), title: file.title, fileName: file.fileName, url: file.url, size: file.size, done: false };
    const cached = cachedPath(this.paths, file);
    if ((await stat(cached).catch(() => null))?.size === file.size) {
      await deliver(cached);
      return { ...item, done: true };
    }
    this.waiting.set(item.id, { serverId, item, file, deliver, onCancel });
    this.emit('changed', serverId);
    this.timer ??= setInterval(() => void this.scan(), SCAN_MS);
    return item;
  }

  /** Waits until every file is there (for installs that cannot go on without them). Rejects when the user cancels. */
  async waitAll(serverId: string, files: ManualFile[], deliver: (file: ManualFile, cached: string) => Promise<void>, onChange: (items: ManualDownload[]) => void): Promise<void> {
    const items: ManualDownload[] = [];
    let left = files.length;
    let finish!: () => void;
    let fail!: (err: Error) => void;
    const all = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const report = () => onChange(items.map((i) => ({ ...i })));
    const cancelled = () => {
      this.cancel(serverId);
      fail(new UserError(t('Manual download cancelled.')));
    };
    for (const f of files) {
      const holder: { item?: ManualDownload } = {};
      const item = await this.add(
        serverId,
        f,
        async (cached) => {
          await deliver(f, cached);
          if (holder.item) holder.item.done = true;
          if (--left === 0) finish();
          if (holder.item) report();
        },
        cancelled,
      );
      holder.item = { ...item };
      items.push(holder.item);
    }
    report();
    if (left === 0) finish();
    return all;
  }

  cancel(serverId: string, id?: string): void {
    const gone = [...this.waiting.entries()].filter(([key, w]) => w.serverId === serverId && (!id || key === id));
    for (const [key] of gone) this.waiting.delete(key);
    for (const [, w] of gone) w.onCancel?.();
    this.emit('changed', serverId);
    this.stopIfIdle();
  }

  private stopIfIdle(): void {
    if (this.waiting.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.seen.clear();
    }
  }

  /** Looks through Downloads for files of a waited-for size and checks their hash. */
  async scan(): Promise<void> {
    if (this.scanning || this.waiting.size === 0) return;
    this.scanning = true;
    try {
      const sizes = new Set([...this.waiting.values()].map((w) => w.file.size));
      for (const name of await readdir(this.downloadsDir).catch(() => [] as string[])) {
        if (PARTIAL.test(name)) continue;
        const abs = path.join(this.downloadsDir, name);
        const s = await stat(abs).catch(() => null);
        if (!s?.isFile() || !sizes.has(s.size) || this.seen.get(abs) === s.mtimeMs) continue;
        const match = await this.matchFile(abs, s.size);
        if (!match) {
          this.seen.set(abs, s.mtimeMs);
          continue;
        }
        await this.take(abs, match);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async matchFile(abs: string, size: number): Promise<Waiting | undefined> {
    const candidates = [...this.waiting.values()].filter((w) => w.file.size === size);
    let sha1: string | undefined;
    let md5: string | undefined;
    for (const w of candidates) {
      if (w.file.sha1) {
        sha1 ??= await hashFile(abs, 'sha1').catch(() => '');
        if (sha1 === w.file.sha1.toLowerCase()) return w;
      } else if (w.file.md5) {
        md5 ??= await hashFile(abs, 'md5').catch(() => '');
        if (md5 === w.file.md5.toLowerCase()) return w;
      } else if (path.basename(abs) === w.file.fileName) return w;
    }
    return undefined;
  }

  /** Moves the file into the cache and hands it to everyone waiting for the same file. */
  private async take(abs: string, first: Waiting): Promise<void> {
    const cached = cachedPath(this.paths, first.file);
    await mkdir(path.dirname(cached), { recursive: true });
    await rename(abs, cached).catch(async () => {
      await copyFile(abs, cached);
      await rm(abs, { force: true });
    });
    const same = [...this.waiting.entries()].filter(([, w]) => w.file.size === first.file.size && (w.file.sha1 ?? w.file.md5 ?? w.file.fileName) === (first.file.sha1 ?? first.file.md5 ?? first.file.fileName));
    for (const [key, w] of same) {
      this.waiting.delete(key);
      try {
        await w.deliver(cached);
      } catch {
        // The server may be gone; the file stays in the cache for next time.
      }
      this.emit('changed', w.serverId);
    }
    this.stopIfIdle();
  }
}
