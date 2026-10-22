import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ContentHit, ContentKind, InstallResult } from '@srvmc/shared';
import { downloadToCache } from './download.ts';
import { fetchJson } from './http.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';
import { t } from '@srvmc/shared';

const API = 'https://api.modrinth.com/v2';

interface MrFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1: string; sha512: string };
}

export interface MrVersion {
  id: string;
  project_id: string;
  name?: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  game_versions?: string[];
  loaders?: string[];
  files: MrFile[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[];
}

export interface MrProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  project_type: string;
  server_side: 'required' | 'optional' | 'unsupported' | 'unknown';
  client_side: string;
  icon_url?: string | null;
}

interface MrSearchHit {
  project_id: string;
  slug: string;
  title: string;
  author: string;
  description: string;
  downloads: number;
  icon_url?: string;
  project_type: string;
  server_side: string;
  versions?: string[];
}

const SAFE_JAR = /^[\w.+()\[\] -]+\.jar$/;

/** Picks the newest release (else any) version of a project for the given loaders and game version. */
export async function findVersion(project: string, loaders: string[], gameVersion: string): Promise<MrVersion | null> {
  const q = `loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await fetchJson<MrVersion[]>(`${API}/project/${encodeURIComponent(project)}/version?${q}`);
  return versions.find((v) => v.version_type === 'release') ?? versions[0] ?? null;
}

export function getProject(id: string): Promise<MrProject> {
  return fetchJson<MrProject>(`${API}/project/${encodeURIComponent(id)}`);
}

export async function getProjects(ids: string[]): Promise<MrProject[]> {
  if (ids.length === 0) return [];
  return fetchJson<MrProject[]>(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
}

export function primaryFile(v: MrVersion): MrFile | undefined {
  return v.files.find((f) => f.primary) ?? v.files.find((f) => !/-(sources|javadoc|dev)\.jar$/.test(f.filename));
}

/** Facets for Modrinth search: the server's loaders, its game version, and (optionally) only things a server can run. */
export function searchFacets(loaders: string[], gameVersion: string, kind: ContentKind, hideClientOnly: boolean): string[][] {
  const facets = [loaders.map((l) => `categories:${l}`), [`versions:${gameVersion}`]];
  // Modrinth files many plugins under project_type "mod", so only real mods get the type filter.
  if (kind === 'mod') facets.push(['project_type:mod']);
  if (hideClientOnly) facets.push(['server_side:required', 'server_side:optional']);
  return facets;
}

export async function searchModrinth(opts: { query: string; loaders: string[]; gameVersion: string; kind: ContentKind; hideClientOnly: boolean; offset: number }): Promise<ContentHit[]> {
  const q = new URLSearchParams({
    query: opts.query,
    limit: '20',
    offset: String(opts.offset),
    index: opts.query ? 'relevance' : 'downloads',
    facets: JSON.stringify(searchFacets(opts.loaders, opts.gameVersion, opts.kind, opts.hideClientOnly)),
  });
  const res = await fetchJson<{ hits: MrSearchHit[] }>(`${API}/search?${q}`);
  return res.hits.map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    title: h.title,
    author: h.author,
    description: h.description,
    downloads: h.downloads,
    iconUrl: h.icon_url || undefined,
    url: `https://modrinth.com/${h.project_type}/${h.slug}`,
    clientOnly: h.server_side === 'unsupported',
    installable: h.server_side !== 'unsupported',
  }));
}

/** Which Modrinth version each file (by SHA-1) is. Unknown files are missing from the result. */
export async function identifyHashes(sha1s: string[]): Promise<Record<string, MrVersion>> {
  if (sha1s.length === 0) return {};
  return fetchJson<Record<string, MrVersion>>(`${API}/version_files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' }),
  });
}

/** The newest compatible version for each installed file (by SHA-1). */
export async function latestForHashes(sha1s: string[], loaders: string[], gameVersion: string): Promise<Record<string, MrVersion>> {
  if (sha1s.length === 0) return {};
  return fetchJson<Record<string, MrVersion>>(`${API}/version_files/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1', loaders, game_versions: [gameVersion] }),
  });
}

export interface InstalledFile {
  file: string;
  projectId: string;
  versionId: string;
  versionNumber: string;
  title: string;
  iconUrl?: string;
}

export interface ModrinthInstallOptions {
  paths: Paths;
  dir: string;
  loaders: string[];
  gameVersion: string;
  /** Projects already on the server; dependencies among them are not installed again. */
  present: Set<string>;
  onInstalled?: (f: InstalledFile) => Promise<void>;
}

/**
 * Installs a project with its required dependencies. Client-only projects are refused (and skipped
 * as dependencies): a server does not load them, and some crash it.
 */
export async function installModrinth(project: string, opts: ModrinthInstallOptions, result: InstallResult = { installed: [], skipped: [] }, depth = 0): Promise<InstallResult> {
  if (opts.present.has(project)) return result;
  opts.present.add(project);
  const info = await getProject(project);
  if (info.server_side === 'unsupported') {
    if (depth === 0) throw new UserError(t('{name} is only for players (the client). The server does not need it and could crash because of it.', { name: info.title }));
    result.skipped.push(t('{name} (client only)', { name: info.title }));
    return result;
  }
  const version = await findVersion(info.id, opts.loaders, opts.gameVersion);
  if (!version) {
    if (depth === 0) throw new UserError(t('{name} has no version for {version} yet.', { name: info.title, version: `${opts.gameVersion} (${opts.loaders[0]})` }));
    result.skipped.push(t('{name} (no version for {version})', { name: info.title, version: opts.gameVersion }));
    return result;
  }
  const file = primaryFile(version);
  if (!file || !SAFE_JAR.test(file.filename)) throw new UserError(t('{name} has no usable file to download.', { name: info.title }));

  const cached = await downloadToCache(opts.paths, { url: file.url, fileName: file.filename, sha1: file.hashes.sha1, size: file.size });
  await mkdir(opts.dir, { recursive: true });
  await copyFile(cached, path.join(opts.dir, file.filename));
  result.installed.push(file.filename);
  await opts.onInstalled?.({ file: file.filename, projectId: info.id, versionId: version.id, versionNumber: version.version_number, title: info.title, iconUrl: info.icon_url || undefined });

  for (const dep of version.dependencies) {
    if (dep.dependency_type === 'required' && dep.project_id) await installModrinth(dep.project_id, opts, result, depth + 1);
  }
  return result;
}

/** Simple install used by built-in helpers (Chunky): the project and its dependencies, no bookkeeping. */
export async function installProject(paths: Paths, project: string, loaders: string[], gameVersion: string, targetDir: string): Promise<string[]> {
  return (await installModrinth(project, { paths, dir: targetDir, loaders, gameVersion, present: new Set() })).installed;
}
