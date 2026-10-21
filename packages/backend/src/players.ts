import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { editionOf, PLAYER_NAME_RE, type AddPlayerRequest, type PlayerEntry, type PlayerListKind, type PlayersInfo } from '@srvmc/shared';
import { bedrockAddPlayer, bedrockKick, bedrockPlayersInfo, bedrockRemovePlayer, bedrockSetAllowList } from './bedrockplayers.ts';
import type { ServerInstance } from './instance.ts';
import { readServerProperties, updateServerProperties } from './properties.ts';
import { UserError } from './providers/index.ts';
import { lookupProfile, offlineUuid } from './uuid.ts';

export const LIST_FILES: Record<PlayerListKind, string> = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  bans: 'banned-players.json',
  ips: 'banned-ips.json',
};

type RawEntry = Record<string, unknown>;

export async function readList(dir: string, kind: PlayerListKind): Promise<RawEntry[]> {
  try {
    const data = JSON.parse(await readFile(path.join(dir, LIST_FILES[kind]), 'utf8')) as unknown;
    return Array.isArray(data) ? (data as RawEntry[]) : [];
  } catch {
    return [];
  }
}

export async function writeList(dir: string, kind: PlayerListKind, list: RawEntry[]): Promise<void> {
  const file = path.join(dir, LIST_FILES[kind]);
  await writeFile(`${file}.srvmc-tmp`, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  await rename(`${file}.srvmc-tmp`, file);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function toEntry(kind: PlayerListKind, raw: RawEntry): PlayerEntry {
  return {
    name: (kind === 'ips' ? str(raw.ip) : str(raw.name)) ?? '?',
    uuid: str(raw.uuid),
    level: typeof raw.level === 'number' ? raw.level : undefined,
    reason: str(raw.reason),
    created: str(raw.created),
    expires: str(raw.expires),
    source: str(raw.source),
  };
}

/** Date format Minecraft uses in ban lists: "2026-10-21 11:46:29 +0200". */
export function mcDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

function keyOf(kind: PlayerListKind, raw: RawEntry): string {
  return String((kind === 'ips' ? raw.ip : raw.name) ?? '').toLowerCase();
}

/** Strips characters that would end a console command early or inject a second one. */
function cleanReason(reason: string | undefined): string {
  return (reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function validate(kind: PlayerListKind, name: string): void {
  if (kind === 'ips') {
    if (!net.isIP(name)) throw new UserError('Zadej platnou IP adresu, např. 203.0.113.7.');
  } else if (!PLAYER_NAME_RE.test(name)) {
    throw new UserError('Jméno hráče smí obsahovat jen písmena, číslice a podtržítko (max 16 znaků).');
  }
}

async function onlineMode(dir: string): Promise<boolean> {
  const { values } = await readServerProperties(dir);
  return (values.get('online-mode') ?? 'true') !== 'false';
}

async function waitForChange(file: string, before: number, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const now = await stat(file).then((s) => s.mtimeMs).catch(() => 0);
    if (now !== before) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function mtime(file: string): Promise<number> {
  return stat(file).then((s) => s.mtimeMs).catch(() => 0);
}

/**
 * Sends a list command to the running server and waits until the list file reflects it.
 * When it does not, the server's own reply ("That player does not exist", …) becomes the error.
 */
async function runListCommand(inst: ServerInstance, kind: PlayerListKind, command: string, name: string, expectPresent: boolean): Promise<void> {
  const file = path.join(inst.dir, LIST_FILES[kind]);
  const before = await mtime(file);
  const sentAt = Date.now();
  inst.sendCommand(command);
  await waitForChange(file, before);
  const present = (await readList(inst.dir, kind)).some((r) => keyOf(kind, r) === name.toLowerCase());
  if (present === expectPresent) return;
  const reply = inst.log
    .filter((l) => l.t >= sentAt && l.level !== 'cmd')
    .map((l) => l.text.replace(/^\[[^\]]*\](?: \[[^\]]*\])*:\s*/, '').replace(/^System chat:\s*/, ''))
    .at(-1);
  throw new UserError(reply ? `Server odpověděl: ${reply}` : 'Server příkaz nepotvrdil.');
}

function isBedrock(inst: ServerInstance): boolean {
  return editionOf(inst.cfg.type) === 'bedrock';
}

function noPlayerLists(inst: ServerInstance): void {
  if (editionOf(inst.cfg.type) === 'hytale') throw new UserError('Hráče na Hytale serveru zatím spravuj příkazy v konzoli.');
}

export async function playersInfo(inst: ServerInstance): Promise<PlayersInfo> {
  if (isBedrock(inst)) return bedrockPlayersInfo(inst);
  const dir = inst.dir;
  const [whitelist, ops, bans, ips, props] = await Promise.all([
    readList(dir, 'whitelist'),
    readList(dir, 'ops'),
    readList(dir, 'bans'),
    readList(dir, 'ips'),
    readServerProperties(dir),
  ]);
  return {
    whitelist: whitelist.map((r) => toEntry('whitelist', r)),
    ops: ops.map((r) => toEntry('ops', r)),
    bans: bans.map((r) => toEntry('bans', r)),
    ips: ips.map((r) => toEntry('ips', r)),
    whitelistEnabled: props.values.get('white-list') === 'true',
    onlineMode: (props.values.get('online-mode') ?? 'true') !== 'false',
    online: [...inst.players],
    edition: editionOf(inst.cfg.type),
  };
}

/**
 * Adds a player to a list. A running server gets the console command (it would overwrite edited
 * files); a stopped one gets its JSON file edited, with the UUID resolved the way the server would.
 */
export async function addPlayer(inst: ServerInstance, kind: PlayerListKind, req: AddPlayerRequest): Promise<void> {
  if (!inst.cfg.installed) throw new UserError('Server ještě není nainstalovaný.');
  noPlayerLists(inst);
  if (isBedrock(inst)) return bedrockAddPlayer(inst, kind, req);
  const name = req.name.trim();
  validate(kind, name);
  const reason = cleanReason(req.reason);
  const list = await readList(inst.dir, kind);
  if (list.some((r) => keyOf(kind, r) === name.toLowerCase())) throw new UserError(`${name} už v seznamu je.`);

  if (inst.running) {
    const cmd = {
      whitelist: `whitelist add ${name}`,
      ops: `op ${name}`,
      bans: `ban ${name}${reason ? ` ${reason}` : ''}`,
      ips: `ban-ip ${name}${reason ? ` ${reason}` : ''}`,
    }[kind];
    await runListCommand(inst, kind, cmd, name, true);
    return;
  }

  if (kind === 'ips') {
    list.push({ ip: name, created: mcDate(), source: 'srvMC', expires: 'forever', reason: reason || 'Banned by an operator.' });
  } else {
    let uuid: string;
    let realName = name;
    if (await onlineMode(inst.dir)) {
      const profile = await lookupProfile(name);
      if (!profile) {
        throw new UserError(`Účet „${name}“ neexistuje. Pro hráče bez placeného Minecraftu vypni v Možnostech ověřování účtů.`);
      }
      uuid = profile.uuid;
      realName = profile.name;
    } else {
      uuid = offlineUuid(name);
    }
    if (kind === 'whitelist') list.push({ uuid, name: realName });
    else if (kind === 'ops') list.push({ uuid, name: realName, level: Math.min(4, Math.max(1, req.level ?? 4)), bypassesPlayerLimit: false });
    else list.push({ uuid, name: realName, created: mcDate(), source: 'srvMC', expires: 'forever', reason: reason || 'Banned by an operator.' });
  }
  await writeList(inst.dir, kind, list);
}

export async function removePlayer(inst: ServerInstance, kind: PlayerListKind, key: string): Promise<void> {
  noPlayerLists(inst);
  if (isBedrock(inst)) return bedrockRemovePlayer(inst, kind, key);
  const name = key.trim();
  validate(kind, name);
  if (!(await readList(inst.dir, kind)).some((r) => keyOf(kind, r) === name.toLowerCase())) throw new UserError(`${name} v seznamu není.`);
  if (inst.running) {
    const cmd = { whitelist: `whitelist remove ${name}`, ops: `deop ${name}`, bans: `pardon ${name}`, ips: `pardon-ip ${name}` }[kind];
    await runListCommand(inst, kind, cmd, name, false);
    return;
  }
  const list = await readList(inst.dir, kind);
  await writeList(
    inst.dir,
    kind,
    list.filter((r) => keyOf(kind, r) !== name.toLowerCase()),
  );
}

export async function setWhitelistEnabled(inst: ServerInstance, enabled: boolean): Promise<void> {
  noPlayerLists(inst);
  if (isBedrock(inst)) return bedrockSetAllowList(inst, enabled);
  if (inst.running) {
    const file = path.join(inst.dir, 'server.properties');
    const before = await mtime(file);
    inst.sendCommand(`whitelist ${enabled ? 'on' : 'off'}`);
    await waitForChange(file, before);
    return;
  }
  await updateServerProperties(inst.dir, { 'white-list': String(enabled) });
}

export function kickPlayer(inst: ServerInstance, name: string, reason?: string): void {
  if (isBedrock(inst)) return bedrockKick(inst, name, reason);
  if (!PLAYER_NAME_RE.test(name)) throw new UserError('Neplatné jméno hráče.');
  const why = cleanReason(reason);
  inst.sendCommand(`kick ${name}${why ? ` ${why}` : ''}`);
}
