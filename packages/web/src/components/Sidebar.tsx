import type { SystemInfo } from '@srvmc/shared';
import { gb, mcVersion, statusLook, typeName } from '../format.ts';
import { useLive } from '../live.ts';
import { href, type Route } from '../router.ts';
import { Icon } from './Icon.tsx';

export function Sidebar({ route, system }: { route: Route; system: SystemInfo | null }) {
  const servers = useLive((s) => s.servers);
  const connected = useLive((s) => s.connected);
  const list = Object.values(servers).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const activeId = route.page === 'server' ? route.id : null;

  return (
    <nav className="sidebar" aria-label="Servery">
      <a className="brand" href={href({ page: 'overview' })}>
        <img className="brand-mark" src="/brand.png" width={32} height={32} alt="" />
        <span className="brand-name">srvMC</span>
      </a>
      <a className="btn primary" href={href({ page: 'new' })}>
        <Icon name="plus" strokeWidth={2.2} />
        Nový server
      </a>
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
      <div className="side-card">
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
    </nav>
  );
}
