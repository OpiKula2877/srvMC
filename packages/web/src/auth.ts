// Who is signed in, and what their role allows. The core enforces it; the panel only hides what
// would be refused anyway.
import { useSyncExternalStore } from 'react';
import type { AuthInfo, PanelRole } from '@srvmc/shared';
import { api } from './api.ts';
import { t } from '@srvmc/shared';

export type Cap = 'view' | 'power' | 'console' | 'manage' | 'admin' | 'owner';

const ROLE_CAPS: Record<PanelRole, Cap[]> = {
  owner: ['view', 'power', 'console', 'manage', 'admin', 'owner'],
  admin: ['view', 'power', 'console', 'manage', 'admin'],
  moderator: ['view', 'power', 'console'],
  starter: ['view', 'power'],
};

export const ROLE_LABEL: Record<PanelRole, string> = {
  owner: t('Owner'),
  admin: t('Admin'),
  moderator: t('Moderator'),
  starter: t('Start only'),
};

let info: AuthInfo | null = null;
const listeners = new Set<() => void>();

function set(next: AuthInfo): void {
  info = next;
  for (const l of listeners) l();
}

export async function refreshAuth(): Promise<void> {
  set(await api.me());
}

export function setAuth(next: AuthInfo): void {
  set(next);
}

export function useAuth(): AuthInfo | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => info,
  );
}

export function can(a: AuthInfo | null, cap: Cap): boolean {
  return !!a?.user && ROLE_CAPS[a.user.role].includes(cap);
}

// Any request the core refuses with 401 (session expired) brings the sign-in back.
window.addEventListener('srvmc-unauthorized', () => void refreshAuth().catch(() => undefined));
