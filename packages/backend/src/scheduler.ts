// Scheduled tasks per server: restart, start, stop, backup or a console command, on weekdays at a
// time or every N minutes. Restarts and stops can count down in chat first.
import { randomBytes } from 'node:crypto';
import type { ScheduleAction, ScheduledTask, ScheduleState } from '@srvmc/shared';
import type { BackupService } from './backups.ts';
import type { ServerManager } from './manager.ts';
import { UserError } from './providers/types.ts';

const MINUTE = 60_000;
/** Chat countdown before a restart or stop, in seconds before the run. */
export const WARNINGS = [300, 60, 10];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIONS = new Set<ScheduleAction>(['restart', 'start', 'stop', 'backup', 'command']);
export const MAX_TASKS = 30;

/** Next run strictly after `from`, or null when the task never runs. */
export function nextTaskRun(task: Pick<ScheduledTask, 'enabled' | 'repeat' | 'time' | 'days' | 'everyMin'>, from: number): number | null {
  if (!task.enabled || !TIME_RE.test(task.time)) return null;
  const [h, m] = task.time.split(':').map(Number) as [number, number];
  if (task.repeat === 'interval') {
    const step = Math.max(5, task.everyMin ?? 60) * MINUTE;
    const anchor = new Date(from);
    anchor.setHours(h, m, 0, 0);
    let t = anchor.getTime();
    // Count from the latest anchor at or before `from` (yesterday's when today's is still ahead).
    if (t > from) t -= Math.ceil((t - from) / step) * step;
    return t + (Math.floor((from - t) / step) + 1) * step;
  }
  const days = new Set(task.days);
  if (days.size === 0) return null;
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > from && days.has(d.getDay())) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return null;
}

/** Validates tasks sent by the panel. Ids and run history of known tasks are kept; new tasks get an id. */
export function sanitizeTasks(input: unknown, existing: ScheduledTask[] = []): ScheduledTask[] {
  if (!Array.isArray(input)) throw new UserError('Neplatný seznam úloh.');
  if (input.length > MAX_TASKS) throw new UserError(`Nejvýš ${MAX_TASKS} úloh na server.`);
  return input.map((raw: Partial<ScheduledTask>) => {
    if (!raw || typeof raw !== 'object') throw new UserError('Neplatná úloha.');
    const action = raw.action as ScheduleAction;
    if (!ACTIONS.has(action)) throw new UserError('Neznámá akce.');
    const time = String(raw.time ?? '');
    if (!TIME_RE.test(time)) throw new UserError('Čas zadej jako HH:MM.');
    const repeat = raw.repeat === 'interval' ? 'interval' : 'days';
    const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (repeat === 'days' && days.length === 0) throw new UserError('Vyber aspoň jeden den.');
    const everyMin = repeat === 'interval' ? Math.round(Number(raw.everyMin)) : undefined;
    if (everyMin !== undefined && !(everyMin >= 5 && everyMin <= 1440)) throw new UserError('Interval musí být 5 minut až 24 hodin.');
    let command: string | undefined;
    if (action === 'command') {
      command = String(raw.command ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
      if (!command || command.length > 300) throw new UserError('Zadej příkaz (nejvýš 300 znaků).');
    }
    const known = typeof raw.id === 'string' ? existing.find((t) => t.id === raw.id) : undefined;
    return {
      id: known?.id ?? randomBytes(6).toString('hex'),
      action,
      ...(command !== undefined && { command }),
      repeat,
      time,
      days: repeat === 'days' ? days : [],
      ...(everyMin !== undefined && { everyMin }),
      warn: (action === 'restart' || action === 'stop') && raw.warn !== false,
      enabled: raw.enabled !== false,
      ...(known?.lastRun !== undefined && { lastRun: known.lastRun, lastResult: known.lastResult }),
    };
  });
}

const signature = (t: ScheduledTask) => JSON.stringify([t.enabled, t.repeat, t.time, t.days, t.everyMin]);

function countdownText(action: ScheduleAction, seconds: number): string {
  const when = seconds >= 60 ? `${seconds / 60} ${seconds === 60 ? 'minutu' : seconds < 300 ? 'minuty' : 'minut'}` : `${seconds} sekund`;
  return action === 'restart' ? `Server se restartuje za ${when}.` : `Server se vypne za ${when}.`;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  /** Next run per server|task, recomputed when the task's timing changes. */
  private readonly due = new Map<string, { sig: string; at: number | null }>();
  private readonly warned = new Set<string>();
  private readonly running = new Set<string>();

  constructor(
    private readonly manager: ServerManager,
    private readonly backups: BackupService,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private nextFor(serverId: string, task: ScheduledTask, now: number): number | null {
    const key = `${serverId}|${task.id}`;
    const sig = signature(task);
    const cached = this.due.get(key);
    if (cached && cached.sig === sig) return cached.at;
    const at = nextTaskRun(task, now);
    this.due.set(key, { sig, at });
    return at;
  }

  state(serverId: string): ScheduleState {
    const tasks = this.manager.get(serverId).cfg.schedule ?? [];
    const now = Date.now();
    return { tasks, next: Object.fromEntries(tasks.map((t) => [t.id, this.nextFor(serverId, t, now)])) };
  }

  async save(serverId: string, input: unknown): Promise<ScheduleState> {
    const inst = this.manager.get(serverId);
    const tasks = sanitizeTasks(input, inst.cfg.schedule);
    await this.manager.setSchedule(serverId, tasks);
    for (const k of this.due.keys()) if (k.startsWith(`${serverId}|`)) this.due.delete(k);
    return this.state(serverId);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const server of this.manager.list()) {
      for (const task of server.schedule ?? []) {
        const at = this.nextFor(server.id, task, now);
        if (at === null) continue;
        const inst = this.manager.get(server.id);
        if (task.warn && inst.status === 'running' && inst.players.size > 0) {
          for (const s of WARNINGS) {
            const key = `${server.id}|${task.id}|${at}|${s}`;
            // Only when we are near the warning point (a task created 2 minutes ahead skips the 5-minute one).
            if (now >= at - s * 1000 && now < at - s * 1000 + 30_000 && !this.warned.has(key)) {
              this.warned.add(key);
              try {
                inst.sendCommand(`say ${countdownText(task.action, s)}`);
              } catch {
                // The server went down meanwhile.
              }
            }
          }
        }
        if (now >= at) {
          this.due.delete(`${server.id}|${task.id}`);
          for (const k of this.warned) if (k.startsWith(`${server.id}|${task.id}|`)) this.warned.delete(k);
          void this.run(server.id, task.id);
        }
      }
    }
  }

  /** Runs a task now (also from the panel's "run now"). Returns what happened. */
  async run(serverId: string, taskId: string): Promise<string> {
    const key = `${serverId}|${taskId}`;
    const inst = this.manager.get(serverId);
    const task = inst.cfg.schedule?.find((t) => t.id === taskId);
    if (!task) throw new UserError('Úloha neexistuje.');
    if (this.running.has(key)) throw new UserError('Úloha už běží.');
    this.running.add(key);
    let result = 'ok';
    try {
      const up = inst.running;
      switch (task.action) {
        case 'restart':
          if (!up) result = 'Přeskočeno – server neběžel.';
          else await this.manager.restart(serverId);
          break;
        case 'start':
          if (up) result = 'Přeskočeno – server už běžel.';
          else await this.manager.start(serverId);
          break;
        case 'stop':
          if (!up) result = 'Přeskočeno – server neběžel.';
          else await this.manager.stop(serverId);
          break;
        case 'backup':
          await this.backups.create(serverId, 'auto');
          break;
        case 'command':
          if (!up) result = 'Přeskočeno – server neběžel.';
          else inst.sendCommand(task.command ?? '');
          break;
      }
      inst.pushLog('system', `Plánovač: ${ACTION_LABEL[task.action]}${task.action === 'command' ? ` „${task.command}“` : ''}${result === 'ok' ? '' : ` – ${result}`}`);
    } catch (err) {
      result = `Chyba: ${(err as Error).message}`;
      inst.pushLog('error', `Plánovač: ${ACTION_LABEL[task.action]} selhal – ${(err as Error).message}`);
    } finally {
      this.running.delete(key);
    }
    await this.manager.recordTaskRun(serverId, taskId, result).catch(() => undefined);
    return result;
  }

  forget(serverId: string): void {
    for (const k of this.due.keys()) if (k.startsWith(`${serverId}|`)) this.due.delete(k);
  }
}

const ACTION_LABEL: Record<ScheduleAction, string> = {
  restart: 'restart',
  start: 'zapnutí',
  stop: 'vypnutí',
  backup: 'záloha',
  command: 'příkaz',
};
