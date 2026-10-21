// DuckDNS: a free name (something.duckdns.org) that follows the home's changing public address.
import { fetchOk } from './http.ts';
import { UserError } from './providers/types.ts';

/** "Muj-Server.duckdns.org" → "muj-server". Throws on anything DuckDNS would not accept. */
export function normalizeDuckDomain(input: string): string {
  const name = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.duckdns\.org\.?$/, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new UserError('Zadej název subdomény z DuckDNS, např. muj-server.');
  return name;
}

export function checkDuckToken(token: string): string {
  const t = token.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) throw new UserError('Token z DuckDNS má tvar xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.');
  return t;
}

/** Points the name at the address the request comes from. False when DuckDNS refuses (wrong token or name). */
export async function updateDuckDns(domain: string, token: string): Promise<boolean> {
  const q = new URLSearchParams({ domains: domain, token, ip: '' });
  const text = (await (await fetchOk(`https://www.duckdns.org/update?${q}`, { timeoutMs: 15_000 })).text()).trim();
  return text.startsWith('OK');
}
