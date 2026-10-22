// Modpacks from CurseForge ("cf:<id>") and Technic ("technic:<slug>"). A server pack wins over the
// client files: when it can start as it is, it is used as it is; otherwise srvMC installs the
// pack's loader itself and copies the pack's mods and configs over it.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import type { ModpackHit, ModpackInfo, ModpackVersion, ServerType } from '@srvmc/shared';
import {
  CLASS,
  cfClientOnly,
  cfDownloadHeaders,
  cfDownloadUrl,
  cfFileName,
  cfSha1,
  curseForgePackVersions,
  getFile,
  getFiles,
  getMod,
  getMods,
  manualFileOf,
  searchCurseForgePacks,
  type CfFile,
  type CfMod,
} from '../curseforge.ts';
import { downloadToCache, type DownloadSpec } from '../download.ts';
import { fetchJson } from '../http.ts';
import { readJarEntries } from '../jarmeta.ts';
import { cachedPath, type ManualFile } from '../manual.ts';
import { identifyHashes, primaryFile } from '../modrinth.ts';
import { javaMajorFor } from '../mojang.ts';
import { copyPack, detectLoader, dropClientMods, manifestLoader, packGameVersion, packLaunch, unpack, type PackLoader } from '../packs.ts';
import { platformArgs } from '../installer.ts';
import { fabric } from './fabric.ts';
import { forge, forgeBuilds, neoforge } from './forge.ts';
import { quilt } from './quilt.ts';
import { UserError, type InstallContext, type InstallPlan, type PlanEnv, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const LOADER_PROVIDERS: Record<PackLoader['type'], Provider> = { fabric, quilt, forge, neoforge };

/** The loader's own install plan. Forge ids of old versions carry a suffix ("1.7.10-10.13.4.1614-1.7.10"). */
export async function loaderPlan(loader: PackLoader): Promise<InstallPlan> {
  let build = loader.build;
  if (loader.type === 'forge') {
    const builds = await forgeBuilds(loader.mc);
    build = (builds.find((b) => b.id === build) ?? builds.find((b) => b.id.startsWith(`${build}-`)))?.id ?? build;
  }
  return LOADER_PROVIDERS[loader.type].plan(loader.mc, build);
}

interface Prepared {
  /** Unpacked files: a server pack, or the client files whose mods/configs the server uses. */
  root: string;
  kind: 'server' | 'client';
  loader: PackLoader | null;
  mcHint?: string;
  info: Omit<ModpackInfo, 'loader'>;
  build: string;
  staging: string;
  /** Client packs: fetches the pack's mods into the server folder. */
  fetchMods?: (ctx: InstallContext) => Promise<void>;
}

const unknownMc = async (p: Prepared) => p.loader?.mc || (await packGameVersion(p.root)) || p.mcHint || '';

/** Turns an unpacked pack into an install plan. */
async function planFromPack(p: Prepared): Promise<InstallPlan> {
  const done = async (ctx: InstallContext, extra: string) => {
    await rm(p.staging, { recursive: true, force: true });
    ctx.log(`Modpack ${p.info.title} ${p.info.versionNumber}: ${extra}`);
  };
  if (p.kind === 'server') {
    const asIs = await packLaunch(p.root);
    if (asIs) {
      const mc = await unknownMc(p);
      return {
        files: [],
        javaMajor: await javaMajorFor(mc || '1.12.2'),
        build: p.build,
        displayVersion: mc || p.info.versionNumber,
        modpack: { ...p.info, loader: p.loader?.type ?? 'forge' },
        async install(ctx) {
          ctx.progress(t('Copying the server pack'), null);
          const n = await copyPack(p.root, ctx.dir, 'server');
          await done(ctx, t('server pack used as it is ({n} files).', { n }));
          return platformArgs(asIs);
        },
      };
    }
  }
  if (!p.loader || !p.loader.mc) throw new UserError(t('Could not tell which loader and Minecraft version the modpack runs on.'));
  const loader = p.loader;
  const base = await loaderPlan(loader);
  return {
    files: base.files,
    javaMajor: base.javaMajor,
    build: p.build,
    displayVersion: loader.mc,
    modpack: { ...p.info, loader: loader.type as ServerType },
    async install(ctx) {
      const launch = base.install ? await base.install(ctx) : ['-jar', base.launchJar!];
      await p.fetchMods?.(ctx);
      ctx.progress(t('Copying the mods and settings of the modpack'), null);
      const n = await copyPack(p.root, ctx.dir, p.kind === 'server' ? 'content' : 'client');
      let dropped: string[] = [];
      if (p.kind === 'client') {
        ctx.progress(t('Setting aside player-only mods'), null);
        dropped = await dropClientMods(path.join(ctx.dir, 'mods'), path.join(ctx.paths.trash, ctx.serverId, 'jen-pro-klienta'));
      }
      await done(ctx, `${t(p.kind === 'server' ? 'server pack, {n} files' : 'client files, {n} files', { n })}${dropped.length ? `, ${t('{n} player-only mods put in the trash ({list})', { n: dropped.length, list: dropped.join(', ') })}` : ''}.`);
      return launch;
    },
  };
}

// ---- CurseForge ----

interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] };
  files: { projectID: number; fileID: number; required?: boolean }[];
  overrides?: string;
  name?: string;
}

/** A pack file: downloaded, or (when the author allows downloads only on CurseForge) waited for. */
async function cfPackFile(mod: CfMod, f: CfFile, env: PlanEnv, what: string): Promise<string> {
  const url = cfDownloadUrl(f);
  if (url) {
    return downloadToCache(env.paths, { url, fileName: cfFileName(f), sha1: cfSha1(f), size: f.fileLength, headers: cfDownloadHeaders(url) }, (d, t) =>
      env.progress?.(`Stahuji ${what} · ${Math.round(d / 1048576)}${t ? ` z ${Math.round(t / 1048576)}` : ''} MB`, t ? Math.round((d / t) * 100) : null),
    );
  }
  if (!env.manual || !env.serverId) throw new UserError(t('{name}: the author allows downloads only on CurseForge.', { name: mod.name }));
  const mf = manualFileOf(mod, f);
  await env.manual.waitAll(env.serverId, [mf], async () => undefined, (items) => env.progress?.(t('Download the {what} from CurseForge – srvMC picks it up from the Downloads folder', { what: t(what) }), null, items));
  return cachedPath(env.paths, mf);
}

const SERVER_CLASSES = new Set<number>([CLASS.mod, CLASS.plugin]);

async function cfPrepared(modId: number, fileId: number, env: PlanEnv): Promise<Prepared> {
  const [mod, file] = await Promise.all([getMod(modId), getFile(modId, fileId)]);
  if (file.modId !== mod.id) throw new UserError(t('The version does not belong to this modpack.'));
  const zip = await cfPackFile(mod, file, env, 'modpack');
  const manifest = JSON.parse((await readJarEntries(zip, new Set(['manifest.json']))).get('manifest.json') ?? 'null') as CfManifest | null;
  if (!manifest?.minecraft) throw new UserError(t('The modpack file is damaged (manifest.json is missing).'));
  const mc = manifest.minecraft.version;
  const primary = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];
  const loader = primary ? manifestLoader(mc, primary.id) : null;
  const info = { source: 'curseforge' as const, projectId: `cf:${mod.id}`, versionId: String(file.id), title: mod.name, versionNumber: file.displayName, iconUrl: mod.logo?.thumbnailUrl };
  const staging = path.join(env.paths.cache, 'unpacked', `cf-${file.id}`);

  const serverPack = file.serverPackFileId ? await getFile(modId, file.serverPackFileId).catch(() => null) : null;
  if (serverPack) {
    const spZip = await cfPackFile(mod, serverPack, env, 'server pack');
    env.progress?.(t('Unpacking the server pack'), null);
    return { root: await unpack(spZip, staging), kind: 'server', loader, mcHint: mc, info, build: String(file.id), staging };
  }

  const clientRoot = await unpack(zip, staging);
  return {
    root: path.join(clientRoot, manifest.overrides ?? 'overrides'),
    kind: 'client',
    loader,
    mcHint: mc,
    info,
    build: String(file.id),
    staging,
    async fetchMods(ctx) {
      const wanted = manifest.files.filter((f) => f.required !== false);
      ctx.progress(t('Finding the mods of the modpack'), null);
      const [files, mods] = await Promise.all([getFiles(wanted.map((f) => f.fileID)), getMods([...new Set(wanted.map((f) => f.projectID))])]);
      const byMod = new Map(mods.map((m) => [m.id, m]));
      // Most mods are on Modrinth too, byte for byte: one lookup by hash, and those come from there.
      const sha1s = files.map((f) => cfSha1(f)).filter((h): h is string => !!h);
      const onModrinth = await identifyHashes(sha1s).catch(() => ({}) as Awaited<ReturnType<typeof identifyHashes>>);
      const manual: { mf: ManualFile; out: string }[] = [];
      let i = 0;
      let skipped = 0;
      for (const f of files) {
        i++;
        const mod = byMod.get(f.modId);
        // Resource packs, shaders and worlds are for players; mods marked client-only too.
        if ((mod?.classId !== undefined && !SERVER_CLASSES.has(mod.classId)) || cfClientOnly(f)) {
          skipped++;
          continue;
        }
        const out = path.join(ctx.dir, mod?.classId === CLASS.plugin ? 'plugins' : 'mods', cfFileName(f));
        const sha1 = cfSha1(f);
        const mr = sha1 ? onModrinth[sha1] : undefined;
        const mrFile = mr && (mr.files.find((x) => x.hashes.sha1 === sha1) ?? primaryFile(mr));
        const url = mrFile?.hashes.sha1 === sha1 ? mrFile!.url : cfDownloadUrl(f);
        if (!url) {
          if (mod) manual.push({ mf: manualFileOf(mod, f), out });
          continue;
        }
        ctx.progress(t('Downloading the mods of the modpack · {i} of {n}', { i, n: files.length }), Math.round((i / files.length) * 100));
        const cached = await downloadToCache(ctx.paths, { url, fileName: cfFileName(f), sha1, size: f.fileLength, headers: cfDownloadHeaders(url) });
        await mkdir(path.dirname(out), { recursive: true });
        await copyFile(cached, out);
      }
      if (manual.length) {
        if (!ctx.manual) throw new UserError(t('Some mods can only be downloaded from the CurseForge website.'));
        await ctx.manual.waitAll(
          ctx.serverId,
          manual.map((m) => m.mf),
          async (mf, cached) => {
            const out = manual.find((m) => m.mf === mf)!.out;
            await mkdir(path.dirname(out), { recursive: true });
            await copyFile(cached, out);
          },
          (items) => ctx.progress(t('Download {left} of {total} mods from CurseForge – srvMC picks them up from the Downloads folder', { left: items.filter((x) => !x.done).length, total: items.length }), Math.round((items.filter((x) => x.done).length / items.length) * 100), undefined, items),
        );
      }
      ctx.log(`${t('Modpack: {n} mods downloaded, {skipped} player-only skipped', { n: files.length - skipped, skipped })}${manual.length ? `, ${t('{n} downloaded by hand', { n: manual.length })}` : ''}.`);
    },
  };
}

export const curseForgePacks = {
  search: searchCurseForgePacks,
  versions: (id: string) => curseForgePackVersions(Number(id)),
  async plan(id: string, fileId: string | undefined, env: PlanEnv): Promise<InstallPlan> {
    if (!/^\d+$/.test(id) || !fileId || !/^\d+$/.test(fileId)) throw new UserError('Vyber verzi modpacku.');
    return planFromPack(await cfPrepared(Number(id), Number(fileId), env));
  },
};

// ---- Technic ----

const TECHNIC = 'https://api.technicpack.net';
// The API wants the launcher build it serves; any recent one works.
const TECHNIC_BUILD = 1170;

interface TechnicPack {
  name: string;
  displayName: string;
  user?: string;
  url: string | null;
  platformUrl?: string;
  minecraft?: string;
  version?: string;
  description?: string;
  installs?: number;
  icon?: { url?: string } | null;
  logo?: { url?: string } | null;
  solder: string | null;
  serverPackUrl: string | null;
}

interface SolderBuild {
  minecraft: string;
  mods: { name: string; version: string; md5?: string; url: string; filesize?: number }[];
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

function technicPack(slug: string): Promise<TechnicPack> {
  if (!SLUG.test(slug)) throw new UserError(t('Invalid modpack.'));
  return fetchJson<TechnicPack>(`${TECHNIC}/modpack/${encodeURIComponent(slug)}?build=${TECHNIC_BUILD}`);
}

/** Downloads from links the pack author set (Dropbox and the like); "dl=0" pages turn into files. */
function directUrl(url: string): string {
  if (/dropbox\.com/.test(url)) return url.replace(/([?&])dl=0/, '$1dl=1');
  return url;
}

async function technicSearch(query: string): Promise<ModpackHit[]> {
  if (!query.trim()) query = 'tekkit';
  const res = await fetchJson<{ modpacks: { name: string; slug: string; iconUrl?: string }[] }>(`${TECHNIC}/search?q=${encodeURIComponent(query)}&build=${TECHNIC_BUILD}`);
  const packs = await Promise.all(res.modpacks.slice(0, 20).map((m) => technicPack(m.slug).then((p) => ({ m, p })).catch(() => null)));
  return packs
    .filter((x): x is { m: { name: string; slug: string; iconUrl?: string }; p: TechnicPack } => !!x && (!!x.p.serverPackUrl || !!x.p.url || !!x.p.solder))
    .map(({ m, p }) => ({
      id: `technic:${m.slug}`,
      title: p.displayName || m.name,
      author: p.user ?? '',
      description: (p.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      downloads: p.installs ?? 0,
      iconUrl: m.iconUrl ?? p.icon?.url ?? undefined,
      versions: [],
    }));
}

async function technicVersions(slug: string): Promise<ModpackVersion[]> {
  const p = await technicPack(slug);
  // Technic's own Minecraft version field is often stale; the pack itself says the truth on install.
  return [{ id: 'latest', name: p.version ?? t('latest'), versionNumber: p.version ?? t('latest'), gameVersions: [], loaders: [], ...(p.serverPackUrl && { serverPack: true }) }];
}

async function technicPrepared(slug: string, env: PlanEnv): Promise<Prepared> {
  const p = await technicPack(slug);
  const info = { source: 'technic' as const, projectId: `technic:${slug}`, versionId: p.version ?? 'latest', title: p.displayName || p.name, versionNumber: p.version ?? '', iconUrl: p.icon?.url ?? undefined };
  const staging = path.join(env.paths.cache, 'unpacked', `technic-${slug}`);
  const progress = (what: string) => (d: number, t: number | null) => env.progress?.(`Stahuji ${what} · ${Math.round(d / 1048576)}${t ? ` z ${Math.round(t / 1048576)}` : ''} MB`, t ? Math.round((d / t) * 100) : null);
  const get = (spec: DownloadSpec, what: string) => {
    if (!/^https?:\/\//.test(spec.url)) throw new UserError('Modpack odkazuje na neplatnou adresu.');
    return downloadToCache(env.paths, spec, progress(what));
  };
  const name = (url: string) => {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/[^\w.+()\[\] -]/g, '_');
    return /^[A-Za-z0-9][\w.+()\[\] -]*$/.test(base) ? base : 'modpack.zip';
  };

  if (p.serverPackUrl) {
    const zip = await get({ url: directUrl(p.serverPackUrl), fileName: name(p.serverPackUrl) }, 'server pack');
    env.progress?.('Rozbaluji server pack', null);
    const root = await unpack(zip, staging);
    return { root, kind: 'server', loader: await detectLoader(root, p.minecraft), mcHint: p.minecraft, info, build: info.versionId, staging };
  }
  if (p.url) {
    const zip = await get({ url: directUrl(p.url), fileName: name(p.url) }, 'modpack');
    env.progress?.('Rozbaluji modpack', null);
    const root = await unpack(zip, staging);
    return { root, kind: 'client', loader: await detectLoader(root, p.minecraft), mcHint: p.minecraft, info, build: info.versionId, staging };
  }
  if (p.solder) {
    const api = p.solder.replace(/\/?$/, '/');
    const list = await fetchJson<{ recommended?: string; latest?: string }>(`${api}modpack/${encodeURIComponent(slug)}`);
    const buildId = list.recommended ?? list.latest;
    if (!buildId) throw new UserError(t('The modpack has no version on Technic.'));
    const build = await fetchJson<SolderBuild>(`${api}modpack/${encodeURIComponent(slug)}/${encodeURIComponent(buildId)}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    let i = 0;
    for (const m of build.mods) {
      i++;
      env.progress?.(`Stahuji modpack · ${i} z ${build.mods.length}`, Math.round((i / build.mods.length) * 100));
      const zip = await downloadToCache(env.paths, { url: m.url, fileName: name(m.url), md5: m.md5, size: m.filesize || undefined });
      await extractZip(zip, { dir: path.resolve(staging) });
    }
    return { root: staging, kind: 'client', loader: await detectLoader(staging, build.minecraft), mcHint: build.minecraft, info: { ...info, versionId: buildId, versionNumber: buildId }, build: buildId, staging };
  }
  throw new UserError(t('This modpack has no files to download on Technic.'));
}

export const technicPacks = {
  search: technicSearch,
  versions: technicVersions,
  async plan(slug: string, env: PlanEnv): Promise<InstallPlan> {
    return planFromPack(await technicPrepared(slug, env));
  },
};
