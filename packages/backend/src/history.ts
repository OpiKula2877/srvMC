// Load history on disk: one JSON line per server and minute (average CPU, peak RAM and players,
// lowest TPS) in metrics/<id>/<date>.jsonl, kept for a month.
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryPoint, HistoryRange, MetricPoint } from '@srvmc/shared';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KEEP_DAYS = 31;

export const RANGES: Record<HistoryRange, { span: number; bucket: number }> = {
  '1h': { span: 60 * MINUTE, bucket: MINUTE },
  '24h': { span: DAY, bucket: 5 * MINUTE },
  '7d': { span: 7 * DAY, bucket: 30 * MINUTE },
  '30d': { span: 30 * DAY, bucket: 2 * 60 * MINUTE },
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Local-date file name, so a day's file holds that calendar day as the user sees it. */
export function dayFile(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

interface Bucket {
  t: number;
  cpuSum: number;
  n: number;
  memMb: number;
  players: number;
  tps: number | null;
}

function add(b: Bucket, cpu: number, memMb: number, players: number, tps: number | null | undefined): void {
  b.cpuSum += cpu;
  b.n++;
  b.memMb = Math.max(b.memMb, memMb);
  b.players = Math.max(b.players, players);
  if (tps != null) b.tps = b.tps === null ? tps : Math.min(b.tps, tps);
}

function finish(b: Bucket): HistoryPoint {
  return { t: b.t, cpu: round1(b.cpuSum / b.n), memMb: Math.round(b.memMb), players: b.players, tps: b.tps === null ? null : round1(b.tps) };
}

/** Folds points into buckets of `size` ms: average CPU, peak RAM and players, lowest TPS. Input must be sorted. */
export function bucketize(points: HistoryPoint[], size: number): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  let cur: Bucket | null = null;
  for (const p of points) {
    const t = Math.floor(p.t / size) * size;
    if (!cur || cur.t !== t) {
      if (cur) out.push(finish(cur));
      cur = { t, cpuSum: 0, n: 0, memMb: 0, players: 0, tps: null };
    }
    add(cur, p.cpu, p.memMb, p.players, p.tps);
  }
  if (cur) out.push(finish(cur));
  return out;
}

export function parseLines(text: string): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const p = JSON.parse(line) as HistoryPoint;
      if (Number.isFinite(p.t) && Number.isFinite(p.cpu) && Number.isFinite(p.memMb)) out.push({ t: p.t, cpu: p.cpu, memMb: p.memMb, players: p.players ?? 0, tps: p.tps ?? null });
    } catch {
      // A line cut short by a crash; skip it.
    }
  }
  return out;
}

export class MetricHistory {
  private readonly open = new Map<string, Bucket>();
  private lastPurge = 0;

  constructor(private readonly dir: string) {}

  /** Adds a live sample (every few seconds); finished minutes are appended to disk. */
  record(id: string, point: MetricPoint): void {
    const minute = Math.floor(point.t / MINUTE) * MINUTE;
    let b = this.open.get(id);
    if (b && b.t !== minute) {
      void this.write(id, b);
      b = undefined;
    }
    if (!b) {
      b = { t: minute, cpuSum: 0, n: 0, memMb: 0, players: 0, tps: null };
      this.open.set(id, b);
    }
    add(b, point.cpu, point.memMb, point.players ?? 0, point.tps);
  }

  /** Writes the unfinished minute, e.g. when the server stops. */
  async flush(id: string): Promise<void> {
    const b = this.open.get(id);
    if (!b) return;
    this.open.delete(id);
    await this.write(id, b);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.flush(id)));
  }

  private async write(id: string, b: Bucket): Promise<void> {
    const dir = path.join(this.dir, id);
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, dayFile(b.t)), `${JSON.stringify(finish(b))}\n`, 'utf8');
    } catch {
      // History is best effort; the live graph keeps working.
    }
    if (Date.now() - this.lastPurge > 6 * 60 * MINUTE) void this.purge();
  }

  async query(id: string, range: HistoryRange, now = Date.now()): Promise<HistoryPoint[]> {
    const { span, bucket } = RANGES[range];
    const from = now - span;
    const files: string[] = [];
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= now) {
      files.push(dayFile(d.getTime()));
      d.setDate(d.getDate() + 1);
    }
    const points: HistoryPoint[] = [];
    for (const f of files) {
      const text = await readFile(path.join(this.dir, id, f), 'utf8').catch(() => '');
      for (const p of parseLines(text)) if (p.t >= from && p.t <= now) points.push(p);
    }
    const open = this.open.get(id);
    if (open && open.n > 0 && open.t >= from) points.push(finish(open));
    points.sort((a, b) => a.t - b.t);
    return bucket === MINUTE ? points : bucketize(points, bucket);
  }

  /** Drops day files older than a month. */
  async purge(now = Date.now()): Promise<void> {
    this.lastPurge = now;
    const oldest = dayFile(now - KEEP_DAYS * DAY);
    for (const id of await readdir(this.dir).catch(() => [] as string[])) {
      for (const f of await readdir(path.join(this.dir, id)).catch(() => [] as string[])) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f < oldest) await rm(path.join(this.dir, id, f), { force: true });
      }
    }
  }

  async remove(id: string): Promise<void> {
    this.open.delete(id);
    await rm(path.join(this.dir, id), { recursive: true, force: true });
  }
}
