import type { ServerInfo, ServerStatus } from '@srvmc/shared';

const nf1 = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

export function gb(mb: number): string {
  return `${nf1.format(mb / 1024)} GB`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')} h`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${nf1.format(n / 1024)} kB`;
  if (n < 1024 * 1024 * 1024) return `${nf1.format(n / 1024 / 1024)} MB`;
  return `${nf1.format(n / 1024 / 1024 / 1024)} GB`;
}

export function dateTime(t: number): string {
  return new Date(t).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A stable color per name, for player head placeholders. */
export function nameColor(name: string): string {
  const palette = ['#7fb069', '#c08552', '#b89bd9', '#6aa9ff', '#e08a4f', '#4fb5a5', '#f2b33d', '#c57bd6', '#8c9bab'];
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'teď';
  const m = Math.round(s / 60);
  if (m < 60) return `před ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'včera' : `před ${d} dny`;
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface StatusLook {
  label: string;
  dot: string;
  bg: string;
  fg: string;
}

const LOOK: Record<ServerStatus, StatusLook> = {
  running: { label: 'Běží', dot: 'var(--green)', bg: 'var(--green-soft)', fg: 'var(--green-text)' },
  starting: { label: 'Spouští se', dot: 'var(--amber)', bg: 'var(--amber-soft)', fg: 'var(--amber-text)' },
  stopping: { label: 'Zastavuje se', dot: 'var(--amber)', bg: 'var(--amber-soft)', fg: 'var(--amber-text)' },
  installing: { label: 'Instaluje se', dot: 'var(--blue)', bg: 'var(--blue-soft)', fg: 'var(--blue-text)' },
  stopped: { label: 'Vypnuto', dot: 'var(--gray-dot)', bg: 'var(--raised)', fg: '#b5bcc4' },
  crashed: { label: 'Spadl', dot: 'var(--red)', bg: 'var(--red-soft)', fg: 'var(--red-text)' },
  error: { label: 'Chyba', dot: 'var(--red)', bg: 'var(--red-soft)', fg: 'var(--red-text)' },
};

export function statusLook(s: ServerInfo, now = Date.now()): StatusLook {
  const look = LOOK[s.status];
  if (s.status === 'running' && s.startedAt) return { ...look, label: `Běží ${duration(now - s.startedAt)}` };
  if (s.status === 'installing' && s.install?.pct != null) return { ...look, label: `Instaluje se ${s.install.pct} %` };
  return look;
}

export function isActive(s: ServerInfo): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'stopping';
}
