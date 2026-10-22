import { useCallback, useEffect, useState } from 'react';
import type { ScheduleAction, ScheduledTask, ScheduleState, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { locale, t } from '@srvmc/shared';

const ACTIONS: { value: ScheduleAction; label: string }[] = [
  { value: 'restart', label: 'Restart' },
  { value: 'backup', label: t('Backup') },
  { value: 'start', label: t('Start') },
  { value: 'stop', label: t('Stop') },
  { value: 'command', label: t('Command') },
];
const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.value, a.label])) as Record<ScheduleAction, string>;

// Monday first; values are JS weekdays (0 = Sunday).
const DAYS = [
  { d: 1, short: t('Mon') },
  { d: 2, short: t('Tue') },
  { d: 3, short: t('Wed') },
  { d: 4, short: t('Thu') },
  { d: 5, short: t('Fri') },
  { d: 6, short: t('Sat') },
  { d: 0, short: t('Sun') },
];

const TIMES = Array.from({ length: 96 }, (_, i) => {
  const t = `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`;
  return { value: t, label: t };
});

const INTERVALS = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map((m) => ({ value: String(m), label: m < 60 ? t('{n} minutes', { n: m }) : m === 60 ? t('one hour') : t('{n} hours', { n: m / 60 }) }));
const INTERVAL_SHORT = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

function describe(task: ScheduledTask): string {
  if (task.repeat === 'interval') return t('Every {interval} from {time}', { interval: INTERVAL_SHORT(task.everyMin ?? 60), time: task.time });
  const set = new Set(task.days);
  let days: string;
  if (set.size === 7) days = t('Every day');
  else if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) days = t('Mon–Fri');
  else days = DAYS.filter((x) => set.has(x.d)).map((x) => t(x.short)).join(', ');
  return t('{days} at {time}', { days, time: task.time });
}

const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'numeric' });
const hm = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' });

function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const diffDays = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86_400_000);
  const day = diffDays === 0 ? t('today') : diffDays === 1 ? t('tomorrow') : diffDays === -1 ? t('yesterday') : dayFmt.format(d);
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
          {initial.id ? t('Edit task') : t('New task')}
        </h2>
        <Dropdown label={t('Action')} value={d.action} options={ACTIONS} onChange={(v) => set({ action: v as ScheduleAction })} searchable={false} />
        {d.action === 'command' && (
          <label className="field">
            <span className="label">{t('Command')}</span>
            <input autoFocus className="input mono" value={d.command ?? ''} maxLength={300} placeholder={t('say Hello everyone')} onChange={(e) => set({ command: e.target.value })} />
          </label>
        )}
        <div className="seg" role="tablist" aria-label={t('Repeat')}>
          <button type="button" role="tab" className="seg-btn" aria-selected={d.repeat === 'days'} onClick={() => set({ repeat: 'days' })}>
            {t('On days')}
          </button>
          <button type="button" role="tab" className="seg-btn" aria-selected={d.repeat === 'interval'} onClick={() => set({ repeat: 'interval' })}>
            {t('Repeatedly')}
          </button>
        </div>
        {d.repeat === 'days' ? (
          <>
            <div className="seg" role="group" aria-label={t('Days of the week')}>
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
            <Dropdown label={t('Time')} value={d.time} options={TIMES} onChange={(v) => set({ time: v })} searchable mono />
          </>
        ) : (
          <div className="grid-auto" style={{ ['--min' as string]: '180px', gap: 12 }}>
            <Dropdown label={t('Every')} value={String(d.everyMin ?? 360)} options={INTERVALS} onChange={(v) => set({ everyMin: Number(v) })} searchable={false} />
            <Dropdown label={t('Counting from')} value={d.time} options={TIMES} onChange={(v) => set({ time: v })} searchable mono />
          </div>
        )}
        {canWarn && <Toggle label={t('Countdown in chat (5 min, 1 min, 10 s)')} checked={d.warn} onChange={(v) => set({ warn: v })} />}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            {t('Save')}
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

  const load = useCallback(() => api.schedule(server.id).then(setState).catch((err: Error) => toast('error', t('Could not load the scheduler'), err.message)), [server.id, toast]);

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
      toast('error', t('Saving failed'), (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setBusy(task.id);
    try {
      const { result } = await api.runTask(server.id, task.id);
      toast(result === 'ok' ? 'ok' : 'info', `${ACTION_LABEL[task.action]}: ${result === 'ok' ? t('done') : result}`);
      await load();
    } catch (err) {
      toast('error', t('The task failed'), (err as Error).message);
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
          {t('Scheduler')}
        </h2>
        <button type="button" className="btn" onClick={() => setEditing(blank())}>
          <Icon name="plus" size={17} strokeWidth={2.2} />
          {t('New task')}
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="empty">
          <span style={{ fontWeight: 600 }}>{t('No scheduled tasks')}</span>
          <button type="button" className="btn primary" onClick={() => setEditing(blank())}>
            {t('New task')}
          </button>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((task) => {
            const next = state.next[task.id];
            const failed = task.lastResult && task.lastResult !== 'ok';
            return (
              <li key={task.id} className="card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', opacity: task.enabled ? 1 : 0.65 }}>
                <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ACTION_LABEL[task.action]}
                    {task.action === 'command' && <span className="mono" style={{ fontWeight: 400, color: 'var(--text-2)' }}> {task.command}</span>}
                  </span>
                  <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
                    {describe(task)}
                    {task.warn && ` · ${t('with countdown')}`}
                  </span>
                  <span className="muted small">
                    {task.enabled && next ? t('Next: {time}', { time: when(next) }) : t('Off')}
                    {task.lastRun && (
                      <span style={{ color: failed ? 'var(--amber-text)' : undefined }}>
                        {' · '}{t('last {time}', { time: when(task.lastRun) })}
                        {failed ? ` – ${task.lastResult}` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <input
                  type="checkbox"
                  className="toggle"
                  aria-label={task.enabled ? t('Turn off the task {name}', { name: ACTION_LABEL[task.action] }) : t('Turn on the task {name}', { name: ACTION_LABEL[task.action] })}
                  checked={task.enabled}
                  disabled={!!busy}
                  onChange={(e) => void save(tasks.map((x) => (x.id === task.id ? { ...x, enabled: e.target.checked } : x)))}
                />
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => void runNow(task)}>
                  {busy === task.id ? <Spinner size={14} /> : <Icon name="play" size={14} />}
                  {t('Run now')}
                </button>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => setEditing(task)}>
                  {t('Edit')}
                </button>
                <button type="button" className="btn icon sm" style={{ width: 40, minHeight: 40, color: 'var(--red-text)' }} aria-label={t('Delete the task {name}', { name: ACTION_LABEL[task.action] })} disabled={!!busy} onClick={() => setRemove(task)}>
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
            void save(next, d.id ? t('Task updated') : t('Task scheduled'));
          }}
        />
      )}
      {remove && (
        <ConfirmDialog
          title={t('Delete the task {name}?', { name: ACTION_LABEL[remove.action] })}
          text={describe(remove)}
          confirmLabel={t('Delete')}
          danger
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const r = remove;
            setRemove(null);
            void save(
              tasks.filter((x) => x.id !== r.id),
              t('Task deleted'),
            );
          }}
        />
      )}
    </section>
  );
}
