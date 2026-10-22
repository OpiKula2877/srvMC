import { useEffect, useState } from 'react';
import { getLang, LANGS, type Lang, type ServerInfo, type SystemInfo } from '@srvmc/shared';
import { can, useAuth } from '../auth.ts';
import { Dropdown } from '../components/Dropdown.tsx';
import { api } from '../api.ts';
import { Sparkline, StatusPill } from '../components/Controls.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Overlays.tsx';
import { AddressBox, ServerTile } from '../components/ServerBits.tsx';
import { gb, isActive, mcVersion, typeName } from '../format.ts';
import { useLive } from '../live.ts';
import { href } from '../router.ts';
import { t } from '@srvmc/shared';

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function ServerCard({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const points = useLive((s) => s.metrics[server.id]);
  const last = points?.at(-1);
  const [busy, setBusy] = useState(false);
  const active = isActive(server);
  const canStart = server.status === 'stopped' || server.status === 'crashed';

  const act = async () => {
    setBusy(true);
    try {
      await api.action(server.id, active ? 'stop' : 'start');
    } catch (err) {
      toast('error', active ? t('Stopping failed') : t('Starting failed'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card hover stack" style={{ gap: 16 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <ServerTile server={server} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span className="chip">{typeName(server)}</span>
            <span className="chip">{mcVersion(server)}</span>
            <span className="chip">{gb(server.ramMaxMb)} RAM</span>
          </div>
        </div>
        <StatusPill server={server} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <div className="stat" style={{ gap: 2 }}>
          <span className="muted small">{t('Players')}</span>
          <span style={{ fontWeight: 600 }}>{active ? server.players.length : '–'}</span>
        </div>
        <div className="stat" style={{ gap: 2 }}>
          <span className="muted small">CPU</span>
          <span style={{ fontWeight: 600 }}>{active && last ? `${last.cpu.toFixed(0)} %` : '–'}</span>
        </div>
        <div className="stat" style={{ gap: 2 }}>
          <span className="muted small">RAM</span>
          <span style={{ fontWeight: 600 }}>{active && last ? gb(last.memMb) : '–'}</span>
        </div>
      </div>

      <Sparkline values={(points ?? []).slice(-60).map((p) => p.memMb)} max={server.ramMaxMb * 1.15} color="var(--green)" label={t('RAM use in the last minutes')} />

      <AddressBox server={server} />

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          className={`btn ${active ? 'danger' : 'primary'}`}
          style={{ flex: 1 }}
          disabled={busy || server.status === 'stopping' || (!active && !canStart)}
          onClick={act}
        >
          {active ? t('Stop') : server.status === 'installing' ? t('Installing…') : t('Start')}
        </button>
        <a className="btn" style={{ flex: 1 }} href={href({ page: 'server', id: server.id, tab: 'konzole' })}>
          {t('Open')}
        </a>
      </div>
    </article>
  );
}

export function Overview({ system }: { system: SystemInfo | null }) {
  useTick(15_000);
  const toast = useToast();
  const owner = can(useAuth(), 'owner');
  const servers = useLive((s) => s.servers);
  const metrics = useLive((s) => s.metrics);
  const loaded = useLive((s) => s.loaded);
  const list = Object.values(servers).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const running = list.filter(isActive);
  const players = running.reduce((n, s) => n + s.players.length, 0);
  const usedMb = running.reduce((n, s) => n + (metrics[s.id]?.at(-1)?.memMb ?? 0), 0);
  const allocatedMb = running.reduce((n, s) => n + s.ramMaxMb, 0);

  return (
    <main className="main">
      <header className="section-head" style={{ alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h1">{t('My servers')}</h1>
          <p className="muted">
            {list.length === 0 ? t('Create your first server – the files download by themselves.') : t(list.length === 1 ? '{n} server · {running} running' : '{n} servers · {running} running', { n: list.length, running: running.length })}
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          {owner && (
            <div style={{ minWidth: 150 }}>
              <Dropdown
                label={t('Language')}
                value={getLang()}
                options={LANGS.map((l) => ({ value: l.id, label: l.label }))}
                searchable={false}
                onChange={(v) =>
                  void api
                    .setLanguage(v as Lang)
                    .then(() => location.reload())
                    .catch((err: Error) => toast('error', t('Could not change the language'), err.message))
                }
              />
            </div>
          )}
          <a className="btn primary" href={href({ page: 'new' })}>
            <Icon name="plus" strokeWidth={2.2} />
            {t('New server')}
          </a>
        </div>
      </header>

      <section aria-label={t('Summary')} className="grid-auto" style={{ ['--min' as string]: '200px' }}>
        <div className="card tight stat">
          <span className="label">{t('Players online')}</span>
          <span className="value">{players}</span>
        </div>
        <div className="card tight stat">
          <span className="label">{t('Server RAM')}</span>
          <span className="value">{gb(usedMb)}</span>
          <span className="muted small">{t('{ram} allocated', { ram: gb(allocatedMb) })}</span>
        </div>
        <div className="card tight stat">
          <span className="label">{t('Running')}</span>
          <span className="value">
            {running.length} / {list.length}
          </span>
        </div>
        <div className="card tight stat">
          <span className="label">{t('Free space')}</span>
          <span className="value">{system?.diskFreeMb == null ? '–' : gb(system.diskFreeMb)}</span>
        </div>
      </section>

      {loaded && list.length === 0 ? (
        <div className="empty">
          <span style={{ color: 'var(--green)' }}>
            <Icon name="bolt" size={34} strokeWidth={1.8} />
          </span>
          <h2 className="h2">{t('Nothing here yet')}</h2>
          <p className="muted">{t('Pick a type and a Minecraft version. srvMC downloads the server and Java and gets everything ready to start.')}</p>
          <a className="btn primary" href={href({ page: 'new' })}>
            {t('Create the first server')}
          </a>
        </div>
      ) : (
        <section aria-label={t('Server list')} className="grid-auto" style={{ ['--min' as string]: '360px', gap: 20 }}>
          {list.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </section>
      )}
    </main>
  );
}
