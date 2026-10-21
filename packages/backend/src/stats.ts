import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';

export type SampleFn = (cpuPct: number, memMb: number) => void;

/**
 * Samples CPU and memory of one process. On Windows a single long-lived PowerShell loop
 * reports CPU time and working set (wmic is gone from current Windows builds); on Linux
 * it reads /proc; elsewhere it polls `ps`.
 */
export class ProcessSampler {
  private ps?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private last?: { cpuMs: number; wall: number };
  private readonly cpus = Math.max(1, os.cpus().length);

  constructor(
    private readonly pid: number,
    private readonly intervalMs: number,
    private readonly onSample: SampleFn,
  ) {}

  start(): void {
    if (process.platform === 'win32') this.startWindows();
    else this.timer = setInterval(() => void this.pollUnix(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.ps?.kill();
    this.ps = undefined;
  }

  private report(cpuMs: number, memBytes: number): void {
    const wall = Date.now();
    if (this.last) {
      const dWall = wall - this.last.wall;
      const dCpu = cpuMs - this.last.cpuMs;
      const pct = dWall > 0 ? Math.min(100, Math.max(0, (dCpu / dWall / this.cpus) * 100)) : 0;
      this.onSample(Math.round(pct * 10) / 10, Math.round(memBytes / 1024 / 1024));
    }
    this.last = { cpuMs, wall };
  }

  private startWindows(): void {
    const script =
      `$p=${this.pid}; while($true){ $x=Get-Process -Id $p -ErrorAction SilentlyContinue; if(-not $x){break}; ` +
      `[Console]::Out.WriteLine(([long]$x.TotalProcessorTime.TotalMilliseconds).ToString() + ' ' + $x.WorkingSet64.ToString()); ` +
      `[Console]::Out.Flush(); Start-Sleep -Milliseconds ${this.intervalMs} }`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    ps.on('error', () => undefined);
    readline.createInterface({ input: ps.stdout! }).on('line', (line) => {
      const [cpu, mem] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(cpu) && Number.isFinite(mem)) this.report(cpu!, mem!);
    });
    this.ps = ps;
  }

  private async pollUnix(): Promise<void> {
    try {
      if (process.platform === 'linux') {
        const stat = (await readFile(`/proc/${this.pid}/stat`, 'utf8')).split(') ')[1]!.split(' ');
        const ticks = Number(stat[11]) + Number(stat[12]);
        const rssPages = Number((await readFile(`/proc/${this.pid}/statm`, 'utf8')).split(' ')[1]);
        this.report((ticks / 100) * 1000, rssPages * 4096);
        return;
      }
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn('ps', ['-o', 'time=,rss=', '-p', String(this.pid)]);
        let s = '';
        p.stdout.on('data', (d) => (s += d));
        p.on('error', reject);
        p.on('exit', () => resolve(s));
      });
      const [time, rss] = out.trim().split(/\s+/);
      if (!time || !rss) return;
      const parts = time.split(/[:.]/).map(Number);
      const [m = 0, sec = 0, cs = 0] = parts.length === 3 ? parts : [0, ...parts];
      this.report((m * 60 + sec) * 1000 + cs * 10, Number(rss) * 1024);
    } catch {
      // The process exited between polls.
    }
  }
}
