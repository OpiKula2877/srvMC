import { useCallback, useEffect, useState } from 'react';
import type { ScheduleAction, ScheduledTask, ScheduleState, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';

const ACTIONS: { value: ScheduleAction; label: string }[] = [
  { value: 'restart', label: 'Restart' },
  { value: 'backup', label: 'Záloha' },
  { value: 'start', label: 'Zapnout' },
  { value: 'stop', label: 'Vypnout' },
  { value: 'command', label: 'Příkaz' },
];
const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.value, a.label])) as Record<ScheduleAction, string>;

// Monday first, as in Czech calendars; values are JS weekdays (0 = Sunday).
const DAYS = [
  { d: 1, short: 'Po' },
  { d: 2, short: 'Út' },
  { d: 3, short: 'St' },
  { d: 4, short: 'Čt' },
  { d: 5, short: 'Pá' },
  { d: 6, short: 'So' },
  { d: 0, short: 'Ne' },
];

const TIMES = Array.from({ length: 96 }, (_, i) => {
  const t = `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`;
  return { value: t, label: t };
});

const INTERVALS = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map((m) => ({ value: String(m), label: m < 60 ? `${m} minut` : m === 60 ? '1 hodinu' : m === 1440 ? '24 hodin' : `${m / 60} hodin` }));
const INTERVAL_SHORT = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

function describe(t: ScheduledTask): string {
  if (t.repeat === 'interval') return `Každých ${INTERVAL_SHORT(t.everyMin ?? 60)} od ${t.time}`;
  const set = new Set(t.days);
  let days: string;
  if (set.size === 7) days = 'Každý den';
  else if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) days = 'Po–Pá';
  else days = DAYS.filter((x) => set.has(x.d)).map((x) => x.short).join(', ');
  return `${days} v ${t.time}`;
}

const dayFmt = new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' });
const hm = new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit' });

function when(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  const diffDays = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86_400_000);
  const day = diffDays === 0 ? 'dnes' : diffDays === 1 ? 'zítra' : diffDays === -1 ? 'včera' : dayFmt.format(d);
  return `${day} ${hm.format(d)}`;
}

type Draft = Omit<ScheduledTask, 'id'> & { id?: string };

const blank = (): Draft => ({ action: 'restart', repeat: 'days', time: '04:00', days: [0, 1, 2, 3, 4, 5, 6], everyMin: 360, warn: true, enabled: true });

function TaskDialog({ initial, onSave, onCancel }: { initial: Draft; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const canWarn = d.action === 'restart' || d.action === 'stop';
  const valid = (d.repeat === 'interval' || d.days.length > 0) && (d.action !== 'command' || !!d.command?.trim());
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
        style={{ maxWidth: 480 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(d);
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <h2 id="task-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {initial.id ? 'Upravit úlohu' : 'Nová úloha'}
        </h2>
        <Dropdown label="Akce" value={d.action} options={ACTIONS} onChange={(v) => set({ action: v as ScheduleAction })} searchable={false} />
        {d.action === 'command' && (
          <label className="field">
            <span className="label">Příkaz</span>
            <input autoFocus className="input mono" value={d.command ?? ''} maxLength={300} placeholder="say Ahoj všichni" onChange={(e) => set({ command: e.target.value })} />
          </label>
        )}
        <div className="seg" role="tablist" aria-label="Opakování">
          <button type="button" role="tab" className="seg-btn" aria-selected={d.repeat === 'days'} onClick={() => set({ repeat: 'days' })}>
            Ve dny
          </button>
          <button type="button" role="tab" className="seg-btn" aria-selected={d.repeat === 'interval'} onClick={() => set({ repeat: 'interval' })}>
            Opakovaně
          </button>
        </div>
        {d.repeat === 'days' ? (
          <>
            <div className="seg" role="group" aria-label="Dny v týdnu">
              {DAYS.map((x) => (
                <button
                  key={x.d}
                  type="button"
                  className="seg-btn"
                  style={{ minWidth: 48, justifyContent: 'center', padding: '0 10px' }}
                  aria-pressed={d.days.includes(x.d)}
                  onClick={() => set({ days: d.days.includes(x.d) ? d.days.filter((y) => y !== x.d) : [...d.days, x.d] })}
                >
                  {x.short}
                </button>
              ))}
            </div>
            <Dropdown label="Čas" value={d.time} options={TIMES} onChange={(v) => set({ time: v })} searchable mono />
          </>
        ) : (
          <div className="grid-auto" style={{ ['--min' as string]: '180px', gap: 12 }}>
            <Dropdown label="Každých" value={String(d.everyMin ?? 360)} options={INTERVALS} onChange={(v) => set({ everyMin: Number(v) })} searchable={false} />
            <Dropdown label="Počítat od" value={d.time} options={TIMES} onChange={(v) => set({ time: v })} searchable mono />
          </div>
        )}
        {canWarn && <Toggle label="Odpočet v chatu (5 min, 1 min, 10 s)" checked={d.warn} onChange={(v) => set({ warn: v })} />}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Zrušit
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Uložit
          </button>
        </div>
      </form>
    </div>
  );
}

export function ScheduleTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [state, setState] = useState<ScheduleState | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<ScheduledTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api.schedule(server.id).then(setState).catch((err: Error) => toast('error', 'Plánovač se nepodařilo načíst', err.message)), [server.id, toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (tasks: Draft[], ok?: string) => {
    setBusy('save');
    try {
      setState(await api.saveSchedule(server.id, tasks));
      if (ok) toast('ok', ok);
    } catch (err) {
      toast('error', 'Uložení selhalo', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (t: ScheduledTask) => {
    setBusy(t.id);
    try {
      const { result } = await api.runTask(server.id, t.id);
      toast(result === 'ok' ? 'ok' : 'info', `${ACTION_LABEL[t.action]}: ${result === 'ok' ? 'hotovo' : result}`);
      await load();
    } catch (err) {
      toast('error', 'Úloha selhala', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <Spinner />;
  const tasks = state.tasks;

  return (
    <section className="stack" aria-labelledby="h-plan" style={{ gap: 14 }}>
      <div className="section-head">
        <h2 id="h-plan" className="h2">
          Plánovač
        </h2>
        <button type="button" className="btn" onClick={() => setEditing(blank())}>
          <Icon name="plus" size={17} strokeWidth={2.2} />
          Nová úloha
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="empty">
          <span style={{ fontWeight: 600 }}>Žádné naplánované úlohy</span>
          <button type="button" className="btn primary" onClick={() => setEditing(blank())}>
            Nová úloha
          </button>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((t) => {
            const next = state.next[t.id];
            const failed = t.lastResult && t.lastResult !== 'ok';
            return (
              <li key={t.id} className="card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', opacity: t.enabled ? 1 : 0.65 }}>
                <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ACTION_LABEL[t.action]}
                    {t.action === 'command' && <span className="mono" style={{ fontWeight: 400, color: 'var(--text-2)' }}> {t.command}</span>}
                  </span>
                  <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
                    {describe(t)}
                    {t.warn && ' · s odpočtem'}
                  </span>
                  <span className="muted small">
                    {t.enabled && next ? `Další: ${when(next)}` : 'Vypnuto'}
                    {t.lastRun && (
                      <span style={{ color: failed ? 'var(--amber-text)' : undefined }}>
                        {' · '}naposledy {when(t.lastRun)}
                        {failed ? ` – ${t.lastResult}` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="toggle"
                  aria-label={`${t.enabled ? 'Vypnout' : 'Zapnout'} úlohu ${ACTION_LABEL[t.action]}`}
                  checked={t.enabled}
                  disabled={!!busy}
                  onChange={(e) => void save(tasks.map((x) => (x.id === t.id ? { ...x, enabled: e.target.checked } : x)))}
                />
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => void runNow(t)}>
                  {busy === t.id ? <Spinner size={14} /> : <Icon name="play" size={14} />}
                  Spustit teď
                </button>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => setEditing(t)}>
                  Upravit
                </button>
                <button type="button" className="btn icon sm" style={{ width: 40, minHeight: 40, color: 'var(--red-text)' }} aria-label={`Smazat úlohu ${ACTION_LABEL[t.action]}`} disabled={!!busy} onClick={() => setRemove(t)}>
                  <Icon name="trash" size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <TaskDialog
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(d) => {
            setEditing(null);
            const next = d.id ? tasks.map((x) => (x.id === d.id ? { ...x, ...d } : x)) : [...tasks, d];
            void save(next, d.id ? 'Úloha upravena' : 'Úloha naplánována');
          }}
        />
      )}
      {remove && (
        <ConfirmDialog
          title={`Smazat úlohu ${ACTION_LABEL[remove.action]}?`}
          text={describe(remove)}
          confirmLabel="Smazat"
          danger
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const r = remove;
            setRemove(null);
            void save(
              tasks.filter((x) => x.id !== r.id),
              'Úloha smazána',
            );
          }}
        />
      )}
    </section>
  );
}
