// Plugin sources besides Modrinth: Hangar (PaperMC) and SpigotMC through the Spiget API.
import { copyFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { ContentHit, InstallResult } from '@srvmc/shared';
import { downloadToCache } from './download.ts';
import { fetchJson } from './http.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';

const HANGAR = 'https://hangar.papermc.io/api/v1';
const SPIGET = 'https://api.spiget.org/v2';

export interface SimpleInstallOptions {
  paths: Paths;
  dir: string;
  gameVersion: string;
  present: Set<string>;
  onInstalled?: (f: { file: string; projectId: string; versionNumber: string; title: string; iconUrl?: string }) => Promise<void>;
}

/** Turns a plugin title into a safe jar name. */
export function jarName(title: string, version?: string): string {
  const base = `${title}${version ? `-${version}` : ''}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.+-]+/g, '_')
    .replace(/^[._]+|_+$/g, '')
    .slice(0, 80);
  return `${base || 'plugin'}.jar`;
}

async function assertJar(file: string): Promise<void> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(2);
    await fh.read(buf, 0, 2, 0);
    if (buf.toString('latin1') !== 'PK') throw new UserError('Stažený soubor není jar – zdroj nejspíš vrátil webovou stránku.');
  } finally {
    await fh.close();
  }
}

// ---- Hangar ----

interface HangarProject {
  name: string;
  namespace: { owner: string; slug: string };
  description: string;
  stats: { downloads: number };
  avatarUrl?: string;
}

interface HangarVersion {
  name: string;
  downloads: Record<string, { fileInfo: { name: string; sizeBytes: number; sha256Hash: string } | null; externalUrl: string | null; downloadUrl: string | null }>;
  pluginDependencies: Record<string, { name: string; projectId: string | number | null; required: boolean; externalUrl: string | null }[]>;
}

export async function searchHangar(query: string, gameVersion: string, offset: number): Promise<ContentHit[]> {
  const q = new URLSearchParams({ q: query, platform: 'PAPER', version: gameVersion, limit: '20', offset: String(offset), sort: query ? '-stars' : '-downloads' });
  const res = await fetchJson<{ result: HangarProject[] }>(`${HANGAR}/projects?${q}`);
  return res.result.map((p) => ({
    source: 'hangar',
    id: p.namespace.slug,
    title: p.name,
    author: p.namespace.owner,
    description: p.description,
    downloads: p.stats.downloads,
    iconUrl: p.avatarUrl,
    url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
    installable: true,
  }));
}

/** Newest release for the game version; snapshot / beta builds only when there is no release yet. */
async function hangarVersion(slug: string, gameVersion: string): Promise<HangarVersion | undefined> {
  const list = (channel: string) =>
    fetchJson<{ result: HangarVersion[] }>(`${HANGAR}/projects/${encodeURIComponent(slug)}/versions?${channel}platform=PAPER&platformVersion=${encodeURIComponent(gameVersion)}&limit=1`);
  return (await list('channel=Release&')).result[0] ?? (await list('')).result[0];
}

export async function installHangar(slug: string, opts: SimpleInstallOptions, result: InstallResult = { installed: [], skipped: [] }, depth = 0): Promise<InstallResult> {
  const key = `hangar:${slug.toLowerCase()}`;
  if (opts.present.has(key)) return result;
  opts.present.add(key);
  const version = await hangarVersion(slug, opts.gameVersion);
  if (!version) {
    if (depth === 0) throw new UserError(`${slug} na Hangaru nemá verzi pro ${opts.gameVersion}.`);
    result.skipped.push(`${slug} (není verze pro ${opts.gameVersion})`);
    return result;
  }
  const dl = version.downloads.PAPER;
  if (!dl?.downloadUrl || !dl.fileInfo) {
    const where = dl?.externalUrl ? ` Stáhni ho ručně: ${dl.externalUrl}` : '';
    if (depth === 0) throw new UserError(`${slug} se nestahuje z Hangaru, ale z webu autora.${where}`);
    result.skipped.push(`${slug} (jen na webu autora)`);
    return result;
  }
  const fileName = /^[\w.+()\[\] -]+\.jar$/.test(dl.fileInfo.name) ? dl.fileInfo.name : jarName(slug, version.name);
  const cached = await downloadToCache(opts.paths, { url: dl.downloadUrl, fileName, sha256: dl.fileInfo.sha256Hash, size: dl.fileInfo.sizeBytes });
  await mkdir(opts.dir, { recursive: true });
  await copyFile(cached, path.join(opts.dir, fileName));
  result.installed.push(fileName);
  await opts.onInstalled?.({ file: fileName, projectId: slug, versionNumber: version.name, title: slug });

  for (const dep of version.pluginDependencies.PAPER ?? []) {
    if (!dep.required) continue;
    if (dep.projectId) await installHangar(dep.name, opts, result, depth + 1);
    else result.skipped.push(`${dep.name}${dep.externalUrl ? ` (${dep.externalUrl})` : ''}`);
  }
  return result;
}

// ---- SpigotMC (Spiget) ----

interface SpigetResource {
  id: number;
  name: string;
  tag: string;
  downloads: number;
  premium: boolean;
  external: boolean;
  file: { type: string; externalUrl?: string };
  icon?: { url?: string };
  version?: { id: number };
  testedVersions?: string[];
}

function spigetHit(r: SpigetResource): ContentHit {
  return {
    source: 'spigot',
    id: String(r.id),
    title: r.name,
    author: '',
    description: r.tag,
    downloads: r.downloads,
    iconUrl: r.icon?.url ? `https://www.spigotmc.org/${r.icon.url}` : undefined,
    url: `https://www.spigotmc.org/resources/${r.id}/`,
    installable: !r.premium && !r.external && r.file.type !== 'external',
  };
}

export async function searchSpiget(query: string, offset: number): Promise<ContentHit[]> {
  const page = Math.floor(offset / 20) + 1;
  const url = query.trim()
    ? `${SPIGET}/search/resources/${encodeURIComponent(query.trim())}?field=name&size=20&page=${page}&sort=-downloads`
    : `${SPIGET}/resources?size=20&page=${page}&sort=-downloads`;
  const list = await fetchJson<SpigetResource[]>(url).catch(() => [] as SpigetResource[]);
  return list.map(spigetHit);
}

export async function installSpiget(id: string, opts: SimpleInstallOptions): Promise<InstallResult> {
  if (!/^\d+$/.test(id)) throw new UserError('Neplatné ID pluginu.');
  const r = await fetchJson<SpigetResource>(`${SPIGET}/resources/${id}`);
  if (r.premium) throw new UserError(`${r.name} je placený plugin – kup a stáhni ho na SpigotMC a nahraj ručně.`);
  if (r.external || r.file.type === 'external') {
    throw new UserError(`${r.name} se stahuje z webu autora${r.file.externalUrl ? `: ${r.file.externalUrl}` : ''}. Stáhni ho a nahraj ručně.`);
  }
  // The download URL never changes between releases; the version id keeps the cache honest.
  const fileName = jarName(r.name);
  const cached = await downloadToCache(opts.paths, { url: `${SPIGET}/resources/${id}/download?v=${r.version?.id ?? 0}`, fileName });
  await assertJar(cached);
  await mkdir(opts.dir, { recursive: true });
  await copyFile(cached, path.join(opts.dir, fileName));
  await opts.onInstalled?.({ file: fileName, projectId: id, versionNumber: String(r.version?.id ?? ''), title: r.name, iconUrl: spigetHit(r).iconUrl });
  return { installed: [fileName], skipped: [] };
}
