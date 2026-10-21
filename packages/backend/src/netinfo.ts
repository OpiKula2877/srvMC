// Where this computer sits on the network: its LAN address, the public address, and whether a
// port can be reached from the internet.
import dgram from 'node:dgram';
import { cached, fetchJson } from './http.ts';

/** The LAN address of the interface that routes to the internet. A UDP "connect" sends nothing. */
export function lanIp(target = '8.8.8.8'): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {
      sock.close();
      resolve(null);
    });
    sock.connect(53, target, () => {
      const addr = sock.address().address;
      sock.close();
      resolve(addr && addr !== '0.0.0.0' ? addr : null);
    });
  });
}

export function publicIp(): Promise<string | null> {
  return cached('public-ip', 5 * 60_000, async () => {
    const res = await fetchJson<{ ip: string }>('https://api.ipify.org?format=json', { timeoutMs: 8000 });
    return isIpv4(res.ip) ? res.ip : null;
  }).catch(() => null);
}

export function isIpv4(s: string | null | undefined): s is string {
  return !!s && /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
}

function octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

/** 10/8, 172.16/12, 192.168/16 */
export function isPrivateIp(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/** 100.64.0.0/10 – the range providers use for carrier-grade NAT. */
export function isCgnatIp(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 100 && b! >= 64 && b! <= 127;
}

/**
 * Behind CGNAT (or a second router) the router's own internet address is not the public one.
 * Null when the router does not say (no UPnP).
 */
export function detectCgnat(routerIp: string | null, publicAddr: string | null): boolean | null {
  if (!routerIp) return null;
  if (isCgnatIp(routerIp) || isPrivateIp(routerIp)) return true;
  if (!publicAddr) return null;
  return routerIp !== publicAddr;
}

/**
 * Asks an outside service to ping the address like a Minecraft client would. Something must answer
 * on the port (the server, or srvMC's sleep listener).
 */
export async function checkFromInternet(address: string): Promise<boolean> {
  const a = encodeURIComponent(address);
  try {
    const res = await fetchJson<{ online: boolean }>(`https://api.mcstatus.io/v2/status/java/${a}?timeout=5`, { timeoutMs: 15_000 });
    return res.online;
  } catch {
    const res = await fetchJson<{ online: boolean }>(`https://api.mcsrvstat.us/3/${a}`, { timeoutMs: 15_000 });
    return res.online;
  }
}
