import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { DEFAULT_BACKUP_KEEP, type BackupInfo, type BackupKind, type BackupSchedule, type ServerConfig } from '@srvmc/shared';
import { trashPaths } from './files.ts';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/index.ts';
import { collectFiles, writeZip } from './zip.ts';

const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(manual|auto|safety)\.zip$/;

// Everything the server re-creates or re-downloads by itself stays out of backups.
const SKIP_TOP = new Set(['cache', 'libraries', 'versions', 'logs', 'crash-reports', '.paper-remapped', 'bundler']);
const SKIP_ANY = /(^|\/)session\.lock$|(^|\/)\.srvmc\.pid$|\.srvmc-[a-z]+(-\d+)?($|\/)|\.part$/;

export function backupFileName(kind: BackupKind, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${kind}.zip`;
}

export function parseBackupName(name: string): { kind: BackupKind; createdAt: number } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, kind] = m;
  return { kind: kind as BackupKind, createdAt: new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!).getTime() };
}

export function skipInBackup(rel: string): boolean {
  const top = rel.split('/')[0]!;
  return SKIP_TOP.has(top) || SKIP_ANY.test(rel);
}

/** Automatic and safety backups beyond `keep` (newest first) are removed; manual ones stay until deleted by hand. */
export function backupsToRotate(list: BackupInfo[], keep: number): BackupInfo[] {
  return [...list]
    .filter((b) => b.kind !== 'manual')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(Math.max(1, keep));
}

/** Next time an automatic backup is due, strictly after `from`. Weekly backups run on Mondays. */
export function nextBackupTime(schedule: BackupSchedule, time: string, from: Date): Date | null {
  if (schedule === 'off') return null;
  const next = new Date(from);
  next.setSeconds(0, 0);
  if (schedule === 'hourly') {
    next.setMinutes(0);
    next.setHours(next.getHours() + 1);
    return next;
  }
  if (schedule === '6h') {
    next.setMinutes(0);
    next.setHours(Math.floor(next.getHours() / 6) * 6 + 6);
    return next;
  }
  const [h = 4, m = 0] = time.split(':').map(Number);
  next.setHours(h, m, 0, 0);
  if (schedule === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  const daysToMonday = (8 - next.getDay()) % 7;
  next.setDate(next.getDate() + daysToMonday);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    const meta = parseBackupName(file);
    if (!meta) continue;
    const s = await stat(path.join(dir, file)).catch(() => null);
    if (s?.isFile()) out.push({ file, ...meta, size: s.size });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Backups of whole server folders (worlds, plugins, configs) into zips under srvMC/backups/<id>.
 * A running server gets save-off / save-all flush first, so region files don't change while zipping.
 */
export class BackupService {
  private timer?: NodeJS.Timeout;
  private readonly due = new Map<string, number>();

  constructor(
    private readonly manager: ServerManager,
    private readonly paths: Paths,
  ) {}

  dirFor(id: string): string {
    return path.join(this.paths.backups, id);
  }

  fileFor(id: string, file: string): string {
    if (!parseBackupName(file)) throw new UserError('Neplatný název zálohy.');
    return path.join(this.dirFor(id), file);
  }

  list(id: string): Promise<BackupInfo[]> {
    this.manager.get(id);
    return listBackups(this.dirFor(id));
  }

  /**
   * Flushes the world to disk and stops autosaving on a running server. Returns the function that
   * turns saving back on (call it exactly once). A stopped server needs nothing.
   */
  async pauseSaves(inst: ServerInstance): Promise<() => void> {
    if (inst.status !== 'running') return () => undefined;
    inst.sendCommand('save-off');
    const saved = inst.waitForLine(/Saved the game|All dimensions are saved|Saved the world/i, 120_000);
    inst.sendCommand('save-all flush');
    if (!(await saved)) inst.pushLog('warn', 'Server nepotvrdil uložení světa, pokračuji i tak.');
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (inst.running) inst.sendCommand('save-on');
    };
  }

  async withSavesPaused<T>(inst: ServerInstance, fn: () => Promise<T>): Promise<T> {
    const resume = await this.pauseSaves(inst);
    try {
      return await fn();
    } finally {
      resume();
    }
  }

  async create(id: string, kind: BackupKind): Promise<BackupInfo> {
    return this.manager.runTask(id, 'backup', 'Připravuji zálohu', (report) => this.createUnlocked(id, kind, report));
  }

  private async createUnlocked(id: string, kind: BackupKind, report: (pct: number | null, text?: string) => void): Promise<BackupInfo> {
    const inst = this.manager.get(id);
    if (!inst.cfg.installed) throw new UserError('Server ještě není nainstalovaný.');
    const dir = this.dirFor(id);
    await mkdir(dir, { recursive: true });
    const file = backupFileName(kind);
    await this.withSavesPaused(inst, async () => {
      report(null, 'Hledám soubory k zálohování');
      const tops = (await readdir(inst.dir)).filter((n) => !skipInBackup(n));
      const items = await collectFiles(inst.dir, tops, skipInBackup);
      const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
      await writeZip(items, path.join(dir, file), (done, total) => report(total ? Math.round((done / total) * 100) : null, `Zálohuji · ${mb(done)} z ${mb(total)} MB`));
    });
    const s = await stat(path.join(dir, file));
    inst.pushLog('system', `Záloha hotová: ${file} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
    await this.rotate(inst.cfg);
    return { file, kind, createdAt: parseBackupName(file)!.createdAt, size: s.size };
  }

  async rotate(cfg: ServerConfig): Promise<void> {
    const extra = backupsToRotate(await listBackups(this.dirFor(cfg.id)), cfg.backupKeep ?? DEFAULT_BACKUP_KEEP);
    for (const b of extra) await rm(path.join(this.dirFor(cfg.id), b.file), { force: true });
  }

  async remove(id: string, file: string): Promise<void> {
    this.manager.get(id);
    await rm(this.fileFor(id, file), { force: true });
  }

  /**
   * Restores a backup onto a stopped server. A safety backup of the current state comes first;
   * every top-level item the backup contains is moved to the trash and replaced.
   */
  async restore(id: string, file: string): Promise<void> {
    const inst = this.manager.get(id);
    if (inst.running) throw new UserError('Nejdřív server zastav.');
    const zip = this.fileFor(id, file);
    if (!(await stat(zip).catch(() => null))) throw new UserError('Záloha neexistuje.');

    await this.manager.runTask(id, 'restore', 'Zálohuji současný stav', async (report) => {
      await this.createUnlocked(id, 'safety', (pct, text) => report(pct, text && `Pojistná záloha · ${text}`));
      const tmp = path.join(inst.dir, `.srvmc-restore-${Date.now()}`);
      await mkdir(tmp, { recursive: true });
      try {
        let seen = 0;
        await extractZip(zip, {
          dir: tmp,
          onEntry: (_e, z) => {
            seen++;
            if (seen % 50 === 0) report(Math.round((seen / Math.max(1, z.entryCount)) * 100), 'Rozbaluji zálohu');
          },
        });
        const tops = await readdir(tmp);
        report(null, 'Vracím soubory na místo');
        await trashPaths(inst.dir, tops.filter((t) => t !== path.basename(tmp)), path.join(this.paths.trash, id));
        for (const t of tops) await rename(path.join(tmp, t), path.join(inst.dir, t));
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      inst.pushLog('system', `Obnoveno ze zálohy ${file}.`);
    });
  }

  // ---- schedule ----

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  nextRun(cfg: ServerConfig): number | null {
    if (!cfg.backupSchedule || cfg.backupSchedule === 'off') {
      this.due.delete(cfg.id);
      return null;
    }
    const key = `${cfg.backupSchedule}|${cfg.backupTime ?? '04:00'}`;
    const cached = this.due.get(`${cfg.id}|${key}`);
    if (cached) return cached;
    const t = nextBackupTime(cfg.backupSchedule, cfg.backupTime ?? '04:00', new Date())!.getTime();
    for (const k of this.due.keys()) if (k.startsWith(`${cfg.id}|`)) this.due.delete(k);
    this.due.set(`${cfg.id}|${key}`, t);
    return t;
  }

  private async tick(): Promise<void> {
    for (const server of this.manager.list()) {
      const due = this.nextRun(server);
      if (!due || Date.now() < due) continue;
      for (const k of this.due.keys()) if (k.startsWith(`${server.id}|`)) this.due.delete(k);
      // A server that never ran has nothing new to back up.
      if (!server.installed || server.task) continue;
      try {
        await this.create(server.id, 'auto');
      } catch (err) {
        this.manager.get(server.id).pushLog('error', `Automatická záloha selhala: ${(err as Error).message}`);
      }
    }
  }
}
