// A small UPnP Internet Gateway Device client: find the router (SSDP), then open or close ports
// and read its internet address over SOAP.
import dgram from 'node:dgram';
import { fetchOk } from './http.ts';
import { lanIp } from './netinfo.ts';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export interface Gateway {
  /** SOAP endpoint of the WAN connection service. */
  controlUrl: string;
  serviceType: string;
  /** Our address as the router sees it (the mapping target). */
  localIp: string;
}

/** Sends M-SEARCH and collects LOCATION headers of answering devices. */
export async function discoverLocations(timeoutMs = 2500): Promise<string[]> {
  // With VPN or virtual adapters the default multicast interface may not be the home network.
  const iface = await lanIp();
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set<string>();
    const finish = () => {
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    sock.on('error', finish);
    sock.on('message', (msg) => {
      const loc = /^location:\s*(\S+)/im.exec(msg.toString('utf8'))?.[1];
      if (loc && /^https?:\/\//i.test(loc)) found.add(loc);
    });
    sock.bind(0, () => {
      if (iface) {
        try {
          sock.setMulticastInterface(iface);
        } catch {
          // Keep the default interface.
        }
      }
      for (const st of SEARCH_TARGETS) {
        const req = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(req, SSDP_PORT, SSDP_ADDR);
      }
    });
    setTimeout(finish, timeoutMs);
  });
}

/** Finds the WANIPConnection / WANPPPConnection service in a device description. */
export function parseDescription(xml: string, location: string): { controlUrl: string; serviceType: string } | null {
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] ?? location;
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) ?? []) {
    const type = /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (type && control && /WAN(IP|PPP)Connection:\d/.test(type)) {
      return { controlUrl: new URL(control, base).toString(), serviceType: type };
    }
  }
  return null;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function soapBody(serviceType: string, action: string, args: Record<string, string | number>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`
  );
}

export class UpnpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

async function soap(gw: Gateway, action: string, args: Record<string, string | number>): Promise<string> {
  const res = await fetch(gw.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
    body: soapBody(gw.serviceType, action, args),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = Number(/<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1]) || undefined;
    const desc = /<errorDescription>([^<]*)<\/errorDescription>/.exec(text)?.[1];
    throw new UpnpError(desc ? `${desc} (${code})` : `HTTP ${res.status}`, code);
  }
  return text;
}

/** Finds the router. Null when nothing on the network speaks UPnP (or it is switched off). */
export async function findGateway(): Promise<Gateway | null> {
  for (const location of await discoverLocations()) {
    try {
      const xml = await (await fetchOk(location, { timeoutMs: 5000 })).text();
      const svc = parseDescription(xml, location);
      if (!svc) continue;
      const localIp = await lanIp(new URL(location).hostname);
      if (localIp) return { ...svc, localIp };
    } catch {
      // Not a usable device; try the next answer.
    }
  }
  return null;
}

export async function externalIp(gw: Gateway): Promise<string | null> {
  const xml = await soap(gw, 'GetExternalIPAddress', {});
  return /<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/.exec(xml)?.[1] || null;
}

export interface Mapping {
  port: number;
  protocol: 'TCP' | 'UDP';
  description: string;
}

/**
 * Opens a port on the router towards this computer. Permanent first; routers that only take
 * leases get two hours (srvMC renews mappings while they are wanted).
 */
export async function addMapping(gw: Gateway, m: Mapping): Promise<void> {
  const args = (lease: number) => ({
    NewRemoteHost: '',
    NewExternalPort: m.port,
    NewProtocol: m.protocol,
    NewInternalPort: m.port,
    NewInternalClient: gw.localIp,
    NewEnabled: 1,
    NewPortMappingDescription: m.description,
    NewLeaseDuration: lease,
  });
  try {
    await soap(gw, 'AddPortMapping', args(0));
  } catch (err) {
    // 718 ConflictInMappingEntry: another device holds the port. Other refusals may just want a lease.
    if (err instanceof UpnpError && err.code === 718) throw new UpnpError('Port na routeru už používá jiné zařízení.', 718);
    await soap(gw, 'AddPortMapping', args(7200));
  }
}

export async function deleteMapping(gw: Gateway, m: Pick<Mapping, 'port' | 'protocol'>): Promise<void> {
  try {
    await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.protocol });
  } catch (err) {
    // 714 NoSuchEntryInArray: already gone.
    if (!(err instanceof UpnpError && err.code === 714)) throw err;
  }
}
