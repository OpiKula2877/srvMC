// Bedrock players: allowlist.json (names), permissions.json (operators by XUID). Bedrock has no ban
// lists. XUIDs come from the server log when players join, else from public Xbox lookups.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GAMERTAG_RE, type AddPlayerRequest, type PlayerEntry, type PlayerListKind, type PlayersInfo } from '@srvmc/shared';
import { fetchJson } from './http.ts';
import type { ServerInstance } from './instance.ts';
import { readServerProperties, updateServerProperties } from './properties.ts';
import { UserError } from './providers/types.ts';

const XUID_FILE = '.srvmc-xuids.json';

type Raw = Record<string, unknown>;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFile(`${file}.srvmc-tmp`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(`${file}.srvmc-tmp`, file);
}

const allowFile = (dir: string) => path.join(dir, 'allowlist.json');
const permFile = (dir: string) => path.join(dir, 'permissions.json');

/** name (lower case) → { name, xuid } of everyone seen joining or looked up. */
async function knownXuids(dir: string): Promise<Record<string, { name: string; xuid: string }>> {
  return readJson(path.join(dir, XUID_FILE), {});
}

export async function rememberXuid(dir: string, name: string, xuid: string): Promise<void> {
  if (!/^\d{1,20}$/.test(xuid)) return;
  const map = await knownXuids(dir);
  if (map[name.toLowerCase()]?.xuid === xuid) return;
  map[name.toLowerCase()] = { name, xuid };
  await writeJson(path.join(dir, XUID_FILE), map);
}

/** Public gamertag → XUID lookups (no Xbox sign-in needed). */
export async function lookupXuid(gamertag: string): Promise<{ name: string; xuid: string } | null> {
  try {
    const res = await fetchJson<{ success: boolean; data?: { player?: { id?: string; username?: string } } }>(`https://playerdb.co/api/player/xbox/${encodeURIComponent(gamertag)}`, { timeoutMs: 10_000 });
    const p = res.data?.player;
    if (res.success && p?.id && /^\d+$/.test(p.id)) return { name: p.username ?? gamertag, xuid: p.id };
  } catch {
    // try the next service
  }
  try {
    const res = await fetchJson<{ xuid?: number | string }>(`https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(gamertag)}`, { timeoutMs: 10_000 });
    if (res.xuid) return { name: gamertag, xuid: String(res.xuid) };
  } catch {
    // unknown gamertag or service down
  }
  return null;
}

function checkName(name: string): void {
  if (!GAMERTAG_RE.test(name)) throw new UserError('Zadej Xbox jméno (gamertag) – písmena, číslice a mezery.');
}

/** Gamertags may contain spaces; console commands need them quoted. */
export const quoted = (name: string) => (name.includes(' ') ? `"${name}"` : name);

function onlyAllowAndOps(kind: PlayerListKind): void {
  if (kind === 'bans' || kind === 'ips') throw new UserError('Bedrock server zákazy nemá. Zapni povolený seznam hráčů a přidávej jen ty, kdo smí hrát.');
}

export async function bedrockPlayersInfo(inst: ServerInstance): Promise<PlayersInfo> {
  const [allow, perms, xuids, props] = await Promise.all([
    readJson<Raw[]>(allowFile(inst.dir), []),
    readJson<Raw[]>(permFile(inst.dir), []),
    knownXuids(inst.dir),
    readServerProperties(inst.dir),
  ]);
  const byXuid = new Map(Object.values(xuids).map((v) => [v.xuid, v.name]));
  const whitelist: PlayerEntry[] = (Array.isArray(allow) ? allow : []).map((r) => ({ name: String(r.name ?? '?'), uuid: typeof r.xuid === 'string' && r.xuid ? r.xuid : undefined }));
  const ops: PlayerEntry[] = (Array.isArray(perms) ? perms : [])
    .filter((r) => r.permission === 'operator' && typeof r.xuid === 'string')
    .map((r) => ({ name: byXuid.get(r.xuid as string) ?? (r.xuid as string), uuid: r.xuid as string }));
  return {
    whitelist,
    ops,
    bans: [],
    ips: [],
    whitelistEnabled: props.values.get('allow-list') === 'true',
    onlineMode: (props.values.get('online-mode') ?? 'true') !== 'false',
    online: [...inst.players],
    edition: 'bedrock',
  };
}

function reload(inst: ServerInstance, command: string): void {
  if (inst.running) inst.sendCommand(command);
}

export async function bedrockAddPlayer(inst: ServerInstance, kind: PlayerListKind, req: AddPlayerRequest): Promise<void> {
  onlyAllowAndOps(kind);
  const name = req.name.trim();
  checkName(name);
  const known = (await knownXuids(inst.dir))[name.toLowerCase()];
  if (kind === 'whitelist') {
    const list = await readJson<Raw[]>(allowFile(inst.dir), []);
    if (list.some((r) => String(r.name).toLowerCase() === name.toLowerCase())) throw new UserError(`${name} už v seznamu je.`);
    list.push({ ignoresPlayerLimit: false, name: known?.name ?? name, ...(known && { xuid: known.xuid }) });
    await writeJson(allowFile(inst.dir), list);
    reload(inst, 'allowlist reload');
    return;
  }
  const found = known ?? (await lookupXuid(name));
  if (!found) throw new UserError(`XUID hráče „${name}“ nejde zjistit. Ať se jednou připojí na server, pak ho přidej.`);
  await rememberXuid(inst.dir, found.name, found.xuid);
  const perms = await readJson<Raw[]>(permFile(inst.dir), []);
  const rest = perms.filter((r) => r.xuid !== found.xuid);
  if (rest.length !== perms.length && perms.some((r) => r.xuid === found.xuid && r.permission === 'operator')) throw new UserError(`${name} už operátor je.`);
  rest.push({ permission: 'operator', xuid: found.xuid });
  await writeJson(permFile(inst.dir), rest);
  reload(inst, 'permission reload');
}

export async function bedrockRemovePlayer(inst: ServerInstance, kind: PlayerListKind, key: string): Promise<void> {
  onlyAllowAndOps(kind);
  const name = key.trim();
  if (kind === 'whitelist') {
    const list = await readJson<Raw[]>(allowFile(inst.dir), []);
    const next = list.filter((r) => String(r.name).toLowerCase() !== name.toLowerCase());
    if (next.length === list.length) throw new UserError(`${name} v seznamu není.`);
    await writeJson(allowFile(inst.dir), next);
    reload(inst, 'allowlist reload');
    return;
  }
  // Operators are shown by name when srvMC knows it, else by XUID; accept both.
  const xuid = /^\d+$/.test(name) ? name : (await knownXuids(inst.dir))[name.toLowerCase()]?.xuid;
  const perms = await readJson<Raw[]>(permFile(inst.dir), []);
  const next = perms.filter((r) => !(r.xuid === xuid && r.permission === 'operator'));
  if (!xuid || next.length === perms.length) throw new UserError(`${name} operátor není.`);
  await writeJson(permFile(inst.dir), next);
  reload(inst, 'permission reload');
}

export async function bedrockSetAllowList(inst: ServerInstance, enabled: boolean): Promise<void> {
  await updateServerProperties(inst.dir, { 'allow-list': String(enabled) });
  reload(inst, `allowlist ${enabled ? 'on' : 'off'}`);
}

export function bedrockKick(inst: ServerInstance, name: string, reason?: string): void {
  checkName(name);
  const why = (reason ?? '').replace(/[\r\n"]+/g, ' ').trim().slice(0, 200);
  inst.sendCommand(`kick ${quoted(name)}${why ? ` ${why}` : ''}`);
}
