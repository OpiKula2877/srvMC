// A Velocity network: servers behind the proxy get modern forwarding (Paper/Purpur via
// paper-global.yml, Fabric/Quilt via FabricProxy-Lite), offline mode and a loopback-only address,
// so players reach them only through the proxy, which checks their accounts.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type ProxyBackend, type ProxyState, type ServerType } from '@srvmc/shared';
import { switchOffAuthPlugins } from './auth.ts';
import { effectiveType, installContent, removeContent, type ContentContext } from './content.ts';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import type { Paths } from './paths.ts';
import { updateServerProperties } from './properties.ts';
import { UserError } from './providers/types.ts';
import { forwardingSecret, replaceTomlTable, serversTable, setTomlKey } from './providers/velocity.ts';

const FABRIC_PROXY_LITE = '8dI2tmqs';
const ALIAS_RE = /^[a-z0-9_-]{1,32}$/;

type Method = 'paper' | 'fabric';

export function forwardingMethod(type: ServerType): Method | null {
  if (type === 'paper' || type === 'purpur') return 'paper';
  if (type === 'fabric' || type === 'quilt') return 'fabric';
  return null;
}

function unsupportedReason(type: ServerType): string {
  if (type === 'spigot') return 'Spigot umí jen starý způsob přeposílání. Použij Paper.';
  if (type === 'forge' || type === 'neoforge' || type === 'arclight') return 'Forge a NeoForge za Velocity zatím nepropojím.';
  if (type === 'vanilla') return 'Vanilla server za proxy nejde (potřebuje Paper nebo Fabric).';
  return 'Za proxy jde jen server Minecraft Java (Paper, Purpur, Fabric, Quilt).';
}

/** Turns a server name into a Velocity server alias ("Survival s kamarády" → "survival-s-kamarady"). */
export function aliasFor(name: string): string {
  const a = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return a || 'server';
}

/**
 * Sets a nested YAML value ("proxies.velocity.secret") keeping the rest of the file. Missing
 * sections are added. Enough for Paper's config files; not a general YAML editor.
 */
export function setYamlPath(text: string, keys: string[], value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  let from = 0;
  let to = lines.length;
  let indent = '';
  for (let depth = 0; depth < keys.length; depth++) {
    const key = keys[depth]!;
    const last = depth === keys.length - 1;
    // Children of the current block share its first child's indentation.
    let childIndent = depth === 0 ? '' : undefined;
    for (let i = from; i < to && childIndent === undefined; i++) {
      const m = /^(\s*)\S/.exec(lines[i]!);
      if (m && !lines[i]!.trim().startsWith('#')) childIndent = m[1];
    }
    childIndent ??= `${indent}  `;
    let found = -1;
    for (let i = from; i < to; i++) {
      if (lines[i]!.startsWith(`${childIndent}${key}:`) && !/^\s/.test(lines[i]!.slice(childIndent.length))) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      // Add the missing tail of the path at the start of the block.
      const add = keys.slice(depth).map((k, j) => `${childIndent}${'  '.repeat(j)}${k}:${j === keys.length - depth - 1 ? ` ${value}` : ''}`);
      lines.splice(from, 0, ...add);
      return lines.join(eol);
    }
    if (last) {
      lines[found] = `${childIndent}${key}: ${value}`;
      return lines.join(eol);
    }
    // The block of this key: following lines indented deeper than it.
    let end = found + 1;
    while (end < to && (lines[end]!.trim() === '' || lines[end]!.trim().startsWith('#') || /^(\s*)/.exec(lines[end]!)![1]!.length > childIndent.length)) end++;
    from = found + 1;
    to = end;
    indent = childIndent;
  }
  return lines.join(eol);
}

export class ProxyService {
  constructor(
    private readonly manager: ServerManager,
    private readonly paths: Paths,
  ) {
    manager.on('configured', (id: string) => {
      const inst = manager.get(id);
      if (inst.cfg.type === 'velocity') void this.writeVelocity(inst).catch(() => undefined);
    });
  }

  private ctx(inst: ServerInstance): ContentContext {
    return { paths: this.paths, trashDir: path.join(this.paths.trash, inst.cfg.id) };
  }

  private proxyOf(id: string): ServerInstance {
    const inst = this.manager.get(id);
    if (inst.cfg.type !== 'velocity') throw new UserError('Tohle není Velocity server.');
    return inst;
  }

  async state(id: string): Promise<ProxyState> {
    const proxy = this.proxyOf(id);
    const linked = new Map((proxy.cfg.proxy?.servers ?? []).map((s) => [s.id, s.alias]));
    const backends: ProxyBackend[] = this.manager
      .all()
      .filter((i) => i.cfg.type !== 'velocity')
      .map((i) => {
        const type = effectiveType(i.cfg);
        const method = forwardingMethod(type);
        const other = i.cfg.behindProxy && i.cfg.behindProxy !== id ? this.manager.all().find((p) => p.cfg.id === i.cfg.behindProxy)?.cfg.name : undefined;
        return {
          id: i.cfg.id,
          name: i.cfg.name,
          type: i.cfg.type,
          port: i.cfg.port,
          alias: linked.get(i.cfg.id),
          linked: linked.has(i.cfg.id),
          supported: !!method,
          ...(!method && { reason: unsupportedReason(type) }),
          ...(other && { elsewhere: other }),
        };
      });
    const toml = await readFile(path.join(proxy.dir, 'velocity.toml'), 'utf8').catch(() => null);
    return { backends, pendingStart: toml === null };
  }

  /** Links the listed servers (in this order) behind the proxy and unlinks the rest. */
  async save(id: string, wanted: { id: string; alias?: string }[]): Promise<ProxyState> {
    const proxy = this.proxyOf(id);
    const before = new Set((proxy.cfg.proxy?.servers ?? []).map((s) => s.id));
    const next: { id: string; alias: string }[] = [];
    const aliases = new Set<string>();
    for (const w of wanted) {
      const b = this.manager.get(w.id);
      if (b.cfg.type === 'velocity') throw new UserError('Proxy nejde dát za jinou proxy.');
      if (!forwardingMethod(effectiveType(b.cfg))) throw new UserError(`${b.cfg.name}: ${unsupportedReason(effectiveType(b.cfg))}`);
      if (b.cfg.behindProxy && b.cfg.behindProxy !== id) throw new UserError(`${b.cfg.name} už je za jinou proxy.`);
      let alias = (w.alias?.trim() || aliasFor(b.cfg.name)).toLowerCase();
      if (!ALIAS_RE.test(alias)) throw new UserError('Název serveru v síti smí mít jen malá písmena, číslice, - a _.');
      for (let n = 2; aliases.has(alias); n++) alias = `${alias.replace(/-\d+$/, '')}-${n}`;
      aliases.add(alias);
      next.push({ id: b.cfg.id, alias });
    }
    const changing = [...next.filter((s) => !before.has(s.id)), ...[...before].filter((b) => !next.some((s) => s.id === b)).map((b) => ({ id: b }))];
    const running = changing.map((c) => this.manager.get(c.id)).filter((i) => i.running);
    if (running.length) throw new UserError(`Nejdřív zastav ${running.map((i) => i.cfg.name).join(', ')} – nastavení se mění u vypnutého serveru.`);

    const secret = await forwardingSecret(proxy.dir);
    for (const s of next) if (!before.has(s.id)) await this.link(this.manager.get(s.id), id, secret);
    for (const b of before) if (!next.some((s) => s.id === b)) await this.unlink(this.manager.get(b));
    await this.manager.saveConfig(id, (cfg) => {
      cfg.proxy = next.length ? { servers: next } : undefined;
    });
    await this.writeVelocity(proxy);
    if (proxy.status === 'running') proxy.sendCommand('velocity reload');
    return this.state(id);
  }

  /** velocity.toml: the proxy's port and the [servers] list (written once Velocity created the file). */
  private async writeVelocity(proxy: ServerInstance): Promise<void> {
    const file = path.join(proxy.dir, 'velocity.toml');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return;
    const servers = (proxy.cfg.proxy?.servers ?? []).map((s) => ({ alias: s.alias, port: this.manager.get(s.id).cfg.port }));
    let t = setTomlKey(text, 'bind', `"0.0.0.0:${proxy.cfg.port}"`);
    t = setTomlKey(t, 'player-info-forwarding-mode', '"modern"');
    t = replaceTomlTable(t, 'servers', serversTable(servers));
    if (t !== text) await writeFile(file, t, 'utf8');
  }

  private async link(b: ServerInstance, proxyId: string, secret: string): Promise<void> {
    const method = forwardingMethod(effectiveType(b.cfg))!;
    // Only the proxy may reach it: loopback address, no own account check (the proxy does that).
    await updateServerProperties(b.dir, { 'online-mode': 'false', 'server-ip': '127.0.0.1' });
    if (method === 'paper') {
      const file = path.join(b.dir, 'config', 'paper-global.yml');
      let text = await readFile(file, 'utf8').catch(() => '');
      text = setYamlPath(text, ['proxies', 'velocity', 'enabled'], 'true');
      text = setYamlPath(text, ['proxies', 'velocity', 'online-mode'], 'true');
      text = setYamlPath(text, ['proxies', 'velocity', 'secret'], `'${secret}'`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    } else {
      const mods = await readdir(path.join(b.dir, 'mods')).catch(() => [] as string[]);
      if (!mods.some((m) => /^FabricProxy-Lite/i.test(m))) await installContent(b, this.ctx(b), 'modrinth', FABRIC_PROXY_LITE, 'mods');
      const file = path.join(b.dir, 'config', 'FabricProxy-Lite.toml');
      const text = await readFile(file, 'utf8').catch(() => 'hackOnlineMode = true\n');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, setTomlKey(text, 'secret', `"${secret}"`), 'utf8');
    }
    const hadPasswords = await switchOffAuthPlugins(b);
    await this.manager.saveConfig(b.cfg.id, (cfg) => {
      cfg.behindProxy = proxyId;
    });
    b.pushLog('system', 'Server je za Velocity proxy: hráči se připojují přes proxy, přímo už ne.');
    if (hadPasswords) b.pushLog('system', 'Přihlašování heslem je vypnuté – účty hráčů teď ověřuje proxy.');
  }

  private async unlink(b: ServerInstance): Promise<void> {
    await updateServerProperties(b.dir, { 'online-mode': 'true', 'server-ip': '' });
    if (forwardingMethod(effectiveType(b.cfg)) === 'paper') {
      const file = path.join(b.dir, 'config', 'paper-global.yml');
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text !== null) await writeFile(file, setYamlPath(text, ['proxies', 'velocity', 'enabled'], 'false'), 'utf8');
    } else {
      // FabricProxy-Lite turns away anyone who does not come through a proxy.
      for (const m of await readdir(path.join(b.dir, 'mods')).catch(() => [] as string[])) if (/^FabricProxy-Lite/i.test(m)) await removeContent(b, this.ctx(b), 'mods', m);
    }
    await this.manager.saveConfig(b.cfg.id, (cfg) => {
      cfg.behindProxy = undefined;
    });
    b.pushLog('system', 'Server už není za proxy: hráči se připojují přímo.');
  }

  /** A server leaving the network (deleted) is dropped from its proxy; a deleted proxy frees its servers. */
  async forget(id: string): Promise<void> {
    for (const b of this.manager.all().filter((i) => i.cfg.behindProxy === id)) {
      await this.manager.saveConfig(b.cfg.id, (cfg) => {
        cfg.behindProxy = undefined;
      });
      b.pushLog('warn', 'Proxy tohoto serveru byla smazána. Server má dál offline režim a adresu jen pro tento počítač – uprav to v Možnostech.');
    }
    for (const p of this.manager.all().filter((i) => i.cfg.type === 'velocity' && i.cfg.proxy?.servers.some((s) => s.id === id))) {
      await this.manager.saveConfig(p.cfg.id, (cfg) => {
        const rest = cfg.proxy!.servers.filter((s) => s.id !== id);
        cfg.proxy = rest.length ? { servers: rest } : undefined;
      });
      await this.writeVelocity(p);
    }
  }
}
