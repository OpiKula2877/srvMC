// Own domain: which DNS records to add at the registrar, and whether they are live yet.
import { Resolver } from 'node:dns/promises';
import type { DnsRecord, DomainCheck, DomainConfig } from '@srvmc/shared';
import { UserError } from './providers/types.ts';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: DomainConfig): DomainConfig {
  const clean = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.+$/, '');
  const zone = clean(input.zone);
  const sub = clean(input.sub ?? '');
  if (!zone.includes('.') || !zone.split('.').every((l) => LABEL.test(l))) throw new UserError('Zadej doménu, např. mojedomena.cz.');
  if (sub && !sub.split('.').every((l) => LABEL.test(l))) throw new UserError('Subdoména smí mít jen písmena, číslice a pomlčky.');
  if (!['ip', 'duckdns', 'playit'].includes(input.target)) throw new UserError('Neznámý cíl domény.');
  return { zone, sub, target: input.target };
}

export const fullHost = (d: DomainConfig) => (d.sub ? `${d.sub}.${d.zone}` : d.zone);

export interface RecordContext {
  port: number;
  publicIp: string | null;
  /** DuckDNS name without .duckdns.org */
  duckdns?: string;
  /** Where the playit tunnel ends up (host from playit's own SRV record). */
  playit?: { host: string; port: number } | null;
  /** Java clients follow SRV records; Bedrock and Hytale do not, so their players type the port. */
  srv?: boolean;
}

/** The records for the chosen target. SRV lets players leave out the port (Java only). */
export function recordsFor(d: DomainConfig, ctx: RecordContext): DnsRecord[] {
  const name = d.sub || '@';
  const srvName = d.sub ? `_minecraft._tcp.${d.sub}` : '_minecraft._tcp';
  const useSrv = ctx.srv !== false;
  const srv = (port: number, target: string): DnsRecord[] => (useSrv ? [{ type: 'SRV', name: srvName, value: `0 5 ${port} ${target}` }] : []);
  if (d.target === 'ip') {
    const out: DnsRecord[] = [{ type: 'A', name, value: ctx.publicIp ?? '?' }];
    if (ctx.port !== 25565) out.push(...srv(ctx.port, fullHost(d)));
    return out;
  }
  if (d.target === 'duckdns') {
    if (!ctx.duckdns) return [];
    const duck = `${ctx.duckdns}.duckdns.org`;
    // A CNAME cannot sit on the bare domain; there the address goes in directly.
    const out: DnsRecord[] = [d.sub ? { type: 'CNAME', name, value: duck } : { type: 'A', name, value: ctx.publicIp ?? '?' }];
    if (ctx.port !== 25565) out.push(...srv(ctx.port, duck));
    return out;
  }
  if (!ctx.playit) return [];
  const out: DnsRecord[] = srv(ctx.playit.port, ctx.playit.host);
  if (d.sub) out.unshift({ type: 'CNAME', name, value: ctx.playit.host });
  return out;
}

const trimDot = (s: string) => s.replace(/\.$/, '').toLowerCase();

export type Lookup = {
  resolve4(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  resolveSrv(host: string): Promise<{ name: string; port: number; priority: number; weight: number }[]>;
};

function publicResolver(): Lookup {
  // Public resolvers, so the answer is what players see, not a stale cache in the router.
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

export async function checkDomain(d: DomainConfig, expected: DnsRecord[], lookup: Lookup = publicResolver()): Promise<DomainCheck> {
  const host = fullHost(d);
  const absolute = (name: string) => (name === '@' ? d.zone : `${name}.${d.zone}`);
  const results: DomainCheck['records'] = [];
  for (const record of expected) {
    const at = absolute(record.name);
    let found: string | null = null;
    let ok = false;
    try {
      if (record.type === 'A') {
        const ips = await lookup.resolve4(at);
        found = ips.join(', ') || null;
        ok = ips.includes(record.value);
      } else if (record.type === 'CNAME') {
        const names = (await lookup.resolveCname(at)).map(trimDot);
        found = names.join(', ') || null;
        ok = names.includes(trimDot(record.value));
      } else {
        const [, , port, target] = record.value.split(' ');
        const srvs = await lookup.resolveSrv(at);
        found = srvs.map((s) => `${s.priority} ${s.weight} ${s.port} ${trimDot(s.name)}`).join(', ') || null;
        ok = srvs.some((s) => s.port === Number(port) && trimDot(s.name) === trimDot(target!));
      }
    } catch {
      // ENOTFOUND / ENODATA: not there (yet).
    }
    results.push({ record, found, ok });
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  const missing = results.filter((r) => !r.ok).map((r) => `${r.record.type} ${r.record.name}`);
  return {
    host,
    records: results,
    ok,
    message: ok
      ? `DNS ověřeno – ${host} vede na tvůj server.`
      : results.length === 0
        ? 'Nejdřív nastav cíl domény (DuckDNS nebo playit.gg tunel).'
        : `Zatím nesedí: ${missing.join(', ')}. Změna DNS se projeví za 5 až 60 minut.`,
  };
}
