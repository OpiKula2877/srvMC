// Mods and plugins on a server: where they go, what is installed, install / update / toggle / remove.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ContentKind, ContentSource, ContentTarget, InstalledContent, InstallResult, ServerConfig, ServerType } from '@srvmc/shared';
import { installCurseForge } from './curseforge.ts';
import { validName } from './files.ts';
import type { ServerInstance } from './instance.ts';
import { readJarMeta, type JarMeta } from './jarmeta.ts';
import type { ManualDownloads } from './manual.ts';
import { getProjects, identifyHashes, installModrinth, latestForHashes } from './modrinth.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';
import { installHangar, installSpiget } from './sources.ts';
import { t } from '@srvmc/shared';

/** The type whose content rules apply: a modpack server behaves like its loader. */
export function effectiveType(cfg: Pick<ServerConfig, 'type' | 'modpack'>): ServerType {
  return cfg.type === 'modpack' && cfg.modpack ? cfg.modpack.loader : cfg.type;
}

/** Arclight's build id is the jar name, which says which loader it is built on. */
function arclightLoader(cfg: Pick<ServerConfig, 'build'>): 'forge' | 'neoforge' | 'fabric' {
  const m = /arclight-(forge|neoforge|fabric)-/.exec(cfg.build ?? '');
  return (m?.[1] as 'forge' | 'neoforge' | 'fabric') ?? 'neoforge';
}

export function contentTargets(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build'>): ContentTarget[] {
  switch (effectiveType(cfg)) {
    case 'paper':
    case 'purpur':
      return [{ kind: 'plugin', folder: 'plugins', sources: ['modrinth', 'hangar', 'spigot', 'curseforge'] }];
    case 'spigot':
      return [{ kind: 'plugin', folder: 'plugins', sources: ['modrinth', 'spigot', 'curseforge'] }];
    case 'fabric':
    case 'quilt':
    case 'forge':
    case 'neoforge':
      return [{ kind: 'mod', folder: 'mods', sources: ['modrinth', 'curseforge'] }];
    case 'arclight':
      return [
        { kind: 'mod', folder: 'mods', sources: ['modrinth', 'curseforge'] },
        { kind: 'plugin', folder: 'plugins', sources: ['modrinth', 'spigot', 'curseforge'] },
      ];
    case 'velocity':
      return [{ kind: 'plugin', folder: 'plugins', sources: ['modrinth'] }];
    default:
      return [];
  }
}

/** Modrinth loader names that fit the server, best match first. */
export function modrinthLoaders(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build'>, kind: ContentKind): string[] {
  const type = effectiveType(cfg);
  if (kind === 'plugin') {
    if (type === 'velocity') return ['velocity'];
    if (type === 'purpur') return ['purpur', 'paper', 'spigot', 'bukkit'];
    if (type === 'spigot' || type === 'arclight') return ['spigot', 'bukkit'];
    return ['paper', 'spigot', 'bukkit'];
  }
  if (type === 'quilt') return ['quilt', 'fabric'];
  if (type === 'arclight') return [arclightLoader(cfg)];
  return [type];
}

export function targetFor(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build'>, folder: string): ContentTarget {
  const target = contentTargets(cfg).find((x) => x.folder === folder);
  if (!target) throw new UserError(cfg.type === 'vanilla' ? t('A Vanilla server cannot run mods or plugins.') : t('This server does not use such a folder.'));
  return target;
}

// ---- registry of what srvMC installed (source, project, version) ----

interface RegistryEntry {
  source: ContentSource;
  projectId: string;
  versionId?: string;
  versionNumber?: string;
  title: string;
  iconUrl?: string;
}

type Registry = Record<string, RegistryEntry>;
const REGISTRY = '.srvmc-content.json';

async function loadRegistry(dir: string): Promise<Registry> {
  try {
    return JSON.parse(await readFile(path.join(dir, REGISTRY), 'utf8')) as Registry;
  } catch {
    return {};
  }
}

async function saveRegistry(dir: string, reg: Registry): Promise<void> {
  await writeFile(path.join(dir, REGISTRY), JSON.stringify(reg, null, 2), 'utf8');
}

const regKey = (folder: string, file: string) => `${folder}/${file.replace(/\.disabled$/, '')}`;

async function sha1(file: string): Promise<string> {
  const h = createHash('sha1');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

function isJar(name: string): boolean {
  return /\.jar(\.disabled)?$/i.test(name);
}

async function jarsIn(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter(isJar).sort((a, b) => a.localeCompare(b, 'cs'));
}

/** Lists the jars of every content folder. Files srvMC did not install are identified through Modrinth by hash. */
export async function listInstalled(inst: ServerInstance): Promise<InstalledContent[]> {
  const reg = await loadRegistry(inst.dir);
  const out: InstalledContent[] = [];
  const unknown: { item: InstalledContent; abs: string; meta: JarMeta }[] = [];
  for (const target of contentTargets(inst.cfg)) {
    const dir = path.join(inst.dir, target.folder);
    for (const file of await jarsIn(dir)) {
      const abs = path.join(dir, file);
      const s = await stat(abs).catch(() => null);
      if (!s?.isFile()) continue;
      const entry = reg[regKey(target.folder, file)];
      const meta = await readJarMeta(abs);
      const item: InstalledContent = {
        file,
        folder: target.folder,
        enabled: !file.endsWith('.disabled'),
        size: s.size,
        name: entry?.title ?? meta.name ?? file.replace(/\.jar(\.disabled)?$/i, ''),
        version: meta.version ?? entry?.versionNumber,
        source: entry?.source,
        projectId: entry?.projectId,
        iconUrl: entry?.iconUrl,
      };
      out.push(item);
      if (!entry) unknown.push({ item, abs, meta });
    }
  }

  // Manually added jars: Modrinth knows most of them by hash, which enables update checks.
  if (unknown.length) {
    try {
      const hashes = await Promise.all(unknown.map((u) => sha1(u.abs)));
      const found = await identifyHashes(hashes);
      const projects = await getProjects([...new Set(Object.values(found).map((v) => v.project_id))]).catch(() => []);
      let changed = false;
      unknown.forEach((u, i) => {
        const v = found[hashes[i]!];
        if (!v) return;
        const p = projects.find((x) => x.id === v.project_id);
        reg[regKey(u.item.folder, u.item.file)] = { source: 'modrinth', projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, title: p?.title ?? u.item.name, iconUrl: p?.icon_url ?? undefined };
        Object.assign(u.item, { source: 'modrinth', projectId: v.project_id, name: p?.title ?? u.item.name, iconUrl: p?.icon_url ?? undefined });
        changed = true;
      });
      if (changed) await saveRegistry(inst.dir, reg);
    } catch {
      // Offline or Modrinth down: the list still works, just without identification.
    }
  }
  return out;
}

/** Adds Modrinth update info to installed items. */
export async function checkUpdates(inst: ServerInstance, items: InstalledContent[]): Promise<InstalledContent[]> {
  const reg = await loadRegistry(inst.dir);
  for (const target of contentTargets(inst.cfg)) {
    const inFolder = items.filter((i) => i.folder === target.folder && i.source === 'modrinth');
    if (!inFolder.length) continue;
    const hashes = await Promise.all(inFolder.map((i) => sha1(path.join(inst.dir, i.folder, i.file))));
    const latest = await latestForHashes(hashes, modrinthLoaders(inst.cfg, target.kind), inst.cfg.version);
    inFolder.forEach((item, idx) => {
      const v = latest[hashes[idx]!];
      const current = reg[regKey(item.folder, item.file)]?.versionId;
      if (v && v.id !== current) item.update = { versionId: v.id, versionNumber: v.version_number };
    });
  }
  return items;
}

function requireStopped(inst: ServerInstance, what: string): void {
  if (inst.running) throw new UserError(t('Stop the server first – Windows keeps the {what} locked while it runs.', { what }));
}

function checkFile(file: string): void {
  if (!validName(file) || !isJar(file)) throw new UserError(t('Invalid file.'));
}

/** Moves a jar to the srvMC trash and forgets it in the registry. */
async function trashJar(inst: ServerInstance, trashDir: string, folder: string, file: string, reg: Registry): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashDir, stamp, folder);
  await mkdir(dest, { recursive: true });
  await rename(path.join(inst.dir, folder, file), path.join(dest, file));
  delete reg[regKey(folder, file)];
}

export interface ContentContext {
  paths: Paths;
  trashDir: string;
  /** Picks up files the user downloads by hand (CurseForge mods without third-party downloads). */
  manual?: ManualDownloads;
}

/** Installs a project from a source, with dependencies; replaces an older file of the same project. */
export async function installContent(inst: ServerInstance, ctx: ContentContext, source: ContentSource, id: string, folder: string): Promise<InstallResult> {
  const target = targetFor(inst.cfg, folder);
  if (!target.sources.includes(source)) throw new UserError(t('This source does not fit this server.'));
  const dir = path.join(inst.dir, target.folder);
  const reg = await loadRegistry(inst.dir);
  const present = new Set<string>();
  for (const [key, e] of Object.entries(reg)) if (key.startsWith(`${target.folder}/`)) present.add(e.source === 'modrinth' ? e.projectId : `${e.source}:${e.projectId.toLowerCase()}`);
  if (present.has(source === 'modrinth' ? id : `${source}:${id.toLowerCase()}`)) throw new UserError(t('This is already installed.'));

  const onInstalled = async (f: { file: string; projectId: string; versionId?: string; versionNumber: string; title: string; iconUrl?: string }) => {
    // An older file of the same project (a different version) would load twice.
    for (const [key, e] of Object.entries(reg)) {
      const old = key.slice(target.folder.length + 1);
      if (key.startsWith(`${target.folder}/`) && e.source === source && e.projectId === f.projectId && old !== f.file) {
        await rm(path.join(dir, old), { force: true });
        await rm(path.join(dir, `${old}.disabled`), { force: true });
        delete reg[key];
      }
    }
    reg[regKey(target.folder, f.file)] = { source, projectId: f.projectId, versionId: f.versionId, versionNumber: f.versionNumber, title: f.title, iconUrl: f.iconUrl };
  };

  let result: InstallResult;
  if (source === 'modrinth') {
    result = await installModrinth(id, { paths: ctx.paths, dir, loaders: modrinthLoaders(inst.cfg, target.kind), gameVersion: inst.cfg.version, present, onInstalled });
  } else if (source === 'curseforge') {
    if (!/^\d+$/.test(id) || !ctx.manual) throw new UserError(t('Invalid CurseForge project.'));
    result = await installCurseForge(Number(id), {
      paths: ctx.paths,
      dir,
      serverId: inst.cfg.id,
      manual: ctx.manual,
      loaders: target.kind === 'mod' ? modrinthLoaders(inst.cfg, 'mod') : [],
      gameVersion: inst.cfg.version,
      kind: target.kind,
      present,
      // Files the user downloads later land after this request: each records itself.
      onInstalled: async (f) => {
        const r = await loadRegistry(inst.dir);
        Object.assign(reg, r);
        await onInstalled(f);
        await saveRegistry(inst.dir, reg);
      },
    });
  } else if (source === 'hangar') {
    result = await installHangar(id, { paths: ctx.paths, dir, gameVersion: inst.cfg.version, present, onInstalled });
  } else {
    result = await installSpiget(id, { paths: ctx.paths, dir, gameVersion: inst.cfg.version, present, onInstalled });
  }
  await saveRegistry(inst.dir, reg);
  if (result.installed.length) inst.pushLog('system', `${t('Installed: {list}', { list: result.installed.join(', ') })}${inst.running ? ` – ${t('takes effect after a restart.')}` : ''}`);
  if (result.manual?.length) inst.pushLog('system', t('Waiting for a manual download from CurseForge: {list}', { list: result.manual.map((m) => m.title).join(', ') }));
  return result;
}

/** Updates one file (or all with an update) to the newest Modrinth version. Old jars go to the trash. */
export async function updateContent(inst: ServerInstance, ctx: ContentContext, only?: { folder: string; file: string }): Promise<string[]> {
  requireStopped(inst, t('jars'));
  const items = await checkUpdates(inst, await listInstalled(inst));
  const todo = items.filter((i) => i.update && (!only || (i.folder === only.folder && i.file === only.file)));
  const done: string[] = [];
  for (const item of todo) {
    const target = targetFor(inst.cfg, item.folder);
    const reg = await loadRegistry(inst.dir);
    const wasDisabled = !item.enabled;
    await trashJar(inst, ctx.trashDir, item.folder, item.file, reg);
    await saveRegistry(inst.dir, reg);
    const result = await installModrinth(item.projectId!, {
      paths: ctx.paths,
      dir: path.join(inst.dir, item.folder),
      loaders: modrinthLoaders(inst.cfg, target.kind),
      gameVersion: inst.cfg.version,
      present: new Set(),
      onInstalled: async (f) => {
        const r = await loadRegistry(inst.dir);
        r[regKey(item.folder, f.file)] = { source: 'modrinth', projectId: f.projectId, versionId: f.versionId, versionNumber: f.versionNumber, title: f.title, iconUrl: f.iconUrl };
        await saveRegistry(inst.dir, r);
      },
    });
    if (wasDisabled && result.installed[0]) await rename(path.join(inst.dir, item.folder, result.installed[0]), path.join(inst.dir, item.folder, `${result.installed[0]}.disabled`));
    done.push(`${item.name} → ${item.update!.versionNumber}`);
  }
  if (done.length) inst.pushLog('system', t('Updated: {list}', { list: done.join(', ') }));
  return done;
}

export async function setEnabled(inst: ServerInstance, folder: string, file: string, enabled: boolean): Promise<void> {
  requireStopped(inst, t('jars'));
  targetFor(inst.cfg, folder);
  checkFile(file);
  const base = file.replace(/\.disabled$/, '');
  const from = path.join(inst.dir, folder, file);
  const to = path.join(inst.dir, folder, enabled ? base : `${base}.disabled`);
  if (from !== to) await rename(from, to);
}

export async function removeContent(inst: ServerInstance, ctx: ContentContext, folder: string, file: string): Promise<void> {
  requireStopped(inst, t('jars'));
  targetFor(inst.cfg, folder);
  checkFile(file);
  const reg = await loadRegistry(inst.dir);
  await trashJar(inst, ctx.trashDir, folder, file, reg);
  await saveRegistry(inst.dir, reg);
}

const LOADER_NAMES: Record<string, string> = { bukkit: 'Bukkit/Paper', paper: 'Paper', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** Checks a manually uploaded jar against the server before it is kept. Throws with a readable reason. */
export function checkUploadedJar(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build'>, target: ContentTarget, meta: JarMeta): void {
  if (meta.kind === 'unknown') throw new UserError(t('This jar does not look like a plugin or a mod (no plugin.yml / fabric.mod.json / mods.toml).'));
  if (meta.clientOnly) throw new UserError(t('{name} is client-only – the server does not need it.', { name: meta.name ?? t('This mod') }));
  if (meta.kind !== target.kind) {
    throw new UserError(target.kind === 'plugin' ? t('This is a mod for {loader}, plugins go here.', { loader: LOADER_NAMES[meta.loaders[0]!] ?? '' }) : t('This is a plugin, mods go here.'));
  }
  if (target.kind === 'mod') {
    const want = modrinthLoaders(cfg, 'mod');
    if (!meta.loaders.some((l) => want.includes(l))) throw new UserError(t('This mod is for {loader}, the server runs {server}.', { loader: LOADER_NAMES[meta.loaders[0]!] ?? '', server: LOADER_NAMES[want[0]!] ?? want[0] ?? '' }));
  }
}
