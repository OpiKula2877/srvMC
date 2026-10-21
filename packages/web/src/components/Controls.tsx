import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ServerInfo } from '@srvmc/shared';
import { statusLook } from '../format.ts';

export interface MenuItem {
  label: string;
  hint?: string;
  color?: string;
  onClick: () => void;
}

/** A "⋯" button with a popover menu; closes on outside click or Escape. */
export function MenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn icon sm" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              style={{ color: it.color }}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="k">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min?: number; max?: number; onChange: (v: number) => void; label: string }) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  return (
    <div className="stepper">
      <button type="button" aria-label={`${label}: méně`} disabled={min !== undefined && value <= min} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        aria-label={label}
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(clamp(Math.round(n)));
        }}
      />
      <button type="button" aria-label={`${label}: více`} disabled={max !== undefined && value >= max} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" className="toggle" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Slider(props: {
  id: string;
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  color?: string;
  disabled?: boolean;
}) {
  const pct = props.max > props.min ? ((props.value - props.min) / (props.max - props.min)) * 100 : 0;
  const style = { '--pct': `${pct}%`, '--fill': props.color } as CSSProperties;
  return (
    <div className="field" style={{ gap: 10 }}>
      <label htmlFor={props.id} className="kv muted" style={{ fontSize: 13 }}>
        <span>{props.label}</span>
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{props.valueLabel}</span>
      </label>
      <input
        id={props.id}
        type="range"
        className="slider"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={style}
      />
    </div>
  );
}

const gbText = (mb: number) => `${(mb / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} GB`;

/** RAM in MB: a slider for quick moves plus an exact number (e.g. 1536 MB = 1,5 GB). */
export function RamPicker({ id, label, valueMb, maxMb, onChange }: { id: string; label: string; valueMb: number; maxMb: number; onChange: (mb: number) => void }) {
  const min = 512;
  const [text, setText] = useState(String(valueMb));
  useEffect(() => setText(String(valueMb)), [valueMb]);
  const commit = () => {
    const n = Math.round(Number(text));
    const next = Number.isFinite(n) && n > 0 ? Math.min(maxMb, Math.max(min, n)) : valueMb;
    setText(String(next));
    if (next !== valueMb) onChange(next);
  };
  const pct = maxMb > min ? ((valueMb - min) / (maxMb - min)) * 100 : 0;
  return (
    <div className="field" style={{ gap: 10 }}>
      <div className="kv muted" style={{ fontSize: 13 }}>
        <label htmlFor={id}>{label}</label>
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>
          {gbText(valueMb)} z {gbText(maxMb)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <input
          type="range"
          className="slider"
          aria-label={`${label} (posuvník)`}
          min={min}
          max={maxMb}
          step={256}
          value={valueMb}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, '--pct': `${pct}%` } as CSSProperties}
        />
        <label className="unit-input">
          <input
            id={id}
            inputMode="numeric"
            value={text}
            onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          <span>MB</span>
        </label>
      </div>
    </div>
  );
}

export function StatusPill({ server }: { server: ServerInfo }) {
  const look = statusLook(server);
  return (
    <span className="pill" style={{ background: look.bg, color: look.fg }}>
      <span className="dot" style={{ background: look.dot }} />
      {look.label}
    </span>
  );
}

export function Progress({ pct }: { pct: number | null | undefined }) {
  const known = typeof pct === 'number';
  return (
    <div className={`progress${known ? '' : ' indeterminate'}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined}>
      <span style={{ width: `${known ? pct : 35}%` }} />
    </div>
  );
}

export function Sparkline({ values, max, color, height = 44, label }: { values: number[]; max: number; color: string; height?: number; label: string }) {
  const w = 300;
  const pts = values.length > 1 ? values : [0, 0];
  const step = w / (pts.length - 1);
  const y = (v: number) => (height - 2 - (Math.min(v, max) / (max || 1)) * (height - 6)).toFixed(1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={label}>
      <line x1="0" y1={height - 1} x2={w} y2={height - 1} stroke="var(--line)" strokeWidth="1" />
      <polygon points={`0,${height} ${line} ${w},${height}`} fill={color} fillOpacity="0.14" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
