// Velocity proxy from PaperMC's Fill API. srvMC writes velocity.toml from the default the jar carries:
// its own port, modern player forwarding with a secret, and the servers behind it.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJarEntries } from '../jarmeta.ts';
import { paperFamily } from './paper.ts';
import type { Provider } from './types.ts';

const base = paperFamily('velocity', 'velocity');

/** Sets `key = value` among the top-level keys (before the first [table]). */
export function setTomlKey(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable < 0 ? lines.length : firstTable;
  const re = new RegExp(`^${key.replace(/[.-]/g, '\\$&')}\\s*=`);
  for (let i = 0; i < end; i++) {
    if (re.test(lines[i]!)) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return lines.join('\n');
}

/** Replaces the body of a [table] up to the next table header. */
export function replaceTomlTable(text: string, table: string, body: string[]): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${table}]`);
  const block = [`[${table}]`, ...body, ''];
  if (start < 0) return `${text.replace(/\s*$/, '')}\n\n${block.join('\n')}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end]!)) end++;
  lines.splice(start, end - start, ...block);
  return lines.join('\n');
}

const tomlString = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** The [servers] table: alias = "127.0.0.1:port" for each server, tried in this order. */
export function serversTable(servers: { alias: string; port: number }[]): string[] {
  return [
    ...servers.map((s) => `${s.alias} = ${tomlString(`127.0.0.1:${s.port}`)}`),
    `try = [${servers.map((s) => tomlString(s.alias)).join(', ')}]`,
  ];
}

export function velocityConfig(template: string, port: number, motd: string, servers: { alias: string; port: number }[]): string {
  let t = setTomlKey(template, 'bind', tomlString(`0.0.0.0:${port}`));
  t = setTomlKey(t, 'motd', tomlString(motd));
  t = setTomlKey(t, 'player-info-forwarding-mode', '"modern"');
  t = setTomlKey(t, 'forwarding-secret-file', '"forwarding.secret"');
  t = replaceTomlTable(t, 'servers', serversTable(servers));
  // The default forced hosts point at example servers that do not exist; Velocity refuses those.
  return replaceTomlTable(t, 'forced-hosts', []);
}

/** The forwarding secret backends must share; created once. */
export async function forwardingSecret(dir: string): Promise<string> {
  const file = path.join(dir, 'forwarding.secret');
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (existing.length >= 12) return existing;
  const secret = randomBytes(18).toString('base64url');
  await writeFile(file, secret, 'utf8');
  return secret;
}

export function velocityJava(version: string): number {
  return Number(version.split('.')[0]) >= 4 ? 25 : 21;
}

export const velocity: Provider = {
  ...base,
  async plan(version, build, env) {
    const p = await base.plan(version, build, env);
    return {
      ...p,
      // Velocity picks its own Java whatever Minecraft version its players run: 4.x is built for 25, 3.x for 21.
      javaMajor: velocityJava(version),
      async install(ctx) {
        const jar = path.join(ctx.dir, p.launchJar!);
        const template = (await readJarEntries(jar, new Set(['default-velocity.toml']))).get('default-velocity.toml');
        await forwardingSecret(ctx.dir);
        if (template) await writeFile(path.join(ctx.dir, 'velocity.toml'), velocityConfig(template, ctx.port, ctx.name, []), 'utf8');
        else ctx.log('Velocity v sobě nemá výchozí velocity.toml; vytvoří si ho při prvním startu.');
        return ['-jar', p.launchJar!];
      },
    };
  },
};
