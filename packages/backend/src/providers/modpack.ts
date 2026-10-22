// Modpacks. Modrinth (.mrpack): the pack's loader is installed first, then its server-side files and
// overrides. CurseForge ("cf:<id>") and Technic ("technic:<slug>") live in packsources.ts.
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { ModpackHit, ModpackInfo, ModpackSource, ModpackVersion, ServerType } from '@srvmc/shared';
import { downloadToCache } from '../download.ts';
import { fetchJson } from '../http.ts';
import { readJarEntries } from '../jarmeta.ts';
import { getProject, primaryFile, type MrVersion } from '../modrinth.ts';
import { fabric } from './fabric.ts';
import { forge, neoforge } from './forge.ts';
import { curseForgePacks, technicPacks } from './packsources.ts';
import { quilt } from './quilt.ts';
import { UserError, type InstallContext, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const API = 'https://api.modrinth.com/v2';

export interface MrpackIndex {
  formatVersion: number;
  game: string;
  name: string;
  versionId: string;
  dependencies: Record<string, string>;
  files: { path: string; hashes: { sha1: string; sha512?: string }; env?: { client?: string; server?: string }; downloads: string[]; fileSize: number }[];
}

/** Which loader a pack needs, and the build id our providers use for it. */
export function packLoader(deps: Record<string, string>): { type: ServerType; build: string; mc: string } {
  const mc = deps.minecraft;
  if (!mc) throw new UserError(t('The modpack does not state a Minecraft version.'));
  if (deps['fabric-loader']) return { type: 'fabric', build: deps['fabric-loader'], mc };
  if (deps['quilt-loader']) return { type: 'quilt', build: deps['quilt-loader'], mc };
  if (deps.neoforge) return { type: 'neoforge', build: deps.neoforge, mc };
  if (deps.forge) return { type: 'forge', build: `${mc}-${deps.forge}`, mc };
  throw new UserError(t('The modpack uses a loader srvMC does not support yet.'));
}

/** Pack file paths must stay inside the server folder and avoid anything that could run code at start. */
export function safePackPath(p: string): string | null {
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').some((s) => s === '..' || s === '')) return null;
  if (/\.(bat|cmd|exe|ps1|sh|vbs)$/i.test(norm)) return null;
  return norm;
}

/** Files the server needs: anything not marked "server: unsupported". */
export function serverFiles(index: MrpackIndex): MrpackIndex['files'] {
  return index.files.filter((f) => f.env?.server !== 'unsupported');
}

const LOADER_PROVIDERS: Partial<Record<ServerType, Provider>> = { fabric, quilt, forge, neoforge };

export async function searchModpacks(query: string, offset: number): Promise<ModpackHit[]> {
  const facets = JSON.stringify([['project_type:modpack'], ['server_side:required', 'server_side:optional']]);
  const q = new URLSearchParams({ query, limit: '20', offset: String(offset), index: query ? 'relevance' : 'downloads', facets });
  const res = await fetchJson<{ hits: { project_id: string; title: string; author: string; description: string; downloads: number; icon_url?: string; versions: string[] }[] }>(`${API}/search?${q}`);
  return res.hits.map((h) => ({ id: h.project_id, title: h.title, author: h.author, description: h.description, downloads: h.downloads, iconUrl: h.icon_url || undefined, versions: h.versions }));
}

export async function modpackVersions(projectId: string): Promise<ModpackVersion[]> {
  const versions = await fetchJson<MrVersion[]>(`${API}/project/${encodeURIComponent(projectId)}/version`);
  return versions
    .filter((v) => v.files.some((f) => f.filename.endsWith('.mrpack')))
    .map((v) => ({ id: v.id, name: v.name ?? v.version_number, versionNumber: v.version_number, gameVersions: v.game_versions ?? [], loaders: v.loaders ?? [] }));
}

/** Versions of a pack from any source, by the id the wizard got from the search. */
export function packVersions(id: string): Promise<ModpackVersion[]> {
  if (id.startsWith('cf:')) return curseForgePacks.versions(id.slice(3));
  if (id.startsWith('technic:')) return technicPacks.versions(id.slice(8));
  return modpackVersions(id);
}

export function searchPacks(source: ModpackSource, query: string, offset: number): Promise<ModpackHit[]> {
  if (source === 'curseforge') return curseForgePacks.search(query, offset);
  if (source === 'technic') return offset ? Promise.resolve([]) : technicPacks.search(query);
  return searchModpacks(query, offset);
}

async function extractOverrides(zipFile: string, dir: string): Promise<number> {
  // server-overrides win over overrides, so they are written second.
  let count = 0;
  for (const prefix of ['overrides/', 'server-overrides/']) {
    count += await new Promise<number>((resolve, reject) => {
      let n = 0;
      yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
        if (err || !zip) return reject(err);
        zip.on('entry', (entry: yauzl.Entry) => {
          if (!entry.fileName.startsWith(prefix) || entry.fileName.endsWith('/')) return zip.readEntry();
          const rel = safePackPath(entry.fileName.slice(prefix.length));
          if (!rel) return zip.readEntry();
          const out = path.join(dir, ...rel.split('/'));
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return zip.readEntry();
            mkdir(path.dirname(out), { recursive: true })
              .then(() => pipeline(stream, createWriteStream(out)))
              .then(() => {
                n++;
                zip.readEntry();
              }, reject);
          });
        });
        zip.on('end', () => resolve(n));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }
  return count;
}

export const modpack: Provider = {
  type: 'modpack',

  // The wizard picks packs through searchModpacks; the generic version list is not used.
  async listVersions() {
    return [];
  },

  async listBuilds(projectId) {
    return (await packVersions(projectId)).map((v) => ({
      id: v.id,
      label: `${v.versionNumber} · Minecraft ${v.gameVersions.join(', ')}`,
      channel: 'stable',
    }));
  },

  async plan(projectId, versionId, env) {
    if (projectId.startsWith('cf:')) return curseForgePacks.plan(projectId.slice(3), versionId, env!);
    if (projectId.startsWith('technic:')) return technicPacks.plan(projectId.slice(8), env!);
    if (!versionId) throw new UserError('Vyber verzi modpacku.');
    const [project, version] = await Promise.all([getProject(projectId), fetchJson<MrVersion>(`${API}/version/${encodeURIComponent(versionId)}`)]);
    if (version.project_id !== project.id) throw new UserError(t('The version does not belong to this modpack.'));
    const pack = version.files.find((f) => f.filename.endsWith('.mrpack')) ?? primaryFile(version);
    if (!pack) throw new UserError(t('The modpack has no .mrpack file.'));
    const spec = { url: pack.url, fileName: pack.filename.replace(/[^\w.+-]/g, '_'), sha1: pack.hashes.sha1, size: pack.size };

    // The index decides the loader, so the pack is fetched (into the cache) already while planning.
    if (!env) throw new Error('Modpack plan needs the data paths.');
    const mrpack = await downloadToCache(env.paths, spec);
    const index = JSON.parse((await readJarEntries(mrpack, new Set(['modrinth.index.json']))).get('modrinth.index.json') ?? 'null') as MrpackIndex | null;
    if (!index || index.game !== 'minecraft') throw new UserError(t('The modpack file is damaged (modrinth.index.json is missing).'));

    const loader = packLoader(index.dependencies);
    const base = await LOADER_PROVIDERS[loader.type]!.plan(loader.mc, loader.build);
    const info: ModpackInfo = {
      source: 'modrinth',
      projectId: project.id,
      versionId: version.id,
      title: project.title,
      versionNumber: version.version_number,
      loader: loader.type,
      iconUrl: project.icon_url ?? undefined,
    };

    return {
      files: base.files,
      javaMajor: base.javaMajor,
      build: version.id,
      displayVersion: loader.mc,
      modpack: info,
      async install(ctx: InstallContext) {
        const launch = base.install ? await base.install(ctx) : ['-jar', base.launchJar!];
        const files = serverFiles(index);
        let i = 0;
        for (const f of files) {
          i++;
          const rel = safePackPath(f.path);
          const url = f.downloads.find((u) => u.startsWith('https://'));
          if (!rel || !url) {
            ctx.log(t('Skipping a suspicious modpack file: {path}', { path: f.path }));
            continue;
          }
          ctx.progress(`Stahuji obsah modpacku · ${i} z ${files.length}`, Math.round((i / files.length) * 100));
          const cached = await downloadToCache(ctx.paths, { url, fileName: path.posix.basename(rel).replace(/[^\w.+()\[\] -]/g, '_'), sha1: f.hashes.sha1, size: f.fileSize });
          const out = path.join(ctx.dir, ...rel.split('/'));
          await mkdir(path.dirname(out), { recursive: true });
          await copyFile(cached, out);
        }
        ctx.progress(t('Copying the modpack settings'), null);
        const overrides = await extractOverrides(mrpack, ctx.dir);
        ctx.log(t('Modpack {name} {version}: {files} files, {overrides} from overrides ({skipped} client-only skipped).', { name: project.title, version: version.version_number, files: files.length, overrides, skipped: index.files.length - files.length }));
        return launch;
      },
    };
  },
};
