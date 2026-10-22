// Player statistics: play time and sessions counted from the console (old logs read once), plus
// Minecraft's own stats files (deaths, kills, mined blocks, distance) on Java servers.
import { createReadStream } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { editionOf, type PlayerStat } from '@srvmc/shared';
import { JOIN_RE, LEAVE_RE, type ServerInstance } from './instance.ts';
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

// Bump to read the old logs again after the log parsing changes.
const STORE_VERSION = 2;

interface Store {
  version?: number;
  backfilled: boolean;
  players: Record<string, Entry>;
}

// Forge puts a localized date first: "[22říj2026 17:53:12.137]".
const TIME_RE = /^\[(?:[^\]\s]+\s)?(\d{2}):(\d{2}):(\d{2})/;
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
  private readonly backfills = new Map<string, Promise<void>>();

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
        .then((st) => (st.version === STORE_VERSION ? st : { version: STORE_VERSION, backfilled: false, players: {} }))
        .catch(() => ({ version: STORE_VERSION, backfilled: false, players: {} }));
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
    // Old logs first, or a session counted live would be counted again from the log later.
    const s = await this.ready(inst);
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

  private async ready(inst: ServerInstance): Promise<Store> {
    const s = await this.store(inst);
    if (!s.backfilled) {
      let b = this.backfills.get(inst.cfg.id);
      if (!b) {
        b = this.backfill(inst, s);
        this.backfills.set(inst.cfg.id, b);
      }
      await b;
    }
    return s;
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
    const s = await this.ready(inst);
    // Names for UUIDs the logs did not mention.
    const cache = await readFile(path.join(inst.dir, 'usercache.json'), 'utf8').then((t) => JSON.parse(t) as { name: string; uuid: string }[], () => []);
    const game = await this.gameStats(inst);
    const known = new Set(Object.values(s.players).map((e) => e.uuid));
    for (const c of Array.isArray(cache) ? cache : []) {
      if (typeof c?.name !== 'string') continue;
      const e = s.players[c.name.toLowerCase()];
      if (e && !e.uuid) e.uuid = c.uuid;
      // A player with a stats file but no join line in the logs we still have.
      if (!e && game.has(c.uuid) && !known.has(c.uuid)) {
        s.players[c.name.toLowerCase()] = { name: c.name, uuid: c.uuid, firstSeen: 0, lastSeen: 0, playMs: 0, sessions: 0 };
      }
    }
    const open = this.open.get(id) ?? new Map<string, number>();
    const now = Date.now();
    return Object.values(s.players)
      .map((e) => {
        const start = open.get(e.name.toLowerCase());
        const g = e.uuid ? game.get(e.uuid) : undefined;
        // The game counts play time too; it covers sessions from before the logs we have.
        const counted = e.playMs + (start !== undefined ? now - start : 0);
        return {
          name: e.name,
          uuid: e.uuid,
          online: inst.players.has(e.name),
          firstSeen: e.firstSeen,
          lastSeen: start !== undefined ? now : e.lastSeen,
          playMs: Math.max(counted, (g?.playTicks ?? 0) * 50),
          sessions: e.sessions,
          ...(g && { game: g }),
        };
      })
      .sort((a, b) => b.playMs - a.playMs);
  }
}
