import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryPoint, HistoryRange, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { TimeChart, type ChartPoint } from '../../components/TimeChart.tsx';
import { gb } from '../../format.ts';
import { locale, t } from '@srvmc/shared';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const RANGES: { id: HistoryRange; label: string; span: number; bucket: number; tick: number }[] = [
  { id: '1h', label: t('1 hour'), span: HOUR, bucket: MIN, tick: 10 * MIN },
  { id: '24h', label: t('24 hours'), span: DAY, bucket: 5 * MIN, tick: 3 * HOUR },
  { id: '7d', label: t('7 days'), span: 7 * DAY, bucket: 30 * MIN, tick: DAY },
  { id: '30d', label: t('30 days'), span: 30 * DAY, bucket: 2 * HOUR, tick: 5 * DAY },
];

const hm = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' });
const wd = new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric' });
const dm = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric' });
const full = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const dec = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });

/** Tick times inside [from, to]: multiples of the step counted from local midnight, or whole days. */
function tickTimes(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (step < DAY) {
    let t = d.getTime();
    while (t < from) t += step;
    for (; t <= to; t += step) out.push(t);
    return out;
  }
  if (d.getTime() < from) d.setDate(d.getDate() + 1);
  for (; d.getTime() <= to; d.setDate(d.getDate() + step / DAY)) out.push(d.getTime());
  return out;
}

/** Top of the RAM axis in MB: the first size above the limit whose quarters are round numbers. */
function ramScale(limitMb: number): number {
  const gbSteps = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64];
  return (gbSteps.find((g) => g * 1024 >= limitMb * 1.1) ?? 64) * 1024;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="stack" style={{ gap: 2 }}>
      <span className="muted small">{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </span>
  );
}

export function GraphsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [range, setRange] = useState<HistoryRange>('24h');
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [table, setTable] = useState(false);
  const spec = RANGES.find((r) => r.id === range)!;

  const load = useCallback(async () => {
    try {
      const list = await api.history(server.id, range);
      setPoints(list);
      setNow(Date.now());
    } catch (err) {
      toast('error', t('Could not load the history'), (err as Error).message);
    }
  }, [server.id, range, toast]);

  useEffect(() => {
    setPoints(null);
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const from = now - spec.span;
  const ticks = useMemo(() => tickTimes(from, now, spec.tick), [from, now, spec.tick]);
  const tickFormat = (at: number) => (spec.tick < DAY ? hm.format(at) : spec.id === '7d' ? wd.format(at) : dm.format(at));
  const series = (pick: (p: HistoryPoint) => number | null): ChartPoint[] => (points ?? []).map((p) => ({ t: p.t, v: pick(p) }));

  const cpu = (points ?? []).map((p) => p.cpu);
  const mem = (points ?? []).map((p) => p.memMb);
  const players = (points ?? []).map((p) => p.players);
  const tps = (points ?? []).flatMap((p) => (p.tps === null ? [] : [p.tps]));
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const hasTps = tps.length > 0;

  const charts = [
    {
      title: t('CPU'),
      stats: [
        [t('average'), `${dec.format(avg(cpu))} %`],
        [t('peak'), `${dec.format(Math.max(0, ...cpu))} %`],
      ],
      chart: <TimeChart label={t('CPU use over time')} points={series((p) => p.cpu)} bucket={spec.bucket} from={from} to={now} max={100} color="var(--blue)" format={(v) => `${dec.format(v)} %`} tickFormat={tickFormat} ticks={ticks} />,
    },
    {
      title: t('Memory'),
      stats: [
        [t('peak'), mem.length ? gb(Math.max(...mem)) : '–'],
        [t('limit'), gb(server.ramMaxMb)],
      ],
      chart: <TimeChart label={t('Memory use over time')} points={series((p) => p.memMb)} bucket={spec.bucket} from={from} to={now} max={ramScale(server.ramMaxMb)} color="var(--green)" format={(v) => gb(v)} tickFormat={tickFormat} ticks={ticks} />,
    },
    {
      title: t('Players'),
      stats: [
        [t('most at once'), String(Math.max(0, ...players))],
        [t('average'), dec.format(avg(players))],
      ],
      chart: <TimeChart label={t('Players over time')} points={series((p) => p.players)} bucket={spec.bucket} from={from} to={now} max={Math.max(4, Math.ceil(Math.max(0, ...players) / 4) * 4)} color="var(--blue)" format={(v) => dec.format(Math.round(v))} tickFormat={tickFormat} ticks={ticks} />,
    },
    {
      title: 'TPS',
      stats: hasTps
        ? [
            [t('lowest'), dec.format(Math.min(...tps))],
            [t('average'), dec.format(avg(tps))],
          ]
        : [],
      chart: hasTps ? (
        <TimeChart label={t('Ticks per second over time')} points={series((p) => p.tps)} bucket={spec.bucket} from={from} to={now} max={20} color="var(--green)" format={(v) => dec.format(v)} tickFormat={tickFormat} ticks={ticks} />
      ) : (
        <div className="muted small" style={{ minHeight: 120, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          {t('This server type or version does not report TPS.')}
        </div>
      ),
    },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="section-head">
        <div className="seg" role="tablist" aria-label={t('Period')}>
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="tab" className="seg-btn" aria-selected={r.id === range} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" style={{ minHeight: 40 }} aria-pressed={table} onClick={() => setTable((v) => !v)}>
          {table ? t('Show graphs') : t('Show table')}
        </button>
      </div>

      {points === null ? (
        <Spinner />
      ) : points.length === 0 ? (
        <div className="empty">
          <span style={{ fontWeight: 600 }}>{t('No data yet')}</span>
          <span className="muted">{t('The graphs fill up while the server runs.')}</span>
        </div>
      ) : table ? (
        <div className="table-wrap card" style={{ maxHeight: 520, overflow: 'auto', padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('Time')}</th>
                <th className="num">CPU</th>
                <th className="num">RAM</th>
                <th className="num">{t('Players')}</th>
                <th className="num">TPS</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.t}>
                  <td>{full.format(p.t)}</td>
                  <td className="num">{dec.format(p.cpu)} %</td>
                  <td className="num">{gb(p.memMb)}</td>
                  <td className="num">{p.players}</td>
                  <td className="num">{p.tps === null ? '–' : dec.format(p.tps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid-auto" style={{ ['--min' as string]: '420px', gap: 16 }}>
          {charts.map((c) => (
            <section key={c.title} className="card stack" style={{ gap: 12 }} aria-label={c.title}>
              <div className="section-head" style={{ alignItems: 'flex-start' }}>
                <h2 className="h2">{c.title}</h2>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
                  {c.stats.map(([l, v]) => (
                    <Stat key={l} label={l!} value={v!} />
                  ))}
                </div>
              </div>
              {c.chart}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
