import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { editionOf, type CrashInfo, type Edition, type InstallProgress, type LogLevel, type LogLine, type MetricPoint, type PregenStatus, type ServerConfig, type ServerStatus, type TaskProgress } from '@srvmc/shared';
import { parseDeviceLogin } from './providers/hytale.ts';
import { UserError } from './providers/index.ts';
import { ProcessSampler } from './stats.ts';

const PID_FILE = '.srvmc.pid';

function processPath(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    return readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.split('\0')[0] ?? null, () => null);
  }
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], { windowsHide: true, timeout: 10_000 }, (err, out) =>
      resolve(err ? null : out.trim() || null),
    );
  });
}

/**
 * A server left running after srvMC was killed keeps its port and world lock. If the PID it left
 * behind still belongs to one of srvMC's own Java runtimes, end that process.
 */
export async function reapOrphan(dir: string, runtimesDir: string): Promise<number | null> {
  const pid = Number(await readFile(path.join(dir, PID_FILE), 'utf8').catch(() => ''));
  await rm(path.join(dir, PID_FILE), { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const exe = await processPath(pid);
  // Ours: Java from srvMC's runtimes, or a native server program inside the server folder (Bedrock).
  const inside = (base: string) => !!exe && path.resolve(exe).toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep);
  if (!inside(runtimesDir) && !inside(dir)) return null;
  try {
    process.kill(pid);
    return pid;
  } catch {
    return null;
  }
}

const LOG_LIMIT = 2000;
const METRIC_LIMIT = 300;

const DONE_RE = /Done \([\d.,]+s\)!/;
const JOIN_RE = /\]: ([A-Za-z0-9_.]{1,16}) joined the game/;
const LEAVE_RE = /\]: ([A-Za-z0-9_.]{1,16}) left the game/;
// Bedrock: "[2026-10-21 12:00:00:123 INFO] Player connected: Big Steve, xuid: 2535…"
const BEDROCK_JOIN_RE = /Player connected: (.+?), xuid: (\d*)/;
const BEDROCK_LEAVE_RE = /Player disconnected: (.+?), xuid/;
// Velocity: "[connected player] Steve (/127.0.0.1:52634) has connected"
const PROXY_JOIN_RE = /\[connected player\] ([A-Za-z0-9_.]{1,16}) \([^)]*\) has connected/;
const PROXY_LEAVE_RE = /\[connected player\] ([A-Za-z0-9_.]{1,16}) \([^)]*\) has disconnected/;

/** The console command that shuts a server down: Velocity calls it "end". */
export function stopCommand(type: ServerConfig['type']): string {
  return type === 'velocity' ? 'end' : 'stop';
}
/** Hytale does not document a "ready" line; when none of these shows, a running process counts after this long. */
const HYTALE_READY_AFTER = 90_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function levelOf(text: string): LogLevel {
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception\b|^\s+at /.test(text)) return 'error';
  if (/\bWARN(ING)?\b/.test(text)) return 'warn';
  return 'info';
}

export function parsePlayerEvent(text: string, edition: Edition = 'java'): { join?: string; leave?: string; xuid?: string } {
  if (edition === 'bedrock') {
    const j = BEDROCK_JOIN_RE.exec(text);
    if (j) return { join: j[1], ...(j[2] && { xuid: j[2] }) };
    const l = BEDROCK_LEAVE_RE.exec(text);
    return l ? { leave: l[1] } : {};
  }
  const j = JOIN_RE.exec(text) ?? PROXY_JOIN_RE.exec(text);
  if (j) return { join: j[1] };
  const l = LEAVE_RE.exec(text) ?? PROXY_LEAVE_RE.exec(text);
  if (l) return { leave: l[1] };
  return {};
}

export function isDoneLine(text: string, edition: Edition = 'java'): boolean {
  if (edition === 'bedrock') return /\bServer started\./.test(text);
  if (edition === 'hytale') return /Server started|Hytale Server Booted|Listening on/i.test(text);
  return DONE_RE.test(text);
}

/**
 * One server process: start/stop, console I/O, parsed state (players, ready) and metrics.
 * Events: 'status' (no args), 'log' (LogLine[]), 'metrics' (MetricPoint), 'exit' ({ crashed }).
 */
export class ServerInstance extends EventEmitter {
  status: ServerStatus = 'stopped';
  readonly players = new Set<string>();
  startedAt?: number;
  lastError?: string;
  install?: InstallProgress;
  installing = false;
  /** Set while srvMC prepares a start (Java check, guards) before the process exists. */
  launching = false;
  task?: TaskProgress;
  pregen: PregenStatus = { installed: false, state: 'idle', pct: 0, chunks: 0 };
  readonly log: LogLine[] = [];
  readonly metrics: MetricPoint[] = [];
  /** Latest ticks per second and when they were measured. */
  tps?: number;
  tpsAt?: number;
  sleeping = false;
  diskUsageMb?: number;
  lastCrash?: CrashInfo;
  notice?: { text: string; link?: string };
  private login: { link?: string; code?: string } = {};

  private proc?: ChildProcess;
  private sampler?: ProcessSampler;
  private stopRequested = false;
  /** While set, console lines matching `re` are answers to a probe and stay out of the log. */
  private quiet?: { re: RegExp; until: number; onLine: (text: string) => void };
  private pending: LogLine[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor(
    public cfg: ServerConfig,
    readonly dir: string,
  ) {
    super();
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  setStatus(status: ServerStatus, error?: string): void {
    this.status = status;
    if (error !== undefined) this.lastError = error || undefined;
    this.emit('status');
  }

  setInstall(progress: InstallProgress | undefined): void {
    this.install = progress;
    this.emit('status');
  }

  setTask(task: TaskProgress | undefined): void {
    this.task = task;
    this.emit('status');
  }

  /** Resolves with the first console line matching `re` that arrives after this call, or null on timeout. */
  waitForLine(re: RegExp, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const onLog = (lines: LogLine[]) => {
        const hit = lines.find((l) => re.test(l.text));
        if (hit) finish(hit.text);
      };
      const finish = (value: string | null) => {
        clearTimeout(timer);
        this.off('log', onLog);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on('log', onLog);
    });
  }

  pushLog(level: LogLevel, text: string): void {
    const line: LogLine = { t: Date.now(), level, text };
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.pending.push(line);
    this.flushTimer ??= setTimeout(() => this.flush(), 100);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.emit('log', lines);
  }

  start(java: string, args: string[]): void {
    if (this.proc) throw new UserError('Server už běží.');
    this.stopRequested = false;
    this.players.clear();
    this.setStatus('starting', '');
    const edition = editionOf(this.cfg.type);
    this.pushLog('system', this.cfg.runtime === 'native' ? `Spouštím ${this.cfg.launchJar}` : `Spouštím ${this.cfg.launchJar} · Java ${this.cfg.javaMajor} · ${this.cfg.ramMaxMb} MB RAM`);
    if (edition === 'hytale') {
      setTimeout(() => {
        if (this.proc === proc && this.status === 'starting') {
          this.pushLog('system', 'Hytale nenapsal, že je připravený, ale běží – beru ho jako spuštěný.');
          this.ready();
        }
      }, HYTALE_READY_AFTER).unref();
    }

    const proc = spawn(java, args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.startedAt = Date.now();

    proc.on('error', (err) => {
      this.pushLog('error', `Nepodařilo se spustit Javu: ${err.message}`);
      // A process that never started emits no 'close'.
      if (this.proc === proc && proc.pid === undefined) this.onExit(-1, null);
    });
    readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity }).on('line', (l) => this.onLine(l, false));
    readline.createInterface({ input: proc.stderr!, crlfDelay: Infinity }).on('line', (l) => this.onLine(l, true));
    proc.on('close', (code, signal) => {
      if (this.proc === proc) this.onExit(code, signal);
    });

    if (proc.pid) {
      void writeFile(path.join(this.dir, PID_FILE), String(proc.pid)).catch(() => undefined);
      this.sampler = new ProcessSampler(proc.pid, 2000, (cpu, memMb) => {
        const now = Date.now();
        const tps = this.tpsAt && now - this.tpsAt < 150_000 ? this.tps : undefined;
        const point: MetricPoint = { t: now, cpu, memMb, players: this.players.size, ...(tps !== undefined && { tps }) };
        this.metrics.push(point);
        if (this.metrics.length > METRIC_LIMIT) this.metrics.splice(0, this.metrics.length - METRIC_LIMIT);
        this.emit('metrics', point);
      });
      this.sampler.start();
    }
  }

  private onLine(raw: string, fromStderr: boolean): void {
    const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
    if (text.trim() === '' || text.trim() === '>') return;
    if (this.quiet && Date.now() < this.quiet.until && this.quiet.re.test(text)) {
      this.quiet.onLine(text);
      return;
    }
    const level = levelOf(text);
    this.pushLog(fromStderr && level === 'info' ? 'warn' : level, text);

    const edition = editionOf(this.cfg.type);
    if (this.status === 'starting' && isDoneLine(text, edition)) this.ready();
    if (edition === 'hytale') this.watchHytaleLogin(text);
    const ev = parsePlayerEvent(text, edition);
    if (ev.join) {
      this.players.add(ev.join);
      if (ev.xuid) this.emit('xuid', ev.join, ev.xuid);
      this.emit('player', 'join', ev.join);
      this.emit('status');
    } else if (ev.leave) {
      this.players.delete(ev.leave);
      this.emit('player', 'leave', ev.leave);
      this.emit('status');
    }
  }

  private ready(): void {
    this.pushLog('system', 'Server je připravený. Hráči se mohou připojit.');
    this.setStatus('running');
    // A new Hytale server has to sign in to the owner's account once before players can join.
    if (editionOf(this.cfg.type) === 'hytale' && !this.cfg.hytaleAuthed) {
      try {
        this.sendCommand('auth login device');
      } catch {
        // went down meanwhile
      }
    }
  }

  /** Shows the Hytale sign-in link as a notice and keeps the credentials once it worked. */
  private watchHytaleLogin(text: string): void {
    if (/Authentication successful/i.test(text)) {
      this.notice = undefined;
      this.login = {};
      if (!this.cfg.hytaleAuthed) {
        this.sendCommand('auth persistence Encrypted');
        this.cfg.hytaleAuthed = true;
        this.emit('persist');
      }
      this.emit('status');
      return;
    }
    if (parseDeviceLogin(text, this.login) && this.login.link) {
      this.notice = { text: `Přihlas server k účtu Hytale${this.login.code ? ` – kód ${this.login.code}` : ''}`, link: this.login.link };
      this.emit('status');
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    void rm(path.join(this.dir, PID_FILE), { force: true });
    this.sampler?.stop();
    this.sampler = undefined;
    this.proc = undefined;
    this.players.clear();
    this.startedAt = undefined;
    this.quiet = undefined;
    this.tps = undefined;
    this.tpsAt = undefined;
    const crashed = !this.stopRequested && code !== 0;
    if (crashed) {
      // Windows reports exit codes as unsigned 32-bit numbers (4294967295 = -1).
      const shown = code !== null && code > 2 ** 31 ? code - 2 ** 32 : (code ?? signal);
      const msg = `Server spadl (kód ${shown}).`;
      this.pushLog('error', msg);
      this.setStatus('crashed', msg);
    } else {
      this.pushLog('system', 'Server zastaven.');
      this.setStatus('stopped', '');
    }
    this.flush();
    this.emit('exit', { crashed });
  }

  sendCommand(command: string): void {
    const stdin = this.proc?.stdin;
    if (!stdin?.writable) throw new UserError('Server neběží.');
    const clean = command.replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
    if (!clean) return;
    if (clean === stopCommand(this.cfg.type) || clean === 'stop') this.stopRequested = true;
    this.pushLog('cmd', `> ${clean}`);
    stdin.write(`${clean}\n`);
  }

  /**
   * Sends a command whose answer stays out of the console (lines matching `answer` within the
   * timeout). Resolves with the first value `parse` reads, or null when nothing came back.
   */
  probe<T>(command: string, answer: RegExp, parse: (line: string) => T | null, timeoutMs = 5000): Promise<T | null> {
    const stdin = this.proc?.stdin;
    if (!stdin?.writable || this.quiet) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const quiet = {
        re: answer,
        until: Date.now() + timeoutMs,
        onLine: (text: string) => {
          const v = parse(text);
          if (v !== null && !settled) {
            settled = true;
            resolve(v);
          }
        },
      };
      this.quiet = quiet;
      // The window stays open after the answer, so its remaining lines are hidden too.
      setTimeout(() => {
        if (this.quiet === quiet) this.quiet = undefined;
        if (!settled) resolve(null);
      }, timeoutMs);
      stdin.write(`${command}\n`);
    });
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('exit', done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('exit', done);
    });
  }

  async stop(timeoutMs = 60_000): Promise<void> {
    if (!this.proc) return;
    this.stopRequested = true;
    this.setStatus('stopping');
    try {
      this.sendCommand(stopCommand(this.cfg.type));
    } catch {
      // stdin already closed; fall through to the kill below
    }
    if (!(await this.waitForExit(timeoutMs))) {
      this.pushLog('warn', 'Server neodpověděl včas, ukončuji ho násilně.');
      this.kill();
      await this.waitForExit(10_000);
    }
  }

  /** Ends the process at once. `asCrash` treats it as a crash (a frozen server), so the crash watchdog reacts. */
  kill(asCrash = false): void {
    if (!this.proc) return;
    this.stopRequested = !asCrash;
    this.proc.kill('SIGKILL');
  }
}
