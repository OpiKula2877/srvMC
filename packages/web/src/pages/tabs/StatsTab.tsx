import { useEffect, useMemo, useState } from 'react';
import type { PlayerStat, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { ago, nameColor } from '../../format.ts';

const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  return `${nf.format(h)} h`;
}

type Sort = 'time' | 'last' | 'name';

function Head({ p, java }: { p: PlayerStat; java: boolean }) {
  const [broken, setBroken] = useState(false);
  if (java && !broken) {
    return <img src={`https://mc-heads.net/avatar/${encodeURIComponent(p.uuid ?? p.name)}/32`} alt="" width={32} height={32} loading="lazy" style={{ borderRadius: 4, imageRendering: 'pixelated' }} onError={() => setBroken(true)} />;
  }
  return (
    <span className="head" style={{ background: nameColor(p.name), width: 32, height: 32 }} aria-hidden="true">
      {p.name.charAt(0).toUpperCase()}
    </span>
  );
}

export function StatsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [stats, setStats] = useState<PlayerStat[] | null>(null);
  const [sort, setSort] = useState<Sort>('time');
  const java = server.type !== 'bedrock' && server.type !== 'bedrock-preview';

  useEffect(() => {
    const load = () => void api.stats(server.id).then(setStats).catch((err: Error) => toast('error', 'Statistiky se nepodařilo načíst', err.message));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [server.id, server.players.length, toast]);

  const sorted = useMemo(() => {
    const list = [...(stats ?? [])];
    if (sort === 'last') list.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    else list.sort((a, b) => b.playMs - a.playMs);
    return list;
  }, [stats, sort]);

  if (!stats) return <Spinner />;
  if (stats.length === 0) {
    return (
      <div className="empty">
        <span style={{ fontWeight: 600 }}>Zatím tu nikdo nehrál</span>
        <span className="muted">Statistiky se plní, jak se hráči připojují.</span>
      </div>
    );
  }

  const total = stats.reduce((a, p) => a + p.playMs, 0);
  const hasGame = stats.some((p) => p.game);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="grid-auto" style={{ ['--min' as string]: '180px', gap: 12 }} aria-label="Souhrn">
        {[
          ['Hráčů celkem', String(stats.length)],
          ['Odehráno celkem', hours(total)],
          ['Teď online', String(stats.filter((p) => p.online).length)],
          ['Nejvíc hraje', sorted[0] && sort === 'time' ? sorted[0].name : [...stats].sort((a, b) => b.playMs - a.playMs)[0]!.name],
        ].map(([label, value]) => (
          <div key={label} className="card tight stack" style={{ gap: 6 }}>
            <span className="muted small">{label}</span>
            <span style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </section>

      <div className="section-head">
        <h2 className="h2">Hráči</h2>
        <div className="seg" role="tablist" aria-label="Řazení">
          {(
            [
              ['time', 'Podle času'],
              ['last', 'Naposledy'],
              ['name', 'Podle jména'],
            ] as [Sort, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" className="seg-btn" aria-selected={sort === id} onClick={() => setSort(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Hráč</th>
              <th className="num">Odehráno</th>
              <th className="num">Připojení</th>
              <th>Naposledy</th>
              {hasGame && (
                <>
                  <th className="num">Smrti</th>
                  <th className="num">Zabitá monstra</th>
                  <th className="num">Vytěženo bloků</th>
                  <th className="num">Ušlo (km)</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.name}>
                <td>
                  <span className="who">
                    <Head p={p} java={java} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{p.name}</span>
                      {p.online && (
                        <span className="sub" style={{ color: 'var(--green-text)' }}>
                          online
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="num">{hours(p.playMs)}</td>
                <td className="num">{p.sessions}</td>
                <td className="muted small">{p.online ? 'teď' : p.lastSeen ? ago(p.lastSeen) : '–'}</td>
                {hasGame && (
                  <>
                    <td className="num">{p.game?.deaths ?? '–'}</td>
                    <td className="num">{p.game?.mobKills ?? '–'}</td>
                    <td className="num">{p.game?.blocksMined ?? '–'}</td>
                    <td className="num">{p.game?.distanceKm != null ? nf.format(p.game.distanceKm) : '–'}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
