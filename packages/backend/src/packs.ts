// Modpack files from CurseForge and Technic: unpacking, finding out which loader a pack runs on,
// copying only what a server uses, and dropping mods that belong in the game client only.
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import type { ServerType } from '@srvmc/shared';
import { hashFile } from './download.ts';
import { readJarEntries, readJarMeta } from './jarmeta.ts';
import { getProjects, identifyHashes } from './modrinth.ts';

export interface PackLoader {
  type: Extract<ServerType, 'forge' | 'neoforge' | 'fabric' | 'quilt'>;
  /** The build id our providers use (Forge: "<mc>-<forge>"). */
  build: string;
  mc: string;
}

/** CurseForge's manifest names the loader as "forge-47.2.0", "neoforge-21.1.77", "fabric-0.16.9"… */
export function manifestLoader(mc: string, id: string): PackLoader | null {
  const m = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id.trim());
  if (!m) return null;
  const type = m[1]!.toLowerCase() as PackLoader['type'];
  let version = m[2]!;
  // Old NeoForge for 1.20.1 is published as "neoforge-1.20.1-47.1.x" (a Forge fork).
  if (type === 'forge') return { type, build: version.startsWith(`${mc}-`) ? version : `${mc}-${version}`, mc };
  if (type === 'neoforge' && version.startsWith(`${mc}-`)) version = version.slice(mc.length + 1);
  return { type, build: version, mc };
}

/** Reads a launcher version.json (Technic's bin/version.json or the one inside bin/modpack.jar). */
export function versionJsonLoader(text: string): PackLoader | null {
  let json: { id?: string; inheritsFrom?: string; libraries?: { name?: string }[] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return null;
  }
  for (const lib of json.libraries ?? []) {
    const name = lib.name ?? '';
    let m = /^net\.minecraftforge:(?:forge|minecraftforge):(\d+\.\d+(?:\.\d+)?)-([\w.-]+)$/.exec(name);
    if (m) return { type: 'forge', build: `${m[1]}-${m[2]}`, mc: m[1]! };
    m = /^net\.neoforged:neoforge:([\w.-]+)$/.exec(name);
    if (m && json.inheritsFrom) return { type: 'neoforge', build: m[1]!, mc: json.inheritsFrom };
    m = /^net\.fabricmc:fabric-loader:([\w.+-]+)$/.exec(name);
    if (m && json.inheritsFrom) return { type: 'fabric', build: m[1]!, mc: json.inheritsFrom };
    m = /^org\.quiltmc:quilt-loader:([\w.+-]+)$/.exec(name);
    if (m && json.inheritsFrom) return { type: 'quilt', build: m[1]!, mc: json.inheritsFrom };
  }
  // 1.7.10 style ids: "1.7.10-Forge10.13.4.1614-1.7.10".
  const id = /^(\d+\.\d+(?:\.\d+)?)-forge-?(?:\d+\.\d+(?:\.\d+)?-)?([\d.]+)/i.exec(json.id ?? '');
  if (id) return { type: 'forge', build: `${id[1]}-${id[2]}`, mc: id[1]! };
  return null;
}

/** Recognises a loader from file names a server pack carries. */
export function fileNameLoader(rel: string): PackLoader | null {
  const p = rel.replace(/\\/g, '/');
  let m = /(?:^|\/)libraries\/net\/minecraftforge\/forge\/(\d+\.\d+(?:\.\d+)?)-([^/]+)\//.exec(p);
  if (m) return { type: 'forge', build: `${m[1]}-${m[2]}`, mc: m[1]! };
  m = /^(?:minecraft)?forge-(\d+\.\d+(?:\.\d+)?)-([\d.]+(?:-\d+\.\d+(?:\.\d+)?)?)(?:-(?:universal|installer|server))?\.jar$/i.exec(p);
  if (m) return { type: 'forge', build: `${m[1]}-${m[2]}`, mc: m[1]! };
  m = /^minecraftforge-universal-(\d+\.\d+(?:\.\d+)?)-([\d.]+)\.jar$/i.exec(p);
  if (m) return { type: 'forge', build: `${m[1]}-${m[2]}`, mc: m[1]! };
  return null;
}

/** ServerStarter / All the Mods style variables.txt: MINECRAFT_VERSION, MODLOADER, MODLOADER_VERSION. */
export function variablesLoader(text: string): PackLoader | null {
  const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'mi').exec(text)?.[1]?.trim();
  const mc = get('MINECRAFT_VERSION');
  const loader = get('MODLOADER')?.toLowerCase();
  const version = get('MODLOADER_VERSION');
  if (!mc || !loader || !version) return null;
  return manifestLoader(mc, `${loader}-${version}`);
}

async function walk(dir: string, base = dir, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12) return out;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, out, depth + 1);
    else out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

/** Finds out the loader of an unpacked pack: launcher json, ServerStarter variables, or file names. */
export async function detectLoader(dir: string, mcHint?: string): Promise<PackLoader | null> {
  for (const rel of ['bin/version.json', 'version.json']) {
    const text = await readFile(path.join(dir, rel), 'utf8').catch(() => null);
    const l = text && versionJsonLoader(text);
    if (l) return l;
  }
  const jar = path.join(dir, 'bin', 'modpack.jar');
  if (await stat(jar).catch(() => null)) {
    const l = versionJsonLoader((await readJarEntries(jar, new Set(['version.json'])).catch(() => new Map<string, string>())).get('version.json') ?? '');
    if (l) return l;
  }
  const vars = await readFile(path.join(dir, 'variables.txt'), 'utf8').catch(() => null);
  const fromVars = vars && variablesLoader(vars);
  if (fromVars) return fromVars;
  const files = await walk(dir);
  for (const f of files) {
    const l = fileNameLoader(f);
    if (l) return l;
  }
  // Packs rename the Forge jar ("TekkitLegends.jar"); the version.json inside it still tells.
  for (const f of files.filter((x) => /^[^/]+\.jar$/i.test(x) && !/^minecraft_server/i.test(x))) {
    const inner = (await readJarEntries(path.join(dir, f), new Set(['version.json'])).catch(() => new Map<string, string>())).get('version.json');
    const l = inner && versionJsonLoader(inner);
    if (l) return l;
  }
  const neo = files.map((f) => /(?:^|\/)libraries\/net\/neoforged\/neoforge\/([^/]+)\//.exec(f)?.[1]).find(Boolean);
  if (neo) return { type: 'neoforge', build: neo, mc: mcHint ?? '' };
  const fabric = files.map((f) => /(?:^|\/)libraries\/net\/fabricmc\/fabric-loader\/([^/]+)\//.exec(f)?.[1]).find(Boolean);
  const mc = files.map((f) => /(?:^|\/)(?:libraries\/net\/minecraft\/server|versions)\/(\d+\.\d+(?:\.\d+)?)\//.exec(f)?.[1] ?? /^minecraft_server\.(\d+\.\d+(?:\.\d+)?)\.jar$/.exec(f)?.[1]).find(Boolean) ?? mcHint;
  if (fabric && mc) return { type: 'fabric', build: fabric, mc };
  return null;
}

/** The Minecraft version a server pack runs, from its vanilla server jar. */
export async function packGameVersion(dir: string): Promise<string | undefined> {
  const top = await readdir(dir).catch(() => [] as string[]);
  return top.map((f) => /^minecraft_server\.(\d+\.\d+(?:\.\d+)?)\.jar$/.exec(f)?.[1]).find(Boolean);
}

/** Unpacks a zip; a pack wrapped in one top folder is unwrapped. Returns the folder with the content. */
export async function unpack(zip: string, dest: string): Promise<string> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await extractZip(zip, { dir: path.resolve(dest) });
  const top = await readdir(dest, { withFileTypes: true });
  if (top.length === 1 && top[0]!.isDirectory()) return path.join(dest, top[0]!.name);
  return dest;
}

const SCRIPT = /\.(bat|cmd|exe|ps1|sh|vbs|command)$/i;
/** Loader files and launcher leftovers a server pack carries; srvMC installs the loader itself. */
const LOADER_ROOT = /^(libraries|versions|\.fabric|bin|logs|crash-reports|assets)\/|^[^/]*\.(jar|log)$|^(user_jvm_args\.txt|eula\.txt|run\.(bat|sh)|variables\.txt|server-setup-config\.yaml|installer\.log)$/i;
/** Things only the game client uses. */
const CLIENT_ROOT = /^(resourcepacks|resources|shaderpacks|screenshots|saves|texturepacks|journeymap|xaero|schematics|replay_recordings|bin|assets)\/|^(options(of)?\.txt|optionsshaders\.txt|servers\.dat|launcher_profiles\.json|usercache\.json)$/i;

/** Copies a pack's files into the server: no scripts, and for `content` packs no loader files either. */
export async function copyPack(from: string, to: string, mode: 'server' | 'content' | 'client'): Promise<number> {
  let n = 0;
  for (const rel of await walk(from)) {
    if (SCRIPT.test(rel) || rel.split('/').some((s) => s === '..')) continue;
    if (mode !== 'server' && LOADER_ROOT.test(rel)) continue;
    if (mode === 'client' && CLIENT_ROOT.test(rel)) continue;
    const out = path.join(to, ...rel.split('/'));
    await mkdir(path.dirname(out), { recursive: true });
    await cp(path.join(from, ...rel.split('/')), out, { force: true });
    n++;
  }
  return n;
}

/** Mods known to run only in the game client; old ones have no metadata saying so. */
const CLIENT_MOD = /^(optifine|optifabric|custommainmenu|mousetweaks|controlling|defaultoptions|betterfoliage|dynamiclights|xaerominimap|xaeroworldmap|xaeros?_?minimap|xaeros?_?world_?map|voxelmap|inventorytweaks|notenoughkeys|fullscreenwindowed|oculus|iris|sodium|rubidium|embeddium|entityculling|fpsreducer|betterf3|legendarytooltips|toastcontrol|blur|smoothboot|reauth|drippyloadingscreen|fancymenu|ding|catalogue|itemzoom|mcpatcher|fastcraft-client|resourceloader|journeymap-client)[-_ .0-9+]/i;

/**
 * Removes mods the server does not need: declared client-only in the jar, known by name, or marked
 * "server: unsupported" on Modrinth (looked up by hash). They go to the given folder, not away.
 */
export async function dropClientMods(modsDir: string, asideDir: string): Promise<string[]> {
  const jars = (await readdir(modsDir).catch(() => [] as string[])).filter((f) => /\.jar$/i.test(f));
  const drop = new Set<string>();
  for (const f of jars) {
    if (CLIENT_MOD.test(f)) drop.add(f);
    else if ((await readJarMeta(path.join(modsDir, f))).clientOnly) drop.add(f);
  }
  try {
    const rest = jars.filter((f) => !drop.has(f));
    const hashes = await Promise.all(rest.map((f) => hashFile(path.join(modsDir, f), 'sha1')));
    const found = await identifyHashes(hashes);
    const projects = await getProjects([...new Set(Object.values(found).map((v) => v.project_id))]);
    const clientOnly = new Set(projects.filter((p) => p.server_side === 'unsupported').map((p) => p.id));
    rest.forEach((f, i) => {
      const v = found[hashes[i]!];
      if (v && clientOnly.has(v.project_id)) drop.add(f);
    });
  } catch {
    // Without Modrinth only the local checks apply.
  }
  if (drop.size) await mkdir(asideDir, { recursive: true });
  for (const f of drop) await cp(path.join(modsDir, f), path.join(asideDir, f)).then(() => rm(path.join(modsDir, f), { force: true }));
  return [...drop];
}

/** Launch arguments of a server pack used as it is: the jar or args file its start script runs. */
export async function packLaunch(dir: string): Promise<string[] | null> {
  const top = await readdir(dir).catch(() => [] as string[]);
  for (const script of top.filter((f) => /\.(bat|cmd|sh)$/i.test(f)).sort((a, b) => Number(/start|run|server/i.test(b)) - Number(/start|run|server/i.test(a)))) {
    const text = await readFile(path.join(dir, script), 'utf8').catch(() => '');
    const args = /@(libraries\/[^\s"]+(?:win|unix)_args\.txt)/.exec(text);
    const file = args && (process.platform === 'win32' ? args[1]!.replace('unix_args', 'win_args') : args[1]!.replace('win_args', 'unix_args'));
    // The args file exists only when the pack comes with its loader already installed.
    if (file && (await stat(path.join(dir, ...file.split('/'))).catch(() => null))) return [`@${file}`];
    const jar = /-jar\s+"?([\w.+()\[\] -]+?\.jar)"?(?:\s|$)/i.exec(text)?.[1];
    if (jar && top.includes(jar)) return ['-jar', jar];
  }
  const jars = top.filter((f) => /\.jar$/i.test(f) && !/installer/i.test(f));
  const pick = jars.find((f) => /forge|fabric-server|server/i.test(f)) ?? (jars.length === 1 ? jars[0] : undefined);
  return pick ? ['-jar', pick] : null;
}
