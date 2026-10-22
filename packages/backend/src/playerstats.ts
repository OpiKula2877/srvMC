// Player statistics: play time and sessions counted from the console (old logs read once), plus
// Minecraft's own stats files (deaths, kills, mined blocks, distance) on Java servers.
import { createReadStream } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { editionOf, type PlayerStat } from '@srvmc/shared';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import { activeWorldName } from './worlds.ts';

const FILE = '.srvmc-players.json';

interface Entry {
  name: string;
  uuid?: string;
  firstSeen: number;
  lastSeen: number;
  playMs: number;
  sessions: number;
}

interface Store {
  backfilled: boolean;
  players: Record<string, Entry>;
}

const TIME_RE = /^\[(\d{2}):(\d{2}):(\d{2})/;
const JOIN_RE = /\]: ([A-Za-z0-9_.]{1,16}) joined the game/;
const LEAVE_RE = /\]: ([A-Za-z0-9_.]{1,16}) left the game/;
const UUID_RE = /UUID of player ([A-Za-z0-9_.]{1,16}) is ([0-9a-f-]{36})/;
const STOP_RE = /Stopping (the )?server/;

function touch(store: Store, name: string, at: number): Entry {
  const key = name.toLowerCase();
  const e = (store.players[key] ??= { name, firstSeen: at, lastSeen: at, playMs: 0, sessions: 0 });
  e.name = name;
  e.firstSeen = Math.min(e.firstSeen, at);
  e.lastSeen = Math.max(e.lastSeen, at);
  return e;
}

/**
 * Folds one day's log into the store. `day` is local midnight of the log's date; lines carry only
 * the time, so a session past midnight wraps to the next day.
 */
export function foldLog(store: Store, lines: string[], day: number): void {
  const open = new Map<string, number>();
  let last = day;
  let prev = -1;
  let offset = 0;
  const close = (name: string, at: number) => {
    const start = open.get(name.toLowerCase());
    if (start === undefined) return;
    open.delete(name.toLowerCase());
    const e = touch(store, name, at);
    e.playMs += Math.max(0, at - start);
  };
  for (const line of lines) {
    const t = TIME_RE.exec(line);
    if (!t) continue;
    const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    if (secs < prev) offset += 86_400_000;
    prev = secs;
    const at = day + offset + secs * 1000;
    last = at;
    let m = UUID_RE.exec(line);
    if (m) {
      touch(store, m[1]!, at).uuid = m[2];
      continue;
    }
    m = JOIN_RE.exec(line);
    if (m) {
      close(m[1]!, at);
      open.set(m[1]!.toLowerCase(), at);
      touch(store, m[1]!, at).sessions++;
      continue;
    }
    m = LEAVE_RE.exec(line);
    if (m) {
      close(m[1]!, at);
      continue;
    }
    if (STOP_RE.test(line)) for (const name of [...open.keys()]) close(name, at);
  }
  for (const name of [...open.keys()]) close(store.players[name]?.name ?? name, last);
}

async function readLines(file: string): Promise<string[]> {
  const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const out: string[] = [];
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) out.push(line);
  return out;
}

/** Local midnight of the date in a rotated log name (2026-10-21-2.log.gz). */
export function logDay(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-\d+\.log\.gz$/.exec(name);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

type Game = NonNullable<PlayerStat['game']>;

/** Minecraft's stats file: play time, deaths, kills, mined blocks and distance travelled. */
export function readGameStats(json: unknown): Game {
  const stats = ((json as { stats?: Record<string, Record<string, number>> })?.stats ?? {}) as Record<string, Record<string, number>>;
  const custom = stats['minecraft:custom'] ?? {};
  const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const cm = Object.entries(custom)
    .filter(([k]) => k.endsWith('_one_cm'))
    .reduce((a, [, v]) => a + (Number(v) || 0), 0);
  return {
    playTicks: custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute'],
    deaths: custom['minecraft:deaths'],
    mobKills: custom['minecraft:mob_kills'],
    playerKills: custom['minecraft:player_kills'],
    blocksMined: sum(stats['minecraft:mined']) || undefined,
    distanceKm: cm ? Math.round(cm / 1000) / 100 : undefined,
  };
}

export class PlayerStatsService {
  private readonly open = new Map<string, Map<string, number>>();
  private readonly stores = new Map<string, Promise<Store>>();
  private readonly saving = new Map<string, NodeJS.Timeout>();

  constructor(private readonly manager: ServerManager) {
    for (const inst of manager.all()) this.attach(inst);
    manager.on('added', (inst: ServerInstance) => this.attach(inst));
  }

  private attach(inst: ServerInstance): void {
    const id = inst.cfg.id;
    inst.on('player', (what: 'join' | 'leave', name: string) => void this.onPlayer(inst, what, name));
    inst.on('exit', () => {
      for (const name of [...(this.open.get(id)?.keys() ?? [])]) void this.onPlayer(inst, 'leave', name);
    });
  }

  private store(inst: ServerInstance): Promise<Store> {
    const id = inst.cfg.id;
    let s = this.stores.get(id);
    if (!s) {
      s = readFile(path.join(inst.dir, FILE), 'utf8')
        .then((t) => JSON.parse(t) as Store)
        .catch(() => ({ backfilled: false, players: {} }));
      this.stores.set(id, s);
    }
    return s;
  }

  private scheduleSave(inst: ServerInstance): void {
    const id = inst.cfg.id;
    clearTimeout(this.saving.get(id));
    this.saving.set(
      id,
      setTimeout(() => {
        this.saving.delete(id);
        void this.store(inst).then(async (s) => {
          const file = path.join(inst.dir, FILE);
          await writeFile(`${file}.tmp`, JSON.stringify(s), 'utf8');
          await rename(`${file}.tmp`, file);
        });
      }, 2000),
    );
  }

  private async onPlayer(inst: ServerInstance, what: 'join' | 'leave', name: string): Promise<void> {
    const id = inst.cfg.id;
    const now = Date.now();
    const s = await this.store(inst);
    const open = this.open.get(id) ?? new Map<string, number>();
    this.open.set(id, open);
    const key = name.toLowerCase();
    const e = touch(s, name, now);
    if (what === 'join') {
      open.set(key, now);
      e.sessions++;
    } else {
      const start = open.get(key);
      open.delete(key);
      if (start !== undefined) e.playMs += now - start;
    }
    this.scheduleSave(inst);
  }

  /** Reads old logs once, so a server shows its history from before srvMC counted. */
  private async backfill(inst: ServerInstance, s: Store): Promise<void> {
    s.backfilled = true;
    if (editionOf(inst.cfg.type) !== 'java') return;
    const logs = path.join(inst.dir, 'logs');
    const names = (await readdir(logs).catch(() => [] as string[])).filter((n) => logDay(n) !== null).sort();
    for (const n of names) foldLog(s, await readLines(path.join(logs, n)), logDay(n)!);
    if (!inst.running) {
      const latest = path.join(logs, 'latest.log');
      const st = await stat(latest).catch(() => null);
      if (st) {
        const d = new Date(st.mtimeMs);
        d.setHours(0, 0, 0, 0);
        foldLog(s, await readLines(latest), d.getTime());
      }
    }
    this.scheduleSave(inst);
  }

  private async gameStats(inst: ServerInstance): Promise<Map<string, Game>> {
    const out = new Map<string, Game>();
    if (editionOf(inst.cfg.type) !== 'java') return out;
    const world = path.join(inst.dir, await activeWorldName(inst.dir));
    for (const dir of [path.join(world, 'players', 'stats'), path.join(world, 'stats')]) {
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const uuid = /^([0-9a-f-]{36})\.json$/.exec(f)?.[1];
        if (!uuid || out.has(uuid)) continue;
        const json = await readFile(path.join(dir, f), 'utf8').then(JSON.parse, () => null);
        if (json) out.set(uuid, readGameStats(json));
      }
    }
    return out;
  }

  async list(id: string): Promise<PlayerStat[]> {
    const inst = this.manager.get(id);
    const s = await this.store(inst);
    if (!s.backfilled) await this.backfill(inst, s);
    // Names for UUIDs the logs did not mention.
    const cache = await readFile(path.join(inst.dir, 'usercache.json'), 'utf8').then((t) => JSON.parse(t) as { name: string; uuid: string }[], () => []);
    for (const c of Array.isArray(cache) ? cache : []) {
      const e = s.players[c.name.toLowerCase()];
      if (e && !e.uuid) e.uuid = c.uuid;
    }
    const game = await this.gameStats(inst);
    const open = this.open.get(id) ?? new Map<string, number>();
    const now = Date.now();
    return Object.values(s.players)
      .map((e) => {
        const start = open.get(e.name.toLowerCase());
        return {
          name: e.name,
          uuid: e.uuid,
          online: inst.players.has(e.name),
          firstSeen: e.firstSeen,
          lastSeen: start !== undefined ? now : e.lastSeen,
          playMs: e.playMs + (start !== undefined ? now - start : 0),
          sessions: e.sessions,
          ...(e.uuid && game.has(e.uuid) && { game: game.get(e.uuid) }),
        };
      })
      .sort((a, b) => b.playMs - a.playMs);
  }
}
