import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BEDROCK_UDP_PORTS, editionOf, portProtocol, serverTypeInfo, type ServerType, type CreateServerRequest, type LogLine, type ScheduledTask, type ServerConfig, type ServerInfo, type TaskKind, type UpdateServerRequest } from '@srvmc/shared';
import { rememberXuid } from './bedrockplayers.ts';
import { applyChunkyLine, isChunkyInstalled } from './chunky.ts';
import { downloadToCache } from './download.ts';
import { platformArgs, runJava } from './installer.ts';
import { levelOf, reapOrphan, ServerInstance } from './instance.ts';
import { ensureJava } from './java.ts';
import { buildJvmArgs, splitJvmArgs } from './jvm.ts';
import { isPortFree, isUdpPortFree } from './net.ts';
import type { Paths } from './paths.ts';
import { updateServerProperties } from './properties.ts';
import { providerFor, UserError } from './providers/index.ts';
import { bedrockPortProps } from './providers/bedrock.ts';
import { hytaleVersion } from './providers/hytale.ts';
import type { ServerStore } from './store.ts';

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

const MB = 1024 * 1024;
const TIMEZONE_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const mb = (bytes: number) => (bytes / MB).toFixed(1).replace('.', ',');

/**
 * Owns every server: persistence, installation, lifecycle. Events:
 * 'server' (ServerInfo), 'deleted' (id), 'log' (id, LogLine[]), 'metrics' (id, MetricPoint),
 * 'added' (ServerInstance), 'configured' (id, after a settings change), 'files-changed' (id).
 */
export class ServerManager extends EventEmitter {
  private readonly instances = new Map<string, ServerInstance>();
  private readonly startGuards: ((inst: ServerInstance) => Promise<void>)[] = [];

  constructor(
    private readonly paths: Paths,
    private readonly store: ServerStore,
  ) {
    super();
  }

  async init(): Promise<void> {
    for (const cfg of await this.store.load()) {
      const inst = this.add(cfg);
      if (!cfg.installed) inst.setStatus('error', 'Instalace nebyla dokončena. Server smaž a vytvoř znovu.');
      const orphan = await reapOrphan(inst.dir, this.paths.runtimes);
      if (orphan) inst.pushLog('warn', `Server běžel dál bez srvMC (PID ${orphan}) – ukončil jsem ho, aby uvolnil port a svět.`);
    }
  }

  /** Starts servers marked for autostart. Failures are logged on the server, not thrown. */
  async autoStart(): Promise<void> {
    for (const inst of this.instances.values()) {
      if (inst.cfg.autoStart && inst.cfg.installed) {
        await this.start(inst.cfg.id).catch((err: Error) => inst.pushLog('error', `Autostart selhal: ${err.message}`));
      }
    }
  }

  private dirFor(id: string): string {
    return path.join(this.paths.servers, id);
  }

  private add(cfg: ServerConfig): ServerInstance {
    const inst = new ServerInstance(cfg, this.dirFor(cfg.id));
    inst.on('status', () => this.emit('server', this.info(inst)));
    inst.on('log', (lines: LogLine[]) => {
      this.emit('log', cfg.id, lines);
      let pregen = inst.pregen;
      for (const l of lines) pregen = applyChunkyLine(pregen, l.text) ?? pregen;
      if (pregen !== inst.pregen) {
        inst.pregen = pregen;
        inst.emit('status');
      }
    });
    void this.refreshPregen(inst);
    inst.on('metrics', (point) => this.emit('metrics', cfg.id, point));
    inst.on('persist', () => void this.persist());
    inst.on('xuid', (name: string, xuid: string) => void rememberXuid(inst.dir, name, xuid).catch(() => undefined));
    this.instances.set(cfg.id, inst);
    this.emit('added', inst);
    return inst;
  }

  /** Re-checks whether Chunky is in the plugins/mods folder. */
  async refreshPregen(inst: ServerInstance): Promise<void> {
    const installed = await isChunkyInstalled(inst);
    if (installed !== inst.pregen.installed) {
      inst.pregen = { ...inst.pregen, installed };
      inst.emit('status');
    }
  }

  private persist(): Promise<void> {
    return this.store.save([...this.instances.values()].map((i) => i.cfg));
  }

  info(inst: ServerInstance): ServerInfo {
    return {
      ...inst.cfg,
      status: inst.status,
      players: [...inst.players],
      startedAt: inst.startedAt,
      install: inst.install,
      task: inst.task,
      pregen: inst.pregen,
      lastError: inst.lastError,
      dir: inst.dir,
      sleeping: inst.sleeping || undefined,
      diskUsageMb: inst.diskUsageMb,
      tps: inst.tps,
      lastCrash: inst.lastCrash,
      notice: inst.notice,
      // The webhook URL is a credential: the panel only learns whether one is set.
      discord: inst.cfg.discord && { webhook: '', events: inst.cfg.discord.events },
      discordSet: !!inst.cfg.discord,
    };
  }

  /**
   * Runs a long job (backup, restore, import) on a server. Only one runs at a time, and the
   * progress shows up in the panel through the server's `task` field.
   */
  async runTask<T>(id: string, kind: TaskKind, text: string, job: (report: (pct: number | null, text?: string) => void) => Promise<T>): Promise<T> {
    const inst = this.get(id);
    if (inst.task) throw new UserError('Na serveru už běží jiná úloha. Počkej, až doběhne.');
    if (inst.installing) throw new UserError('Počkej, až doběhne instalace.');
    let current = text;
    inst.setTask({ kind, pct: null, text });
    try {
      return await job((pct, t) => {
        if (t) current = t;
        inst.setTask({ kind, pct, text: current });
      });
    } finally {
      inst.setTask(undefined);
    }
  }

  list(): ServerInfo[] {
    return [...this.instances.values()].map((i) => this.info(i));
  }

  get(id: string): ServerInstance {
    const inst = this.instances.get(id);
    if (!inst) throw new NotFoundError('Server neexistuje.');
    return inst;
  }

  private portTaken(port: number, exceptId?: string): ServerInstance | undefined {
    return [...this.instances.values()].find((i) => i.cfg.port === port && i.cfg.id !== exceptId);
  }

  /** A free port for a new server of `type`: from 25565 (Java), 19132 in blocks of 20 (Bedrock and its UDP ports) or 5520 (Hytale, UDP). */
  async suggestPort(type: ServerType = 'vanilla'): Promise<number> {
    const start = serverTypeInfo(type).defaultPort;
    const udp = portProtocol(type) === 'UDP';
    const step = editionOf(type) === 'bedrock' ? BEDROCK_UDP_PORTS : 1;
    for (let port = start; port < start + 400 * step; port += step) {
      if (this.portTaken(port)) continue;
      if (udp ? await isUdpPortFree(port) : await isPortFree(port)) return port;
    }
    return start;
  }

  private validateRam(ramMaxMb: number): void {
    const totalMb = Math.floor(os.totalmem() / MB);
    if (!Number.isInteger(ramMaxMb) || ramMaxMb < 512) throw new UserError('Server potřebuje aspoň 512 MB RAM.');
    if (ramMaxMb > totalMb - 512) throw new UserError(`Počítač má jen ${Math.floor(totalMb / 1024)} GB RAM. Nech něco i pro Windows.`);
  }

  private validatePort(port: number, exceptId?: string): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UserError('Port musí být číslo 1024–65535.');
    const other = this.portTaken(port, exceptId);
    if (other) throw new UserError(`Port ${port} už používá server „${other.cfg.name}“.`);
  }

  async create(req: CreateServerRequest): Promise<ServerInfo> {
    const name = req.name.trim();
    if (name.length < 1 || name.length > 48) throw new UserError('Název musí mít 1–48 znaků.');
    if (!providerFor(req.type)) throw new UserError('Tento typ serveru zatím není podporovaný.');
    if (!req.eulaAccepted) throw new UserError('Bez souhlasu s Minecraft EULA server nepoběží.');
    this.validatePort(req.port);
    this.validateRam(req.ramMaxMb);

    const cfg: ServerConfig = {
      id: randomUUID(),
      name,
      type: req.type,
      version: req.version,
      build: req.build || undefined,
      port: req.port,
      ramMinMb: Math.min(1024, req.ramMaxMb),
      ramMaxMb: req.ramMaxMb,
      jvmFlags: 'aikar',
      extraJvmArgs: '',
      eulaAccepted: true,
      autoStart: false,
      installed: false,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.dirFor(cfg.id), { recursive: true });
    const inst = this.add(cfg);
    inst.installing = true;
    inst.setStatus('installing', '');
    await this.persist();
    void this.install(inst, req.startAfterInstall);
    return this.info(inst);
  }

  private async install(inst: ServerInstance, startAfter: boolean): Promise<void> {
    const cfg = inst.cfg;
    const provider = providerFor(cfg.type)!;
    try {
      inst.setInstall({ step: 'plan', pct: null, text: 'Zjišťuji, co je potřeba stáhnout' });
      const plan = await provider.plan(cfg.version, cfg.build, { paths: this.paths });
      const what = plan.modpack ? `modpack ${plan.modpack.title} ${plan.modpack.versionNumber} (${plan.modpack.loader} ${plan.displayVersion})` : `${cfg.type} ${cfg.version} (build ${plan.build})`;
      inst.pushLog('system', `Instaluji ${what}${plan.native ? '' : `, Java ${plan.javaMajor}`}`);

      // Native servers (Bedrock) bring their own program; nobody needs Java for them.
      const java = plan.native ? '' : await ensureJava(this.paths, plan.javaMajor, (text, pct) => inst.setInstall({ step: 'java', pct, text }));

      for (const file of plan.files) {
        const src = await downloadToCache(this.paths, file, (done, total) =>
          inst.setInstall({
            step: 'download',
            pct: total ? Math.round((done / total) * 100) : null,
            text: total ? `Stahuji ${file.fileName} · ${mb(done)} z ${mb(total)} MB` : `Stahuji ${file.fileName} · ${mb(done)} MB`,
          }),
        );
        await copyFile(src, path.join(inst.dir, file.target));
      }

      let launchArgs = plan.launchJar ? ['-jar', plan.launchJar] : [];
      if (plan.install) {
        launchArgs = await plan.install({
          dir: inst.dir,
          port: cfg.port,
          name: cfg.name,
          java,
          javaMajor: plan.javaMajor,
          paths: this.paths,
          log: (text) => inst.pushLog('system', text),
          progress: (text, pct, link) => inst.setInstall({ step: 'installer', pct, text, ...(link && { link }) }),
          ensureJdk: () => ensureJava(this.paths, plan.javaMajor, (text, pct) => inst.setInstall({ step: 'java', pct, text }), 'jdk'),
          run: (args, opts) =>
            runJava(opts?.java ?? java, args, {
              cwd: opts?.cwd ?? inst.dir,
              timeoutMs: opts?.timeoutMs,
              onLine: (line) => {
                inst.pushLog(levelOf(line), `[instalátor] ${line}`);
                opts?.onLine?.(line);
              },
            }),
        });
      }
      if (launchArgs.length === 0) throw new UserError('Instalace neurčila, jak server spustit.');

      const edition = editionOf(cfg.type);
      inst.setInstall({ step: 'config', pct: null, text: 'Připravuji nastavení serveru' });
      // Velocity has no EULA and no server.properties; it keeps everything in velocity.toml.
      if (edition === 'java' && cfg.type !== 'velocity') {
        await writeFile(path.join(inst.dir, 'eula.txt'), `# Souhlas s https://aka.ms/MinecraftEULA udělen v srvMC ${new Date().toISOString()}\neula=true\n`);
        await this.writeProperties(inst, { 'server-port': String(cfg.port), 'query.port': String(cfg.port), motd: cfg.name });
      } else if (edition === 'bedrock') {
        // Mojang ships an empty, enabled allow list; like Java's white list it starts off.
        await this.writeProperties(inst, { ...bedrockPortProps(cfg.port), 'server-name': cfg.name, 'allow-list': 'false' });
      }

      cfg.build = plan.build;
      if (plan.displayVersion) cfg.version = plan.displayVersion;
      if (edition === 'hytale') cfg.version = (await hytaleVersion(this.paths.runtimes)) ?? cfg.version;
      if (plan.modpack) cfg.modpack = plan.modpack;
      cfg.javaMajor = plan.native ? undefined : plan.javaMajor;
      cfg.runtime = plan.native ? 'native' : undefined;
      cfg.launchArgs = launchArgs;
      cfg.launchJar = plan.native ? launchArgs[0] : (launchArgs.find((a) => a.endsWith('.jar') && !a.startsWith('@')) ?? launchArgs.find((a) => a.startsWith('@'))?.slice(1));
      cfg.installed = true;
      await this.persist();
      inst.installing = false;
      inst.install = undefined;
      inst.pushLog('system', 'Instalace hotová.');
      inst.setStatus('stopped', '');
      if (startAfter) await this.start(cfg.id);
    } catch (err) {
      const msg = (err as Error).message;
      inst.installing = false;
      inst.install = undefined;
      inst.pushLog('error', `Instalace selhala: ${msg}`);
      inst.setStatus('error', `Instalace selhala: ${msg}`);
    }
  }

  private writeProperties(inst: ServerInstance, updates: Record<string, string>): Promise<void> {
    return updateServerProperties(inst.dir, updates);
  }

  async start(id: string): Promise<ServerInfo> {
    const inst = this.get(id);
    const cfg = inst.cfg;
    if (inst.running) return this.info(inst);
    const launch = cfg.launchArgs ?? (cfg.launchJar ? ['-jar', cfg.launchJar] : null);
    if (!cfg.installed || !launch) throw new UserError('Server ještě není nainstalovaný.');
    if (inst.task && inst.task.kind !== 'backup') throw new UserError('Počkej, až doběhne obnova nebo import světa.');
    if (inst.launching) return this.info(inst);

    inst.launching = true;
    try {
      for (const guard of this.startGuards) await guard(inst);
      const free = portProtocol(cfg.type) === 'UDP' ? await isUdpPortFree(cfg.port) : await isPortFree(cfg.port);
      if (!free) throw new UserError(`Port ${cfg.port} je obsazený jiným programem.`);
      if (cfg.runtime === 'native') {
        inst.start(path.join(inst.dir, launch[0]!), launch.slice(1));
      } else {
        const java = await ensureJava(this.paths, cfg.javaMajor ?? 21, (text, pct) => inst.setInstall({ step: 'java', pct, text }));
        inst.setInstall(undefined);
        await this.refreshPregen(inst);
        // Hytale takes its port on the command line and does not know Minecraft's "nogui".
        // Velocity's argument parser refuses Minecraft's "nogui".
        const tail = editionOf(cfg.type) === 'hytale' ? ['--bind', `0.0.0.0:${cfg.port}`] : cfg.type === 'velocity' ? [] : ['nogui'];
        inst.start(java, [...buildJvmArgs(cfg), ...platformArgs(launch), ...tail]);
      }
    } finally {
      inst.launching = false;
      // A failed start lets the watchers (wake listener) take the port back.
      if (!inst.running) inst.emit('status');
    }
    return this.info(inst);
  }

  /** Checks that run before every start, e.g. freeing the port from the wake listener. They may throw. */
  addStartGuard(guard: (inst: ServerInstance) => Promise<void>): void {
    this.startGuards.push(guard);
  }

  all(): ServerInstance[] {
    return [...this.instances.values()];
  }

  async setSchedule(id: string, tasks: ScheduledTask[]): Promise<void> {
    const inst = this.get(id);
    inst.cfg.schedule = tasks.length ? tasks : undefined;
    await this.persist();
  }

  /** Changes stored settings that have no field in UpdateServerRequest (network options). */
  async saveConfig(id: string, mutate: (cfg: ServerConfig) => void): Promise<void> {
    const inst = this.get(id);
    mutate(inst.cfg);
    await this.persist();
    inst.emit('status');
  }

  async recordTaskRun(id: string, taskId: string, result: string): Promise<void> {
    const task = this.instances.get(id)?.cfg.schedule?.find((t) => t.id === taskId);
    if (!task) return;
    task.lastRun = Date.now();
    task.lastResult = result;
    await this.persist();
  }

  async stop(id: string): Promise<ServerInfo> {
    const inst = this.get(id);
    await inst.stop();
    return this.info(inst);
  }

  async restart(id: string): Promise<ServerInfo> {
    await this.stop(id);
    return this.start(id);
  }

  kill(id: string): ServerInfo {
    const inst = this.get(id);
    inst.kill();
    return this.info(inst);
  }

  command(id: string, command: string): void {
    this.get(id).sendCommand(command);
  }

  async update(id: string, patch: UpdateServerRequest): Promise<ServerInfo> {
    const inst = this.get(id);
    const cfg = inst.cfg;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 48) throw new UserError('Název musí mít 1–48 znaků.');
      cfg.name = name;
    }
    if (patch.port !== undefined && patch.port !== cfg.port) {
      this.validatePort(patch.port, id);
      cfg.port = patch.port;
      const edition = editionOf(cfg.type);
      // Hytale gets its port on the command line at every start.
      if (cfg.installed && edition !== 'hytale' && cfg.type !== 'velocity') {
        await this.writeProperties(
          inst,
          edition === 'bedrock' ? bedrockPortProps(cfg.port) : { 'server-port': String(cfg.port), 'query.port': String(cfg.port) },
        );
      }
    }
    if (patch.ramMaxMb !== undefined) {
      this.validateRam(patch.ramMaxMb);
      cfg.ramMaxMb = patch.ramMaxMb;
      cfg.ramMinMb = Math.min(cfg.ramMinMb, cfg.ramMaxMb);
    }
    if (patch.ramMinMb !== undefined) cfg.ramMinMb = Math.max(256, Math.min(patch.ramMinMb, cfg.ramMaxMb));
    if (patch.jvmFlags !== undefined) cfg.jvmFlags = patch.jvmFlags;
    if (patch.extraJvmArgs !== undefined) {
      try {
        splitJvmArgs(patch.extraJvmArgs);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      cfg.extraJvmArgs = patch.extraJvmArgs;
    }
    if (patch.timezone !== undefined) {
      if (patch.timezone && !TIMEZONE_RE.test(patch.timezone)) throw new UserError('Neplatné časové pásmo.');
      cfg.timezone = patch.timezone || undefined;
    }
    if (patch.autoStart !== undefined) cfg.autoStart = patch.autoStart;
    if (patch.backupSchedule !== undefined) cfg.backupSchedule = patch.backupSchedule;
    if (patch.backupTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.backupTime)) throw new UserError('Čas zálohy zadej jako HH:MM.');
      cfg.backupTime = patch.backupTime;
    }
    if (patch.backupKeep !== undefined) cfg.backupKeep = Math.min(100, Math.max(1, Math.round(patch.backupKeep)));
    if (patch.crashRestart !== undefined) cfg.crashRestart = patch.crashRestart;
    if (patch.wakeOnJoin !== undefined) cfg.wakeOnJoin = patch.wakeOnJoin;
    if (patch.sleepAfterMin !== undefined) cfg.sleepAfterMin = Math.min(24 * 60, Math.max(0, Math.round(patch.sleepAfterMin))) || undefined;
    if (patch.diskLimitMb !== undefined) cfg.diskLimitMb = Math.min(10 * 1024 * 1024, Math.max(0, Math.round(patch.diskLimitMb))) || undefined;
    await this.persist();
    inst.emit('status');
    this.emit('configured', id);
    return this.info(inst);
  }

  async delete(id: string): Promise<void> {
    const inst = this.get(id);
    if (inst.running) throw new UserError('Nejdřív server zastav.');
    if (inst.installing) throw new UserError('Počkej, až doběhne instalace.');
    if (inst.task) throw new UserError('Počkej, až doběhne úloha na serveru.');
    this.instances.delete(id);
    await this.persist();
    await rm(inst.dir, { recursive: true, force: true, maxRetries: 3 });
    this.emit('deleted', id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].filter((i) => i.running).map((i) => i.stop(30_000)));
  }
}
