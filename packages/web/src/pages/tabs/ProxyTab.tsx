import { useCallback, useEffect, useState } from 'react';
import type { ProxyState, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { typeName } from '../../format.ts';
import { useLive } from '../../live.ts';
import { t } from '@srvmc/shared';

export function ProxyTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const all = useLive((s) => s.servers);
  const [state, setState] = useState<ProxyState | null>(null);
  // Linked servers in the order players are sent to them; the first is where they land.
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .proxy(server.id)
        .then((s) => {
          setState(s);
          setOrder((server.proxy?.servers ?? []).map((x) => x.id).filter((id) => s.backends.some((b) => b.id === id)));
        })
        .catch((err: Error) => toast('error', t('Could not load the server network'), err.message)),
    [server.id, server.proxy, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return <Spinner />;
  const saved = (server.proxy?.servers ?? []).map((x) => x.id).join(',');
  const dirty = order.join(',') !== saved;

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveProxy(
        server.id,
        order.map((id) => ({ id, alias: state.backends.find((b) => b.id === id)?.alias })),
      );
      setState(next);
      toast('ok', t('Server network saved'), t('Servers behind the proxy pick it up after they restart.'));
    } catch (err) {
      toast('error', t('Saving failed'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const move = (id: string, by: number) => {
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {state.pendingStart && <div className="banner info">{t('Velocity creates velocity.toml on its first start. The servers are written into it right after.')}</div>}
      <section className="card stack" style={{ gap: 12 }} aria-labelledby="h-proxy">
        <div className="section-head">
          <h2 id="h-proxy" className="h2">
            {t('Servers behind the proxy')}
          </h2>
          <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <Spinner size={14} /> : null}
            {t('Save')}
          </button>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.backends.length === 0 && <li className="muted">{t('Create a Paper or Fabric server first.')}</li>}
          {state.backends.map((b) => {
            const pos = order.indexOf(b.id);
            const on = pos >= 0;
            const running = all[b.id] && all[b.id]!.status !== 'stopped' && all[b.id]!.status !== 'crashed' && all[b.id]!.status !== 'error';
            return (
              <li key={b.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: on ? '#18301f' : 'var(--surface-2)', opacity: b.supported && !b.elsewhere ? 1 : 0.6 }}>
                <input
                  type="checkbox"
                  className="toggle"
                  aria-label={on ? t('Disconnect {name}', { name: b.name }) : t('Connect {name}', { name: b.name })}
                  checked={on}
                  disabled={!b.supported || !!b.elsewhere || running}
                  title={running ? t('Stop the server first') : undefined}
                  onChange={(e) => setOrder(e.target.checked ? [...order, b.id] : order.filter((x) => x !== b.id))}
                />
                <span style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 500 }}>
                    {b.name}
                    {pos === 0 && <span className="pill" style={{ marginLeft: 8, background: 'var(--green-soft)', color: 'var(--green-text)' }}>{t('players arrive here')}</span>}
                  </span>
                  <span className="muted small">
                    {typeName(all[b.id] ?? ({ type: b.type } as ServerInfo))} · {t('port {port}', { port: b.port })}
                    {b.alias ? ` · /server ${b.alias}` : ''}
                    {b.reason ? ` · ${b.reason}` : ''}
                    {b.elsewhere ? ` · ${t('behind the proxy {name}', { name: b.elsewhere })}` : ''}
                  </span>
                </span>
                {on && order.length > 1 && (
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="btn sm" aria-label={t('Move {name} up', { name: b.name })} disabled={pos === 0} onClick={() => move(b.id, -1)}>
                      ↑
                    </button>
                    <button type="button" className="btn sm" aria-label={t('Move {name} down', { name: b.name })} disabled={pos === order.length - 1} onClick={() => move(b.id, 1)}>
                      ↓
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
