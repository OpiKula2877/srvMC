// Watches every server: restarts after crashes, puts idle servers to sleep and wakes them when a
// player joins, keeps the disk limit, measures TPS and records the load history.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { editionOf } from '@srvmc/shared';
import { analyzeCrash } from './crash.ts';
import { checkDiskRoom, folderSize, sizeMb } from './disk.ts';
import type { MetricHistory } from './history.ts';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import { readServerProperties } from './properties.ts';
import { tpsProbeFor } from './tps.ts';
import { WakeListener } from './wake.ts';

const MINUTE = 60_000;
/** Crash restarts allowed within the window before the watchdog gives up. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW = 10 * MINUTE;
const RESTART_DELAY = 10_000;
/** Missed TPS answers in a row (one a minute) before a server counts as frozen. */
const FROZEN_AFTER = 5;

const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;

export class Supervisor {
  private readonly listeners = new Map<string, WakeListener>();
  private readonly wakeQueue = new Map<string, Promise<void>>();
  private readonly wakeFailed = new Set<string>();
  private readonly crashes = new Map<string, number[]>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly startedAt = new Map<string, number>();
  private readonly emptySince = new Map<string, number>();
  private readonly probes = new Map<string, { answered: boolean; missed: number }>();
  private readonly overLimit = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly manager: ServerManager,
    private readonly history: MetricHistory,
  ) {
    for (const inst of manager.all()) this.attach(inst);
    manager.on('added', (inst: ServerInstance) => this.attach(inst));
    manager.on('deleted', (id: string) => void this.forget(id));
    manager.on('configured', (id: string) => {
      const inst = manager.get(id);
      void this.syncWake(inst);
      void this.refreshDisk(inst);
    });
    manager.on('files-changed', (id: string) => void this.refreshDisk(manager.get(id)));
    manager.addStartGuard((inst) => this.beforeStart(inst));
  }

  start(): void {
    this.timers.push(setInterval(() => void this.minuteTick(), MINUTE));
    this.timers.push(setInterval(() => this.sleepTick(), 30_000));
    this.timers.push(setInterval(() => void this.diskTick(), 5 * MINUTE));
    void this.diskTick();
    for (const inst of this.manager.all()) void this.syncWake(inst);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    await Promise.all([...this.listeners.values()].map((l) => l.close()));
    this.listeners.clear();
    await this.history.flushAll();
  }

  private attach(inst: ServerInstance): void {
    const id = inst.cfg.id;
    inst.on('metrics', (point) => this.history.record(id, point));
    inst.on('status', () => {
      if (inst.status === 'starting' && !this.startedAt.has(id)) this.startedAt.set(id, Date.now());
      if (inst.status === 'running' && !this.emptySince.has(id) && inst.players.size === 0) this.emptySince.set(id, Date.now());
      if (inst.players.size > 0) this.emptySince.delete(id);
      // After a crash, onExit decides first whether a restart comes.
      if (inst.status !== 'crashed') void this.syncWake(inst);
    });
    inst.on('exit', ({ crashed }: { crashed: boolean }) => void this.onExit(inst, crashed));
  }

  private async forget(id: string): Promise<void> {
    clearTimeout(this.restartTimers.get(id));
    this.restartTimers.delete(id);
    await this.listeners.get(id)?.close();
    this.listeners.delete(id);
    for (const m of [this.crashes, this.startedAt, this.emptySince, this.probes]) m.delete(id);
    this.overLimit.delete(id);
    await this.history.remove(id);
  }

  // ---- crashes ----

  private async onExit(inst: ServerInstance, crashed: boolean): Promise<void> {
    const id = inst.cfg.id;
    const since = this.startedAt.get(id) ?? Date.now() - MINUTE;
    this.startedAt.delete(id);
    this.emptySince.delete(id);
    this.probes.delete(id);
    await this.history.flush(id);
    if (!crashed) return void this.syncWake(inst);

    const info = await analyzeCrash({ dir: inst.dir, since, log: inst.log, port: inst.cfg.port, code: inst.lastError?.match(/kód (\S+)\)/)?.[1] ?? null });
    inst.lastCrash = info;
    inst.pushLog('error', `Příčina: ${info.summary}${info.suspects.length ? ` · Podezřelé: ${info.suspects.join(', ')}` : ''}`);
    inst.emit('status');

    if (inst.cfg.crashRestart === false) return void this.syncWake(inst);
    if (info.permanent) {
      inst.pushLog('warn', 'Restart by nepomohl, server nechávám vypnutý.');
      return void this.syncWake(inst);
    }
    const now = Date.now();
    const recent = (this.crashes.get(id) ?? []).filter((t) => now - t < CRASH_WINDOW);
    recent.push(now);
    this.crashes.set(id, recent);
    if (recent.length > CRASH_LIMIT) {
      inst.pushLog('error', `Server spadl ${recent.length}× za 10 minut. Automatický restart vypínám, dokud ho nespustíš ručně.`);
      return void this.syncWake(inst);
    }
    inst.pushLog('system', `Restartuji za ${RESTART_DELAY / 1000} s (pokus ${recent.length} z ${CRASH_LIMIT}).`);
    this.restartTimers.set(
      id,
      setTimeout(() => {
        this.restartTimers.delete(id);
        if (inst.running || inst.status !== 'crashed') return;
        void this.manager.start(id).catch((err: Error) => {
          inst.pushLog('error', `Restart po pádu selhal: ${err.message}`);
          void this.syncWake(inst);
        });
      }, RESTART_DELAY),
    );
  }

  // ---- TPS, frozen servers ----

  private async minuteTick(): Promise<void> {
    await Promise.all(this.manager.all().map((inst) => this.probeTps(inst)));
  }

  private async probeTps(inst: ServerInstance): Promise<void> {
    if (inst.status !== 'running') return;
    const probe = tpsProbeFor(inst.cfg);
    if (!probe) return;
    const id = inst.cfg.id;
    const tps = await inst.probe(probe.command, probe.answer, (l) => probe.parse(l));
    const state = this.probes.get(id) ?? { answered: false, missed: 0 };
    this.probes.set(id, state);
    if (tps !== null) {
      inst.tps = tps;
      inst.tpsAt = Date.now();
      state.answered = true;
      state.missed = 0;
      return;
    }
    // Only a server that answered before can be "frozen"; some versions simply lack the command.
    if (!state.answered || inst.status !== 'running') return;
    state.missed++;
    if (state.missed >= FROZEN_AFTER) {
      state.missed = 0;
      inst.pushLog('error', `Server ${FROZEN_AFTER} minut neodpovídá. Ukončuji ho jako zamrzlý.`);
      inst.kill(true);
    }
  }

  // ---- sleep and wake ----

  private sleepTick(): void {
    const now = Date.now();
    for (const inst of this.manager.all()) {
      const id = inst.cfg.id;
      const after = inst.cfg.sleepAfterMin ?? 0;
      if (!after || inst.status !== 'running') continue;
      if (inst.players.size > 0 || inst.task || inst.pregen.state === 'running') {
        this.emptySince.delete(id);
        continue;
      }
      const since = this.emptySince.get(id) ?? now;
      this.emptySince.set(id, since);
      if (now - since >= after * MINUTE) {
        this.emptySince.delete(id);
        inst.pushLog('system', `Nikdo nehraje ${after} min, uspávám server.${inst.cfg.wakeOnJoin ? ' Probudí se, až se někdo připojí.' : ''}`);
        void this.manager.stop(id).catch(() => undefined);
      }
    }
  }

  private wantsWake(inst: ServerInstance): boolean {
    return (
      !!inst.cfg.wakeOnJoin &&
      // The listener speaks the Java protocol only: Bedrock (NetherNet) and Hytale (QUIC) cannot be answered yet.
      editionOf(inst.cfg.type) === 'java' &&
      inst.cfg.installed &&
      !inst.running &&
      !inst.launching &&
      !inst.installing &&
      (inst.status === 'stopped' || inst.status === 'crashed') &&
      !this.restartTimers.has(inst.cfg.id)
    );
  }

  /** Opens or closes the wake listener to match the server's state. Calls are queued per server. */
  syncWake(inst: ServerInstance): Promise<void> {
    const id = inst.cfg.id;
    const next = (this.wakeQueue.get(id) ?? Promise.resolve()).then(() => this.applyWake(inst)).catch(() => undefined);
    this.wakeQueue.set(id, next);
    return next;
  }

  private async applyWake(inst: ServerInstance): Promise<void> {
    const id = inst.cfg.id;
    let listener = this.listeners.get(id);
    const want = this.wantsWake(inst);
    if (listener && (!want || listener.opts.port !== inst.cfg.port || !listener.listening)) {
      this.listeners.delete(id);
      await listener.close();
      listener = undefined;
    }
    if (want && !listener) {
      const onJoin = (name: string | null) => {
        this.listeners.delete(id);
        inst.sleeping = false;
        inst.pushLog('system', `${name ?? 'Hráč'} se chce připojit – probouzím server.`);
        void this.manager.start(id).catch((err: Error) => {
          inst.pushLog('error', `Probuzení selhalo: ${err.message}`);
          void this.syncWake(inst);
        });
      };
      listener = new WakeListener({ port: inst.cfg.port, kickMessage: 'Server se probouzí. Připoj se znovu za chvilku.', status: () => this.wakeStatus(inst), onJoin });
      try {
        await listener.open();
        this.listeners.set(id, listener);
        this.wakeFailed.delete(id);
      } catch (err) {
        listener = undefined;
        if (!this.wakeFailed.has(id)) inst.pushLog('warn', `Probouzení nejde zapnout – port ${inst.cfg.port} je obsazený (${(err as Error).message}).`);
        this.wakeFailed.add(id);
      }
    }
    const sleeping = !!listener?.listening;
    if (sleeping !== inst.sleeping) {
      inst.sleeping = sleeping;
      inst.emit('status');
    }
  }

  private async wakeStatus(inst: ServerInstance): Promise<{ motd: string; maxPlayers: number; favicon?: string }> {
    const { values } = await readServerProperties(inst.dir);
    const first = (values.get('motd') ?? inst.cfg.name).split('\n')[0]!;
    const icon = await readFile(path.join(inst.dir, 'server-icon.png')).catch(() => null);
    return {
      motd: `${first}\n§6Spí · připoj se a probudí se`,
      maxPlayers: Number(values.get('max-players')) || 20,
      favicon: icon && icon.length < 64 * 1024 ? `data:image/png;base64,${icon.toString('base64')}` : undefined,
    };
  }

  /** Runs before every start: frees the port from the wake listener and checks the disk limit. */
  private async beforeStart(inst: ServerInstance): Promise<void> {
    const id = inst.cfg.id;
    clearTimeout(this.restartTimers.get(id));
    this.restartTimers.delete(id);
    // A listener that is just opening must finish before it can be closed.
    await this.wakeQueue.get(id);
    const listener = this.listeners.get(id);
    if (listener) {
      this.listeners.delete(id);
      await listener.close();
      inst.sleeping = false;
    }
    if (inst.cfg.diskLimitMb) {
      await this.refreshDisk(inst);
      checkDiskRoom(inst.cfg, inst.diskUsageMb);
    }
  }

  // ---- disk ----

  private async diskTick(): Promise<void> {
    for (const inst of this.manager.all()) await this.refreshDisk(inst);
  }

  async refreshDisk(inst: ServerInstance): Promise<void> {
    if (inst.installing) return;
    const mb = sizeMb(await folderSize(inst.dir));
    if (mb !== inst.diskUsageMb) {
      inst.diskUsageMb = mb;
      inst.emit('status');
    }
    const id = inst.cfg.id;
    const limit = inst.cfg.diskLimitMb ?? 0;
    if (!limit || mb <= limit) {
      this.overLimit.delete(id);
      return;
    }
    if (!this.overLimit.has(id)) {
      this.overLimit.add(id);
      inst.pushLog('warn', `Složka serveru má ${gb(mb)}, limit je ${gb(limit)}.`);
    }
    // A little headroom so a world that just crossed the line is not cut off mid-game.
    if (inst.running && inst.status === 'running' && mb > limit * 1.1) {
      inst.pushLog('error', `Server přerostl limit disku o víc než 10 % (${gb(mb)} z ${gb(limit)}), zastavuji ho.`);
      void this.manager.stop(id).catch(() => undefined);
    }
  }
}
