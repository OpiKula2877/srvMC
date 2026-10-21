// Helpers for installer-based server types (Forge, NeoForge, Quilt, BuildTools).
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { UserError } from './providers/types.ts';

const DROP = new Set(['java', 'javaw', '@user_jvm_args.txt', '%*', '"$@"', '$@', 'nogui', 'pause']);

/** Splits a shell line into words, keeping quoted parts together. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * Reads the launch arguments from the run.bat / run.sh a Forge or NeoForge installer writes,
 * e.g. "java @user_jvm_args.txt @libraries/.../win_args.txt %*" or "java -jar forge-…-shim.jar".
 * JVM options are left out; srvMC passes its own.
 */
export function parseRunScript(text: string): string[] | null {
  let found: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^"?java(w)?(\.exe)?"?\s/i.test(line)) continue;
    // Newer Forge scripts first run the shim with --onlyCheckJava; the real launch comes later.
    if (/--onlyCheckJava/i.test(line)) continue;
    const args = words(line)
      .slice(1)
      .filter((w) => !DROP.has(w) && !/^-X(ms|mx)/.test(w));
    if (args.includes('-jar') || args.some((a) => a.startsWith('@'))) found = args;
  }
  return found;
}

/** Forge/NeoForge write win_args.txt and unix_args.txt; pick the one for this OS at start time. */
export function platformArgs(args: string[], platform: NodeJS.Platform = process.platform): string[] {
  return args.map((a) =>
    platform === 'win32' ? a.replace(/unix_args\.txt$/, 'win_args.txt') : a.replace(/win_args\.txt$/, 'unix_args.txt'),
  );
}

/** Finds how to start a Forge-family server after its installer ran. */
export async function forgeLaunchArgs(dir: string, prefix: 'forge' | 'neoforge'): Promise<string[]> {
  for (const script of process.platform === 'win32' ? ['run.bat', 'run.sh'] : ['run.sh', 'run.bat']) {
    const text = await readFile(path.join(dir, script), 'utf8').catch(() => null);
    const args = text && parseRunScript(text);
    if (args) return args;
  }
  // Forge 1.16.5 and older: no run script, just a launchable jar.
  const jars = (await readdir(dir)).filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.jar') && !n.includes('installer'));
  const jar = jars.find((n) => n.includes('shim')) ?? jars.find((n) => n.includes('universal')) ?? jars[0];
  if (!jar) throw new UserError('Instalátor neskončil správně – nenašel jsem, čím server spustit.');
  return ['-jar', jar];
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Tools started by an installer (Maven in BuildTools) find Java through JAVA_HOME and PATH, so point both at ours. */
export function javaEnv(java: string): NodeJS.ProcessEnv {
  const bin = path.dirname(java);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...process.env, JAVA_HOME: path.dirname(bin), [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}` };
}

/** Runs Java to completion, streaming its output line by line. */
export function runJava(java: string, args: string[], opts: RunOptions): Promise<void> {
  return runProgram(java, args, { ...opts, env: javaEnv(java) });
}

/** Runs a program to completion, streaming its output line by line. */
export function runProgram(exe: string, args: string[], opts: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new UserError('Instalátor běžel moc dlouho a byl ukončen.'));
    }, opts.timeoutMs ?? 30 * 60_000);
    for (const stream of [p.stdout, p.stderr]) {
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => {
        if (l.trim()) opts.onLine?.(l);
      });
    }
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new UserError(`Instalátor skončil s chybou (kód ${code}). Podrobnosti jsou v konzoli.`));
    });
  });
}
