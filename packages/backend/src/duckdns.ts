// DuckDNS: a free name (something.duckdns.org) that follows the home's changing public address.
import { fetchOk } from './http.ts';
import { UserError } from './providers/types.ts';
import { t } from '@srvmc/shared';

/** "Muj-Server.duckdns.org" → "muj-server". Throws on anything DuckDNS would not accept. */
export function normalizeDuckDomain(input: string): string {
  const name = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.duckdns\.org\.?$/, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new UserError(t('Enter the subdomain name from DuckDNS, e.g. my-server.'));
  return name;
}

export function checkDuckToken(token: string): string {
  const trimmed = token.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) throw new UserError(t('A DuckDNS token looks like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'));
  return trimmed;
}

/** Points the name at the address the request comes from. False when DuckDNS refuses (wrong token or name). */
export async function updateDuckDns(domain: string, token: string): Promise<boolean> {
  const q = new URLSearchParams({ domains: domain, token, ip: '' });
  const text = (await (await fetchOk(`https://www.duckdns.org/update?${q}`, { timeoutMs: 15_000 })).text()).trim();
  return text.startsWith('OK');
}
