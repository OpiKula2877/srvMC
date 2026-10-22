// One-click add-ons: Geyser + Floodgate (Bedrock players on a Java server) and BlueMap (web map).
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bedrockUdpRange, editionOf, type AddonId, type AddonState, type ServerType } from '@srvmc/shared';
import { effectiveType, installContent, removeContent, type ContentContext } from './content.ts';
import { downloadToCache } from './download.ts';
import { fetchJson } from './http.ts';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import { isPortFree, isUdpPortFree } from './net.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';

const GEYSER_API = 'https://download.geysermc.org/v2/projects';
// Floodgate for mod loaders lives on Modrinth; Fabric servers also need Fabric API.
const FLOODGATE_MODRINTH = 'bWrNNfkb';
const FABRIC_API = 'P7dR8mSH';
const BLUEMAP = 'swbUV1cr';
const PROXIED_GEYSER = 'Server je za proxy – crossplay zapni u proxy, Bedrock hráči přijdou přes ni.';

interface GeyserTarget {
  platform: 'spigot' | 'fabric' | 'neoforge' | 'velocity';
  folder: 'plugins' | 'mods';
}

export function geyserTarget(type: ServerType): GeyserTarget | null {
  switch (type) {
    case 'paper':
    case 'purpur':
    case 'spigot':
      return { platform: 'spigot', folder: 'plugins' };
    case 'velocity':
      return { platform: 'velocity', folder: 'plugins' };
    case 'fabric':
      return { platform: 'fabric', folder: 'mods' };
    case 'neoforge':
      return { platform: 'neoforge', folder: 'mods' };
    default:
      return null;
  }
}

/** BlueMap keeps its config next to plugins on Bukkit-family servers, under config/ on mod loaders. */
export function bluemapConfigDir(type: ServerType): string | null {
  if (type === 'paper' || type === 'purpur' || type === 'spigot') return 'plugins/BlueMap';
  if (type === 'fabric' || type === 'quilt' || type === 'forge' || type === 'neoforge') return 'config/bluemap';
  return null;
}

/** HOCON "key: value" at the top level of a BlueMap .conf file. */
export function setConf(text: string, key: string, value: string): string {
  const re = new RegExp(`^(\\s*${key}\\s*[:=]\\s*).*$`, 'm');
  return re.test(text) ? text.replace(re, `$1${value}`) : `${text.replace(/\s*$/, '')}\n${key}: ${value}\n`;
}

export function confValue(text: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*[:=]\\s*"?([^"\\s#]+)`, 'm').exec(text)?.[1];
}

async function files(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

/** Downloads a Geyser or Floodgate jar for a platform from GeyserMC, checked by SHA-256. */
async function geyserMcJar(paths: Paths, project: 'geyser' | 'floodgate', platform: string, dir: string): Promise<string> {
  const build = await fetchJson<{ version: string; build: number; downloads: Record<string, { name: string; sha256: string }> }>(`${GEYSER_API}/${project}/versions/latest/builds/latest`);
  const dl = build.downloads[platform];
  if (!dl) throw new UserError(`${project === 'geyser' ? 'Geyser' : 'Floodgate'} pro ${platform} neexistuje.`);
  const url = `${GEYSER_API}/${project}/versions/${build.version}/builds/${build.build}/downloads/${platform}`;
  const cached = await downloadToCache(paths, { url, fileName: dl.name, sha256: dl.sha256 });
  await mkdir(dir, { recursive: true });
  await copyFile(cached, path.join(dir, dl.name));
  return dl.name;
}

export class AddonService {
  constructor(
    private readonly manager: ServerManager,
    private readonly paths: Paths,
  ) {
    const attach = (inst: ServerInstance) => inst.on('status', () => inst.status === 'running' && void this.settleBluemap(inst));
    for (const inst of manager.all()) attach(inst);
    manager.on('added', attach);
  }

  private ctx(inst: ServerInstance): ContentContext {
    return { paths: this.paths, trashDir: path.join(this.paths.trash, inst.cfg.id) };
  }

  private async geyserJars(inst: ServerInstance): Promise<string[]> {
    const t = geyserTarget(effectiveType(inst.cfg));
    if (!t) return [];
    return (await files(path.join(inst.dir, t.folder))).filter((f) => /^(Geyser-|floodgate)[^/]*\.jar$/i.test(f));
  }

  private async bluemapJar(inst: ServerInstance): Promise<string | undefined> {
    const type = effectiveType(inst.cfg);
    const folder = type === 'paper' || type === 'purpur' || type === 'spigot' ? 'plugins' : 'mods';
    return (await files(path.join(inst.dir, folder))).find((f) => /^bluemap.*\.jar$/i.test(f));
  }

  async list(id: string): Promise<AddonState[]> {
    const inst = this.manager.get(id);
    const type = effectiveType(inst.cfg);
    const t = geyserTarget(type);
    const geyserInstalled = (await this.geyserJars(inst)).some((f) => /^Geyser-/i.test(f));
    const bmDir = bluemapConfigDir(type);
    const bmInstalled = !!(await this.bluemapJar(inst));
    const core = bmDir ? await read(path.join(inst.dir, bmDir, 'core.conf')) : null;
    const notJava = editionOf(inst.cfg.type) !== 'java' ? (editionOf(inst.cfg.type) === 'bedrock' ? 'Bedrock server hráče z Bedrocku obslouží sám.' : 'Pro Hytale to nejde.') : undefined;
    // Behind a proxy the server only lets in the proxy, so Bedrock players come through Geyser on the proxy.
    const proxied = !!inst.cfg.behindProxy;
    return [
      {
        id: 'geyser',
        supported: !!t && (!proxied || geyserInstalled),
        ...(!t && { reason: notJava ?? 'Geyser běží na Paperu, Purpuru, Spigotu, Fabricu, NeoForge a Velocity.' }),
        ...(t && proxied && { reason: PROXIED_GEYSER }),
        installed: geyserInstalled,
        ...(geyserInstalled && inst.cfg.geyserPort && { port: inst.cfg.geyserPort }),
      },
      {
        id: 'bluemap',
        supported: !!bmDir,
        ...(!bmDir && { reason: notJava ?? 'BlueMap běží na Paperu, Purpuru, Spigotu, Fabricu, Quiltu, Forge a NeoForge.' }),
        installed: bmInstalled,
        ...(bmInstalled && inst.cfg.bluemapPort && { port: inst.cfg.bluemapPort, url: `http://localhost:${inst.cfg.bluemapPort}` }),
        ...(bmInstalled && !core && { pendingStart: true }),
        ...(bmInstalled && core !== null && confValue(core, 'accept-download') !== 'true' && { needsConsent: true }),
      },
    ];
  }

  /** A port for Geyser free over both TCP (NetherNet signaling) and UDP (gameplay): no server, Bedrock UDP block or other program on it. */
  private async freeGeyserPort(self: ServerInstance): Promise<number> {
    const used = new Set<number>([self.cfg.port]);
    for (const i of this.manager.all()) {
      if (i === self) continue;
      used.add(i.cfg.port);
      if (i.cfg.geyserPort) used.add(i.cfg.geyserPort);
      if (i.cfg.bluemapPort) used.add(i.cfg.bluemapPort);
      if (editionOf(i.cfg.type) === 'bedrock') {
        const [a, b] = bedrockUdpRange(i.cfg.port);
        for (let p = a; p <= b; p++) used.add(p);
      }
    }
    for (let p = 19132; p < 19132 + 2000; p++) if (!used.has(p) && (await isUdpPortFree(p)) && (await isPortFree(p))) return p;
    throw new UserError('Nenašel jsem volný port pro Geyser.');
  }

  private async freeBluemapPort(self: ServerInstance): Promise<number> {
    const used = new Set(this.manager.all().filter((i) => i !== self).flatMap((i) => [i.cfg.port, i.cfg.bluemapPort ?? 0]));
    for (let p = 8100; p < 8400; p++) if (!used.has(p) && (await isPortFree(p))) return p;
    throw new UserError('Nenašel jsem volný port pro mapu.');
  }

  async install(id: string, addon: AddonId): Promise<AddonState[]> {
    const inst = this.manager.get(id);
    if (inst.running) throw new UserError('Nejdřív server zastav – za běhu má Windows jary zamčené.');
    const type = effectiveType(inst.cfg);
    if (addon === 'geyser') {
      const t = geyserTarget(type);
      if (!t) throw new UserError('Geyser se pro tenhle server nehodí.');
      if (inst.cfg.behindProxy) throw new UserError(PROXIED_GEYSER);
      const dir = path.join(inst.dir, t.folder);
      const installed: string[] = [await geyserMcJar(this.paths, 'geyser', t.platform, dir)];
      // Floodgate lets Bedrock players in without a Java account (online-mode servers).
      if (t.platform === 'spigot' || t.platform === 'velocity') installed.push(await geyserMcJar(this.paths, 'floodgate', t.platform, dir));
      else {
        const r = await installContent(inst, this.ctx(inst), 'modrinth', FLOODGATE_MODRINTH, 'mods').catch((err: Error) => {
          if (/už je nainstalované/.test(err.message)) return { installed: [], skipped: [] };
          throw err;
        });
        installed.push(...r.installed);
        if (t.platform === 'fabric') await installContent(inst, this.ctx(inst), 'modrinth', FABRIC_API, 'mods').catch(() => undefined);
      }
      const port = inst.cfg.geyserPort ?? (await this.freeGeyserPort(inst));
      // The port and NetherNet go to Geyser as start arguments (see buildJvmArgs), so its config stays untouched.
      await this.manager.saveConfig(id, (cfg) => {
        cfg.geyserPort = port;
      });
      inst.pushLog('system', `Crossplay: nainstalováno ${installed.join(', ')}. Bedrock hráči se připojí na port ${port} (TCP i UDP).`);
    } else {
      if (!bluemapConfigDir(type)) throw new UserError('BlueMap se pro tenhle server nehodí.');
      const folder = type === 'paper' || type === 'purpur' || type === 'spigot' ? 'plugins' : 'mods';
      await installContent(inst, this.ctx(inst), 'modrinth', BLUEMAP, folder);
      const port = inst.cfg.bluemapPort ?? (await this.freeBluemapPort(inst));
      await this.manager.saveConfig(id, (cfg) => {
        cfg.bluemapPort = port;
      });
      await this.applyBluemap(inst);
    }
    this.manager.emit('files-changed', id);
    this.manager.emit('configured', id);
    return this.list(id);
  }

  async remove(id: string, addon: AddonId): Promise<AddonState[]> {
    const inst = this.manager.get(id);
    const type = effectiveType(inst.cfg);
    if (addon === 'geyser') {
      const t = geyserTarget(type);
      for (const f of await this.geyserJars(inst)) await removeContent(inst, this.ctx(inst), t!.folder, f);
      await this.manager.saveConfig(id, (cfg) => {
        cfg.geyserPort = undefined;
      });
    } else {
      const jar = await this.bluemapJar(inst);
      const folder = type === 'paper' || type === 'purpur' || type === 'spigot' ? 'plugins' : 'mods';
      if (jar) await removeContent(inst, this.ctx(inst), folder, jar);
      await this.manager.saveConfig(id, (cfg) => {
        cfg.bluemapPort = undefined;
      });
    }
    this.manager.emit('configured', id);
    return this.list(id);
  }

  /** The owner agrees that BlueMap downloads the Minecraft client's resources from Mojang. */
  async consent(id: string): Promise<AddonState[]> {
    const inst = this.manager.get(id);
    const dir = bluemapConfigDir(effectiveType(inst.cfg));
    const file = dir && path.join(inst.dir, dir, 'core.conf');
    const text = file ? await read(file) : null;
    if (!file || text === null) throw new UserError('BlueMap si nastavení vytvoří při prvním startu serveru. Spusť server a pak to potvrď.');
    await writeFile(file, setConf(text, 'accept-download', 'true'), 'utf8');
    if (inst.status === 'running') {
      inst.sendCommand('bluemap reload');
      void this.settleBluemap(inst);
    }
    inst.pushLog('system', 'BlueMap: stažení zdrojů hry povoleno. Mapa se vykresluje na pozadí.');
    return this.list(id);
  }


  /** Puts the map's port into webserver.conf; false while BlueMap has not written that file yet. */
  private async applyBluemap(inst: ServerInstance): Promise<boolean> {
    const dir = bluemapConfigDir(effectiveType(inst.cfg));
    const port = inst.cfg.bluemapPort;
    if (!dir || !port) return true;
    const file = path.join(inst.dir, dir, 'webserver.conf');
    const text = await read(file);
    if (text === null) return false;
    if (confValue(text, 'port') === String(port)) return true;
    await writeFile(file, setConf(text, 'port', String(port)), 'utf8');
    if (inst.status === 'running') inst.sendCommand('bluemap reload');
    return true;
  }

  /** BlueMap writes webserver.conf only after the download consent, and loads after the server is up; the port follows once it does. */
  private async settleBluemap(inst: ServerInstance): Promise<void> {
    for (let i = 0; i < 60 && inst.status === 'running'; i++) {
      if (await this.applyBluemap(inst).catch(() => true)) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
