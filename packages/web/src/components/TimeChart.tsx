import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface ChartPoint {
  t: number;
  v: number | null;
}

interface Props {
  label: string;
  points: ChartPoint[];
  /** Bucket size in ms: a longer silence than this is a gap (server off), not a line. */
  bucket: number;
  from: number;
  to: number;
  /** Fixed top of the scale (100 % CPU, 20 TPS); otherwise from the data. */
  max?: number;
  color: string;
  format: (v: number) => string;
  tickFormat: (t: number) => string;
  ticks: number[];
  height?: number;
}

const M = { top: 10, right: 12, bottom: 24, left: 46 };

/** Round steps for the value axis: 1, 2, 2.5, 5 × 10^n. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

const clock = new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Line + soft area over time. Gaps where the server was off stay empty. Hover or arrow keys show a value. */
export function TimeChart({ label, points, bucket, from, to, max, color, format, tickFormat, ticks, height = 190 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const valid = points.filter((p): p is { t: number; v: number } => p.v !== null);
  const top = max ?? niceMax(Math.max(0, ...valid.map((p) => p.v)) * 1.1);
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - from) / Math.max(1, to - from)) * iw;
  const y = (v: number) => M.top + ih - (Math.min(v, top) / top) * ih;

  const segments = useMemo(() => {
    const out: { t: number; v: number }[][] = [];
    let cur: { t: number; v: number }[] = [];
    let prev: number | null = null;
    for (const p of points) {
      if (p.v === null || (prev !== null && p.t - prev > bucket * 1.5)) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (p.v !== null) cur.push({ t: p.t, v: p.v });
      prev = p.t;
    }
    if (cur.length) out.push(cur);
    return out;
  }, [points, bucket]);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!valid.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - M.left) / iw) * (to - from);
    let best = 0;
    for (let i = 1; i < valid.length; i++) if (Math.abs(valid[i]!.t - t) < Math.abs(valid[best]!.t - t)) best = i;
    setHover(best);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!valid.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.key === 'ArrowLeft' ? -1 : 1;
      setHover((h) => Math.min(valid.length - 1, Math.max(0, (h ?? valid.length - 1) + (h === null ? 0 : step))));
    } else if (e.key === 'Escape') setHover(null);
  };

  const hp = hover !== null ? valid[hover] : undefined;
  const tipLeft = hp ? Math.min(Math.max(x(hp.t), 70), width - 70) : 0;

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        style={{ display: 'block', outline: 'none', touchAction: 'pan-y' }}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fill="var(--faint)" fontSize="11" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(v)}
            </text>
          </g>
        ))}
        {ticks.filter((t) => x(t) > M.left + 16 && x(t) < width - M.right - 16).map((t) => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fill="var(--faint)" fontSize="11">
            {tickFormat(t)}
          </text>
        ))}
        {segments.map((seg, i) => {
          const line = seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          const base = (M.top + ih).toFixed(1);
          return (
            <g key={i}>
              {seg.length > 1 ? (
                <>
                  <polygon points={`${x(seg[0]!.t).toFixed(1)},${base} ${line} ${x(seg.at(-1)!.t).toFixed(1)},${base}`} fill={color} fillOpacity="0.1" />
                  <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                </>
              ) : (
                <circle cx={x(seg[0]!.t)} cy={y(seg[0]!.v)} r="3" fill={color} />
              )}
            </g>
          );
        })}
        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + ih} stroke="var(--muted)" strokeWidth="1" />
            <circle cx={x(hp.t)} cy={y(hp.v)} r="5" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hp && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 0,
            left: tipLeft,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            background: 'var(--raised)',
            border: '1px solid var(--line-strong)',
            borderRadius: 8,
            padding: '6px 10px',
            whiteSpace: 'nowrap',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <strong style={{ fontSize: 14, color: 'var(--text)' }}>{format(hp.v)}</strong>
          <span className="muted">{clock.format(hp.t)}</span>
        </div>
      )}
    </div>
  );
}
