// CurseForge: mods, Bukkit plugins and modpacks through the official API (api.curseforge.com).
// The API needs a key from console.curseforge.com; the user saves theirs in the panel, sealed like
// the other secrets. Files whose authors turned off third-party downloads have no download URL:
// srvMC sends the user to the file's page and picks the file up from Downloads.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentHit, ContentKind, InstallResult, ManualDownload, ModpackHit, ModpackVersion } from '@srvmc/shared';
import { downloadToCache } from './download.ts';
import { HttpError, fetchJson } from './http.ts';
import type { ManualDownloads, ManualFile } from './manual.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';
import { seal, unseal, type SecretBox } from './secrets.ts';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT = 432;
export const CLASS = { plugin: 5, mod: 6, modpack: 4471 } as const;
/** CurseForge's modLoaderType numbers. */
export const LOADER_TYPE: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const CLASS_SLUG: Record<number, string> = { 5: 'bukkit-plugins', 6: 'mc-mods', 4471: 'modpacks' };
const SAFE_NAME = /^[A-Za-z0-9][\w.+()\[\]' -]*\.(jar|zip)$/i;

// ---- the key ----

let keyFile = '';
let box: SecretBox | undefined;
let key: string | null = null;

export async function loadCurseForgeKey(paths: Paths, secretBox: SecretBox | undefined): Promise<void> {
  keyFile = path.join(paths.root, 'curseforge.json');
  box = secretBox;
  // A key in the environment (for development and tests) wins over the saved one.
  key = process.env.SRVMC_CURSEFORGE_KEY || null;
  if (key) return;
  try {
    key = unseal(box, (JSON.parse(await readFile(keyFile, 'utf8')) as { key?: string }).key);
  } catch {
    key = null;
  }
}

export const curseForgeKeySet = () => !!key;

/** Checks the key with CurseForge before it is kept. */
export async function saveCurseForgeKey(value: string | null): Promise<void> {
  if (value) {
    const trimmed = value.trim();
    if (!/^[\x21-\x7e]{20,200}$/.test(trimmed)) throw new UserError('Tohle nevypadá jako API klíč CurseForge.');
    try {
      await fetchJson(`${API}/games/${MINECRAFT}`, { headers: { 'x-api-key': trimmed, accept: 'application/json' } });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new UserError('CurseForge klíč odmítl. Zkopíruj ho znovu z console.curseforge.com.');
      throw new UserError('CurseForge teď neodpovídá, zkus to za chvíli.');
    }
    key = trimmed;
  } else key = null;
  await writeFile(keyFile, JSON.stringify(key ? { key: seal(box, key) } : {}, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function cf<T>(urlPath: string, init?: RequestInit): Promise<T> {
  if (!key) throw new UserError('Pro CurseForge je potřeba API klíč – vlož ho v záložce Mody a pluginy.');
  try {
    const res = await fetchJson<{ data: T }>(`${API}${urlPath}`, { ...init, headers: { 'x-api-key': key, accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
    return res.data;
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) throw new UserError('CurseForge odmítl API klíč (neplatný, nebo vyčerpaný limit). Zkus to za chvíli nebo vlož nový.');
    if (err instanceof HttpError && err.status === 404) throw new UserError('Na CurseForge to nebylo nalezeno.');
    throw err;
  }
}

// ---- API shapes ----

export interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  classId?: number;
  logo?: { thumbnailUrl?: string; url?: string } | null;
  links?: { websiteUrl?: string };
  authors?: { name: string }[];
  allowModDistribution?: boolean | null;
  latestFilesIndexes?: { gameVersion: string; fileId: number; modLoader?: number | null; releaseType: number }[];
}

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: number;
  fileDate: string;
  fileLength: number;
  downloadUrl: string | null;
  gameVersions: string[];
  hashes: { value: string; algo: number }[];
  dependencies: { modId: number; relationType: number }[];
  isServerPack?: boolean;
  serverPackFileId?: number | null;
  isAvailable?: boolean;
}

export const cfSha1 = (f: CfFile) => f.hashes.find((h) => h.algo === 1)?.value;
export const cfMd5 = (f: CfFile) => f.hashes.find((h) => h.algo === 2)?.value;

/** The page with the download button for one file. */
export function cfFilePage(mod: Pick<CfMod, 'slug' | 'classId' | 'links'>, fileId: number): string {
  const base = mod.links?.websiteUrl?.replace(/\/$/, '') ?? `https://www.curseforge.com/minecraft/${CLASS_SLUG[mod.classId ?? CLASS.mod] ?? 'mc-mods'}/${mod.slug}`;
  return `${base}/download/${fileId}`;
}

/**
 * CurseForge's own download URLs follow the file id; mods whose authors forbid third-party
 * downloads come without one, and those must be fetched by the user.
 */
export function cfDownloadUrl(f: CfFile): string | null {
  return f.downloadUrl && /^https:\/\//.test(f.downloadUrl) ? f.downloadUrl : null;
}

/** Marked for the game client only (CurseForge's "Client" environment tag without "Server"). */
export function cfClientOnly(f: CfFile): boolean {
  return f.gameVersions.includes('Client') && !f.gameVersions.includes('Server');
}

/** A file name safe to write: plain characters, starting with a letter or digit, ending .jar or .zip. */
export function cfFileName(f: CfFile): string {
  const clean = f.fileName.replace(/[^\w.+()\[\]' -]/g, '_');
  return SAFE_NAME.test(clean) ? clean : `curseforge-${f.id}${/\.zip$/i.test(f.fileName) ? '.zip' : '.jar'}`;
}

export function getMod(id: number): Promise<CfMod> {
  return cf<CfMod>(`/mods/${id}`);
}

export function getMods(ids: number[]): Promise<CfMod[]> {
  if (!ids.length) return Promise.resolve([]);
  return cf<CfMod[]>('/mods', { method: 'POST', body: JSON.stringify({ modIds: ids }) });
}

export function getFile(modId: number, fileId: number): Promise<CfFile> {
  return cf<CfFile>(`/mods/${modId}/files/${fileId}`);
}

export async function getFiles(ids: number[]): Promise<CfFile[]> {
  const out: CfFile[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await cf<CfFile[]>('/mods/files', { method: 'POST', body: JSON.stringify({ fileIds: ids.slice(i, i + 500) }) })));
  return out;
}

export async function modFiles(modId: number, gameVersion?: string, loader?: number): Promise<CfFile[]> {
  const q = new URLSearchParams({ pageSize: '50' });
  if (gameVersion) q.set('gameVersion', gameVersion);
  if (loader) q.set('modLoaderType', String(loader));
  return cf<CfFile[]>(`/mods/${modId}/files?${q}`);
}

// ---- search ----

function hit(m: CfMod, source: 'curseforge'): ContentHit {
  return {
    source,
    id: String(m.id),
    title: m.name,
    author: m.authors?.[0]?.name ?? '',
    description: m.summary,
    downloads: m.downloadCount,
    iconUrl: m.logo?.thumbnailUrl ?? m.logo?.url,
    url: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/${CLASS_SLUG[m.classId ?? CLASS.mod]}/${m.slug}`,
    installable: true,
    ...(m.allowModDistribution === false && { manual: true }),
  };
}

async function search(classId: number, query: string, offset: number, gameVersion?: string, loader?: number): Promise<CfMod[]> {
  const q = new URLSearchParams({ gameId: String(MINECRAFT), classId: String(classId), index: String(offset), pageSize: '20', sortOrder: 'desc', sortField: query ? '2' : '6' });
  if (query) q.set('searchFilter', query);
  if (gameVersion) q.set('gameVersion', gameVersion);
  if (loader) q.set('modLoaderType', String(loader));
  return cf<CfMod[]>(`/mods/search?${q}`);
}

export async function searchCurseForge(query: string, kind: ContentKind, loaders: string[], gameVersion: string, offset: number): Promise<ContentHit[]> {
  const loader = kind === 'mod' ? LOADER_TYPE[loaders[0]!] : undefined;
  return (await search(kind === 'plugin' ? CLASS.plugin : CLASS.mod, query, offset, gameVersion, loader)).map((m) => hit(m, 'curseforge'));
}

export async function searchCurseForgePacks(query: string, offset: number): Promise<ModpackHit[]> {
  return (await search(CLASS.modpack, query, offset)).map((m) => ({
    id: `cf:${m.id}`,
    title: m.name,
    author: m.authors?.[0]?.name ?? '',
    description: m.summary,
    downloads: m.downloadCount,
    iconUrl: m.logo?.thumbnailUrl ?? m.logo?.url,
    versions: [...new Set((m.latestFilesIndexes ?? []).map((i) => i.gameVersion))],
  }));
}

const LOADER_NAMES = ['Forge', 'Fabric', 'Quilt', 'NeoForge'];

export async function curseForgePackVersions(modId: number): Promise<ModpackVersion[]> {
  const files = await cf<CfFile[]>(`/mods/${modId}/files?pageSize=50`);
  return files
    .filter((f) => !f.isServerPack)
    .map((f) => ({
      id: String(f.id),
      name: f.displayName,
      versionNumber: f.displayName,
      gameVersions: f.gameVersions.filter((v) => /^\d/.test(v)),
      loaders: f.gameVersions.filter((v) => LOADER_NAMES.includes(v)).map((v) => v.toLowerCase()),
      ...(f.serverPackFileId && { serverPack: true }),
    }));
}

// ---- installing a mod or plugin ----

/** Newest file for the game version and loader: a release if there is one, else beta, else alpha. */
export function pickFile(files: CfFile[], gameVersion: string, loaders: string[]): CfFile | undefined {
  const names = loaders.map((l) => (l === 'neoforge' ? 'NeoForge' : l.charAt(0).toUpperCase() + l.slice(1)));
  const usable = files.filter((f) => f.isAvailable !== false && !f.isServerPack && (!names.length || f.gameVersions.some((v) => names.includes(v)) || !f.gameVersions.some((v) => LOADER_NAMES.includes(v))));
  const newest = (list: CfFile[]) => [...list].sort((a, b) => a.releaseType - b.releaseType || Date.parse(b.fileDate) - Date.parse(a.fileDate))[0];
  const exact = newest(usable.filter((f) => f.gameVersions.includes(gameVersion)));
  if (exact || names.length) return exact;
  // Bukkit plugins often list only the minor line (1.21) or an older one and keep working.
  const minor = gameVersion.split('.').slice(0, 2).join('.');
  return newest(usable.filter((f) => f.gameVersions.some((v) => v === minor || v.startsWith(`${minor}.`)))) ?? newest(usable);
}

export interface CfInstallOptions {
  paths: Paths;
  dir: string;
  serverId: string;
  manual: ManualDownloads;
  /** Mod loaders that fit (empty for plugins). */
  loaders: string[];
  gameVersion: string;
  kind: ContentKind;
  present: Set<string>;
  onInstalled?: (f: { file: string; projectId: string; versionId: string; versionNumber: string; title: string; iconUrl?: string }) => Promise<void>;
}

export function manualFileOf(mod: CfMod, f: CfFile): ManualFile {
  return { title: mod.name, fileName: cfFileName(f), url: cfFilePage(mod, f.id), size: f.fileLength, sha1: cfSha1(f), md5: cfMd5(f) };
}

/** Installs a CurseForge project with its required dependencies. Blocked files wait for the user. */
export async function installCurseForge(modId: number, opts: CfInstallOptions, result: InstallResult = { installed: [], skipped: [], manual: [] }, depth = 0): Promise<InstallResult> {
  const key = `curseforge:${modId}`;
  if (opts.present.has(key)) return result;
  opts.present.add(key);
  const mod = await getMod(modId);
  const loader = opts.kind === 'mod' ? LOADER_TYPE[opts.loaders[0]!] : undefined;
  const files = opts.kind === 'mod' ? await modFiles(modId, opts.gameVersion, loader) : await modFiles(modId);
  const file = pickFile(files, opts.gameVersion, opts.kind === 'mod' ? opts.loaders : []);
  if (!file) {
    if (depth === 0) throw new UserError(`${mod.name} nemá na CurseForge verzi pro ${opts.gameVersion}${opts.kind === 'mod' ? ` (${opts.loaders[0]})` : ''}.`);
    result.skipped.push(`${mod.name} (není verze pro ${opts.gameVersion})`);
    return result;
  }
  if (cfClientOnly(file)) {
    if (depth === 0) throw new UserError(`${mod.name} je jen pro hráče (klienta). Server ho nepotřebuje.`);
    result.skipped.push(`${mod.name} (jen pro klienta)`);
    return result;
  }
  const fileName = cfFileName(file);
  const place = async (cached: string) => {
    await mkdir(opts.dir, { recursive: true });
    await copyFile(cached, path.join(opts.dir, fileName));
    await opts.onInstalled?.({ file: fileName, projectId: String(mod.id), versionId: String(file.id), versionNumber: file.displayName, title: mod.name, iconUrl: mod.logo?.thumbnailUrl });
  };
  const url = cfDownloadUrl(file);
  if (url) {
    await place(await downloadToCache(opts.paths, { url, fileName, sha1: cfSha1(file), size: file.fileLength }));
    result.installed.push(fileName);
  } else {
    const item: ManualDownload = await opts.manual.add(opts.serverId, manualFileOf(mod, file), place);
    if (item.done) result.installed.push(fileName);
    else result.manual!.push(item);
  }
  for (const dep of file.dependencies) if (dep.relationType === 3) await installCurseForge(dep.modId, opts, result, depth + 1);
  return result;
}
