// Who may join: only paid accounts (online-mode), paid and unpaid with a password (an auth plugin/mod), or anyone.
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthMode, AuthState, ServerConfig } from '@srvmc/shared';
import { effectiveType, listInstalled, type ContentContext } from './content.ts';
import type { ServerInstance } from './instance.ts';
import { readServerProperties, updateServerProperties } from './properties.ts';
import { UserError } from './providers/types.ts';
import { loginSupported } from './login/service.ts';
import { t } from '@srvmc/shared';

interface AuthStack {
  folder: 'plugins' | 'mods';
  /** Modrinth project ids, installed in this order. */
  projects: string[];
}

// AuthMe Reloaded checks paid accounts itself (premium bypass) but needs PacketEvents for the handshake.
const AUTHME = '9js4IEHC';
const PACKETEVENTS = 'HYKaKraK';
// EasyAuth logs paid accounts in automatically.
const EASYAUTH = 'aZj58GfX';
const AUTH_PROJECTS = new Set([AUTHME, PACKETEVENTS, EASYAUTH]);

export function authStack(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build'>): AuthStack | null {
  switch (effectiveType(cfg)) {
    case 'paper':
    case 'purpur':
    case 'spigot':
      return { folder: 'plugins', projects: [PACKETEVENTS, AUTHME] };
    case 'fabric':
    case 'quilt':
      return { folder: 'mods', projects: [EASYAUTH] };
    default:
      return null;
  }
}

/**
 * Sets `key: value` directly under a top-level `section:` of a YAML file, keeping everything else.
 * Enough for the flat config files plugins write; not a general YAML editor.
 */
export function setYamlValue(text: string, section: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${section}:\\s*(#.*)?$`).test(l));
  if (start < 0) {
    const body = text.replace(/\s*$/, '');
    return `${body ? body + eol : ''}${section}:${eol}  ${key}: ${value}${eol}`;
  }
  let end = start + 1;
  let indent: string | undefined;
  for (; end < lines.length; end++) {
    const l = lines[end]!;
    if (l.trim() === '') continue;
    const m = /^(\s+)\S/.exec(l);
    if (!m) break;
    if (indent === undefined && !l.trim().startsWith('#')) indent = m[1];
  }
  indent ??= '  ';
  const own = new RegExp(`^${indent}${key}:`);
  for (let i = start + 1; i < end; i++) {
    if (own.test(lines[i]!)) {
      lines[i] = `${indent}${key}: ${value}`;
      return lines.join(eol);
    }
  }
  lines.splice(start + 1, 0, `${indent}${key}: ${value}`);
  return lines.join(eol);
}

const exists = (p: string) => access(p).then(
  () => true,
  () => false,
);

/** Auth jars on the server, by project, with whether they are switched on. */
async function authJars(inst: ServerInstance): Promise<{ projectId: string; folder: string; file: string; enabled: boolean }[]> {
  const stack = authStack(inst.cfg);
  if (!stack) return [];
  const items = await listInstalled(inst);
  return items
    .filter((i) => i.folder === stack.folder && i.projectId && AUTH_PROJECTS.has(i.projectId))
    .map((i) => ({ projectId: i.projectId!, folder: i.folder, file: i.file, enabled: i.enabled }));
}

export async function getAuthState(inst: ServerInstance): Promise<AuthState> {
  const supported = loginSupported(inst.cfg);
  const props = await readServerProperties(inst.dir);
  if (props.values.get('online-mode') !== 'false') return { mode: 'online', hybridSupported: supported };
  return { mode: supported && inst.cfg.srvmcLogin ? 'hybrid' : 'offline', hybridSupported: supported };
}

async function setJarEnabled(inst: ServerInstance, folder: string, file: string, enabled: boolean): Promise<void> {
  const base = file.replace(/.disabled$/, '');
  const from = path.join(inst.dir, folder, file);
  const to = path.join(inst.dir, folder, enabled ? base : `${base}.disabled`);
  if (from !== to && (await exists(from))) await rename(from, to);
}

/** Behind a proxy the proxy checks accounts; a password plugin would ask everyone to register. Returns whether any was on. */
export async function switchOffAuthPlugins(inst: ServerInstance): Promise<boolean> {
  const on = (await authJars(inst)).filter((j) => j.enabled);
  for (const jar of on) await setJarEnabled(inst, jar.folder, jar.file, false);
  const wasLogin = !!inst.cfg.srvmcLogin;
  if (wasLogin) {
    inst.cfg.srvmcLogin = false;
    inst.emit('persist');
  }
  return on.length > 0 || wasLogin;
}

export async function setAuthMode(inst: ServerInstance, _ctx: ContentContext, mode: AuthMode): Promise<AuthState> {
  if (inst.running) throw new UserError(t('Stop the server first – the login mode changes only while it is stopped.'));
  if (inst.cfg.behindProxy) throw new UserError(t('The server is behind a proxy – the proxy checks player accounts.'));
  if (mode === 'hybrid' && !loginSupported(inst.cfg)) throw new UserError(t('Password login works on Java servers only.'));
  // srvMC Login replaces the older auth plugins (AuthMe, EasyAuth); one left on would ask for a second password.
  for (const jar of await authJars(inst)) if (jar.enabled) await setJarEnabled(inst, jar.folder, jar.file, false);
  inst.cfg.srvmcLogin = mode === 'hybrid' || undefined;
  inst.emit('persist');
  // Unpaid clients cannot sign chat messages, so a server that lets them in must not demand signatures.
  const online = mode === 'online' ? 'true' : 'false';
  await updateServerProperties(inst.dir, { 'online-mode': online, 'enforce-secure-profile': online });
  inst.pushLog('system', t({ online: 'Login: paid accounts only.', hybrid: 'Login: paid and unpaid accounts with a password.', offline: 'Login: anyone, unchecked.' }[mode]));
  return getAuthState(inst);
}
