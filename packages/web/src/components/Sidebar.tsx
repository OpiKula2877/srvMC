import { useEffect, useState } from 'react';
import type { SystemInfo } from '@srvmc/shared';
import { api } from '../api.ts';
import { can, ROLE_LABEL, useAuth } from '../auth.ts';
import { gb, mcVersion, statusLook, typeName } from '../format.ts';
import { useLive } from '../live.ts';
import { href, type Route } from '../router.ts';
import { Icon } from './Icon.tsx';
import { ConfirmDialog } from './Overlays.tsx';

export function Sidebar({ route, system }: { route: Route; system: SystemInfo | null }) {
  const servers = useLive((s) => s.servers);
  const connected = useLive((s) => s.connected);
  const list = Object.values(servers).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const activeId = route.page === 'server' ? route.id : null;
  const auth = useAuth();
  // On a phone the list folds into a menu; it closes whenever a page is picked.
  const [open, setOpen] = useState(false);
  const where = JSON.stringify(route);
  useEffect(() => setOpen(false), [where]);
  const owner = can(auth, 'owner');
  const [canRestart, setCanRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!owner) return;
    api
      .canRestart()
      .then((r) => setCanRestart(r.available))
      .catch(() => setCanRestart(false));
  }, [owner]);

  const restart = async () => {
    setRestarting(true);
    try {
      await api.restartApp();
    } catch {
      setRestarting(false);
      setConfirmRestart(false);
      return;
    }
    // The panel comes back once the app is up again.
    const wait = async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await fetch('/api/auth/me').then((r) => r.ok, () => false)) return location.reload();
      }
    };
    setTimeout(() => void wait(), 3000);
  };

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Servery">
      <div className="side-top">
        <a className="brand" href={href({ page: 'overview' })}>
          <img className="brand-mark" src="/brand.png" width={32} height={32} alt="" />
          <span className="brand-name">srvMC</span>
        </a>
        <button type="button" className="btn icon menu-btn" aria-label={open ? 'Zavřít menu' : 'Otevřít menu'} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? 'close' : 'menu'} size={20} />
        </button>
      </div>
      <div className="side-body">
      {can(auth, 'admin') && (
        <a className="btn primary" href={href({ page: 'new' })}>
          <Icon name="plus" strokeWidth={2.2} />
          Nový server
        </a>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="side-label">Moje servery</div>
        {list.length === 0 && <span className="muted small" style={{ padding: '0 8px' }}>Zatím žádný server</span>}
        {list.map((s) => (
          <a key={s.id} className={`side-link${s.id === activeId ? ' active' : ''}`} href={href({ page: 'server', id: s.id, tab: 'konzole' })}>
            <span className="dot" style={{ background: statusLook(s).dot }} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="name">{s.name}</span>
              <span className="muted small">
                {typeName(s)} · {mcVersion(s)}
              </span>
            </span>
          </a>
        ))}
      </div>
      {auth?.user && (
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {owner && (
            <a className={`side-link${route.page === 'users' ? ' active' : ''}`} href={href({ page: 'users' })}>
              <Icon name="users" size={16} />
              <span className="name">Uživatelé</span>
            </a>
          )}
          {owner && canRestart && (
            <button type="button" className="side-link" onClick={() => setConfirmRestart(true)}>
              <Icon name="restart" size={16} />
              <span className="name">Restartovat aplikaci</span>
            </button>
          )}
          {auth.user.id !== 'local' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{auth.user.name}</span>
                <span className="muted small">{ROLE_LABEL[auth.user.role]}</span>
              </span>
              <button type="button" className="btn sm" onClick={() => void api.logout().finally(() => location.reload())}>
                Odhlásit
              </button>
            </div>
          )}
        </div>
      )}
      {confirmRestart && (
        <ConfirmDialog
          title="Restartovat srvMC?"
          text="Běžící servery se bezpečně zastaví a po restartu se samy znovu spustí."
          confirmLabel={restarting ? 'Restartuji…' : 'Restartovat'}
          busy={restarting}
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => void restart()}
        />
      )}
      <div className="side-card" style={auth?.user ? { marginTop: 8 } : undefined}>
        <div className="muted small" style={{ fontWeight: 600 }}>
          Tento počítač
        </div>
        {system ? (
          <>
            <div className="kv">
              <span className="muted">RAM</span>
              <span>{gb(system.totalMemMb)}</span>
            </div>
            <div className="kv">
              <span className="muted">Volné místo</span>
              <span>{system.diskFreeMb == null ? '–' : gb(system.diskFreeMb)}</span>
            </div>
            <div className="kv">
              <span className="muted">Java</span>
              <span>{system.javaRuntimes.length ? system.javaRuntimes.join(', ') : 'stáhne se sama'}</span>
            </div>
          </>
        ) : (
          <span className="muted">Načítám…</span>
        )}
        {!connected && <span style={{ color: 'var(--amber-text)' }}>Připojuji se k jádru…</span>}
      </div>
      </div>
    </nav>
  );
}
