// Who may do what: every API request maps to a capability, roles grant capabilities, and
// moderators and starters see only the servers listed on their account.
import type { PanelRole, PanelUser } from '@srvmc/shared';

export type Cap = 'view' | 'power' | 'console' | 'manage' | 'admin' | 'owner';

const ROLE_CAPS: Record<PanelRole, Set<Cap>> = {
  owner: new Set(['view', 'power', 'console', 'manage', 'admin', 'owner']),
  admin: new Set(['view', 'power', 'console', 'manage', 'admin']),
  moderator: new Set(['view', 'power', 'console']),
  starter: new Set(['view', 'power']),
};

export interface Need {
  cap: Cap;
  serverId?: string;
}

/** The desktop window and the single-user (no accounts) mode act as the owner. */
export const LOCAL_OWNER: PanelUser = { id: 'local', name: 'Tento počítač', role: 'owner', servers: 'all', createdAt: 0 };

const POWER = new Set(['start', 'stop', 'restart', 'kill']);

/** What a request needs. Null: open to everyone (sign-in itself, the panel's files). */
export function need(method: string, rawUrl: string): Need | null {
  const url = rawUrl.split('?')[0]!;
  if (!url.startsWith('/api/')) return null;
  if (url.startsWith('/api/auth/')) return null;
  const get = method === 'GET' || method === 'HEAD';
  if (url.startsWith('/api/users') || url.startsWith('/api/panel')) return { cap: 'owner' };
  if (url.startsWith('/api/network')) return { cap: get ? 'view' : 'admin' };
  const m = /^\/api\/servers\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (!m) {
    if (url === '/api/servers' && !get) return { cap: 'admin' };
    return { cap: 'view' };
  }
  const serverId = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '';
  const first = rest.split('/')[0]!;
  if (!rest) return { cap: get ? 'view' : method === 'DELETE' ? 'admin' : 'manage', serverId };
  if (get) {
    // Files and downloads expose everything on the server; logs and players are for moderators.
    if (first === 'files' || /\/download$/.test(rest)) return { cap: 'manage', serverId };
    if (first === 'log' || first === 'logs' || first === 'players' || first === 'stats') return { cap: 'console', serverId };
    return { cap: 'view', serverId };
  }
  if (POWER.has(rest)) return { cap: 'power', serverId };
  if (rest === 'command' || rest === 'kick' || first === 'players') return { cap: 'console', serverId };
  return { cap: 'manage', serverId };
}

export function canSee(user: PanelUser, serverId: string): boolean {
  return user.servers === 'all' || user.role === 'owner' || user.role === 'admin' || user.servers.includes(serverId);
}

export function allowed(user: PanelUser, n: Need): boolean {
  if (!ROLE_CAPS[user.role].has(n.cap)) return false;
  return !n.serverId || canSee(user, n.serverId);
}

export function caps(role: PanelRole): Cap[] {
  return [...ROLE_CAPS[role]];
}
