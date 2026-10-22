import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainConfig } from '@srvmc/shared';
import { checkDomain, fullHost, normalizeDomain, recordsFor, type Lookup } from '../src/dnscheck.ts';
import { checkDuckToken, normalizeDuckDomain } from '../src/duckdns.ts';
import { detectCgnat, isCgnatIp, isIpv4, isPrivateIp } from '../src/netinfo.ts';
import { claimUrl, playitCall, PlayitApiError, toTunnels, tunnelRequest } from '../src/playit.ts';
import { seal, unseal, type SecretBox } from '../src/secrets.ts';
import { addMapping, deleteMapping, externalIp, parseDescription, soapBody, type Gateway } from '../src/upnp.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addresses', () => {
  it('classifies IPv4 ranges', () => {
    expect(isIpv4('203.0.113.42')).toBe(true);
    expect(isIpv4('256.1.1.1')).toBe(false);
    expect(isIpv4('::1')).toBe(false);
    expect(isPrivateIp('192.168.1.20')).toBe(true);
    expect(isPrivateIp('172.20.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isCgnatIp('100.72.1.1')).toBe(true);
    expect(isCgnatIp('100.128.0.1')).toBe(false);
  });

  it('spots CGNAT and double NAT from the router address', () => {
    expect(detectCgnat('100.64.3.2', '203.0.113.42')).toBe(true);
    expect(detectCgnat('192.168.0.2', null)).toBe(true);
    expect(detectCgnat('203.0.113.42', '203.0.113.42')).toBe(false);
    expect(detectCgnat('203.0.113.42', '198.51.100.1')).toBe(true);
    expect(detectCgnat(null, '203.0.113.42')).toBeNull();
  });
});

describe('UPnP', () => {
  const description = `<?xml version="1.0"?><root><device><deviceList><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/CmnIfCfg</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
  </serviceList></device></deviceList></device></root>`;

  it('finds the WAN connection service', () => {
    expect(parseDescription(description, 'http://192.168.1.1:5000/rootDesc.xml')).toEqual({
      controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    });
    expect(parseDescription('<root><URLBase>http://10.0.0.1:49152/</URLBase><service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>ppp</controlURL></service></root>', 'http://x/')).toMatchObject({
      controlUrl: 'http://10.0.0.1:49152/ppp',
    });
    expect(parseDescription('<root/>', 'http://x/')).toBeNull();
  });

  it('escapes SOAP arguments', () => {
    expect(soapBody('urn:x', 'AddPortMapping', { NewPortMappingDescription: 'srvMC <A&B>' })).toContain('<NewPortMappingDescription>srvMC &lt;A&amp;B&gt;</NewPortMappingDescription>');
  });

  it('talks to a router: lease fallback, external address, idempotent delete', async () => {
    const calls: { action: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const action = String(req.headers.soapaction).replace(/^"[^#]*#|"$/g, '');
        calls.push({ action, body });
        const fault = (code: number) => {
          res.writeHead(500, { 'content-type': 'text/xml' });
          res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>Nope</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
        };
        if (action === 'AddPortMapping' && body.includes('<NewLeaseDuration>0<')) return fault(725);
        if (action === 'DeletePortMapping') return fault(714);
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(action === 'GetExternalIPAddress' ? '<r><NewExternalIPAddress>203.0.113.42</NewExternalIPAddress></r>' : '<ok/>');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const gw: Gateway = { controlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ctl`, serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', localIp: '192.168.1.20' };
    try {
      await addMapping(gw, { port: 25565, protocol: 'TCP', description: 'srvMC' });
      expect(calls.map((c) => c.action)).toEqual(['AddPortMapping', 'AddPortMapping']);
      expect(calls[1]!.body).toContain('<NewLeaseDuration>7200</NewLeaseDuration>');
      expect(calls[1]!.body).toContain('<NewInternalClient>192.168.1.20</NewInternalClient>');
      expect(await externalIp(gw)).toBe('203.0.113.42');
      await expect(deleteMapping(gw, { port: 25565, protocol: 'TCP' })).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe('DuckDNS input', () => {
  it('accepts the name with or without the suffix', () => {
    expect(normalizeDuckDomain(' Muj-Server.duckdns.org ')).toBe('muj-server');
    expect(() => normalizeDuckDomain('bad_name')).toThrow();
    expect(() => normalizeDuckDomain('-x')).toThrow();
    expect(checkDuckToken(' 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ')).toBe('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    expect(() => checkDuckToken('123')).toThrow(/looks like/);
  });
});

describe('secrets', () => {
  const box: SecretBox = { encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s, 'base64').toString() };

  it('seals with the box and reads back, falls back to plain without it', () => {
    const sealed = seal(box, 'tajne');
    expect(sealed.startsWith('enc:')).toBe(true);
    expect(sealed).not.toContain('tajne');
    expect(unseal(box, sealed)).toBe('tajne');
    expect(unseal(undefined, sealed)).toBeNull();
    expect(unseal(undefined, seal(undefined, 'x'))).toBe('x');
    expect(unseal(box, undefined)).toBeNull();
  });
});

describe('playit.gg', () => {
  it('builds claim links and tunnel requests', () => {
    expect(claimUrl('0a1b2c3d4e')).toBe('https://playit.gg/claim/0a1b2c3d4e');
    expect(tunnelRequest('agent-1', 'srvMC Test', 25601)).toMatchObject({
      ports: { type: 'tunnel-type', details: 'minecraft-java' },
      origin: { type: 'agent', data: { agent_id: 'agent-1', config: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: '25601' }] } } },
      enabled: true,
    });
  });

  it('reads tunnels of the agent', () => {
    const tunnels = toTunnels({
      agent_id: 'a',
      tunnels: [{ id: 't1', name: 'srvMC Test', display_address: 'brave-fox.gl.joinmc.link', tunnel_type: 'minecraft-java', agent_config: { fields: [{ name: 'local_port', value: '25601' }] }, disabled_reason: null }],
      pending: [{ id: 't2', name: 'new', status_msg: 'allocating' }],
    });
    expect(tunnels).toEqual([
      { id: 't1', name: 'srvMC Test', address: 'brave-fox.gl.joinmc.link', localPort: 25601, pending: false },
      { id: 't2', name: 'new', address: '', localPort: null, pending: true, disabled: 'allocating' },
    ]);
  });

  it('unwraps API answers and errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', data: 'WaitingForUser' })));
    expect(await playitCall('/claim/setup', {})).toBe('WaitingForUser');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', data: { type: 'auth', message: 'InvalidAgentKey' } }), { status: 401 }));
    const err = await playitCall('/v1/agents/rundata', {}, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayitApiError);
    expect(err).toMatchObject({ code: 'InvalidAgentKey', status: 401 });
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ authorization: 'Agent-Key k' });
  });
});

describe('own domain', () => {
  const d = (target: DomainConfig['target'], sub = 'survival'): DomainConfig => ({ zone: 'mojedomena.cz', sub, target });

  it('cleans what the user types', () => {
    expect(normalizeDomain({ zone: ' MojeDomena.CZ. ', sub: 'Survival', target: 'ip' })).toEqual({ zone: 'mojedomena.cz', sub: 'survival', target: 'ip' });
    expect(() => normalizeDomain({ zone: 'localhost', sub: '', target: 'ip' })).toThrow();
    expect(() => normalizeDomain({ zone: 'a.cz', sub: 'bad name', target: 'ip' })).toThrow();
    expect(fullHost(d('ip', ''))).toBe('mojedomena.cz');
  });

  it('lists the records per target', () => {
    const ctx = { port: 25601, publicIp: '203.0.113.42', duckdns: 'muj-server', playit: { host: 'x.gl.joinmc.link', port: 12345 } };
    expect(recordsFor(d('ip'), ctx)).toEqual([
      { type: 'A', name: 'survival', value: '203.0.113.42' },
      { type: 'SRV', name: '_minecraft._tcp.survival', value: '0 5 25601 survival.mojedomena.cz' },
    ]);
    expect(recordsFor(d('ip'), { ...ctx, port: 25565 })).toHaveLength(1);
    expect(recordsFor(d('duckdns'), ctx)[0]).toEqual({ type: 'CNAME', name: 'survival', value: 'muj-server.duckdns.org' });
    expect(recordsFor(d('duckdns', ''), ctx)[0]).toEqual({ type: 'A', name: '@', value: '203.0.113.42' });
    expect(recordsFor(d('playit'), ctx)).toEqual([
      { type: 'CNAME', name: 'survival', value: 'x.gl.joinmc.link' },
      { type: 'SRV', name: '_minecraft._tcp.survival', value: '0 5 12345 x.gl.joinmc.link' },
    ]);
    expect(recordsFor(d('playit'), { ...ctx, playit: null })).toEqual([]);
  });

  it('checks live DNS answers against the records', async () => {
    const lookup: Lookup = {
      resolve4: async (h) => (h === 'survival.mojedomena.cz' ? ['203.0.113.42'] : []),
      resolveCname: async () => [],
      resolveSrv: async (h) => {
        if (h !== '_minecraft._tcp.survival.mojedomena.cz') throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
        return [{ name: 'survival.mojedomena.cz.', port: 25601, priority: 0, weight: 5 }];
      },
    };
    const records = recordsFor(d('ip'), { port: 25601, publicIp: '203.0.113.42' });
    const good = await checkDomain(d('ip'), records, lookup);
    expect(good.ok).toBe(true);
    expect(good.message).toMatch(/points to your server/);
    const wrongIp = await checkDomain(d('ip'), recordsFor(d('ip'), { port: 25601, publicIp: '198.51.100.9' }), lookup);
    expect(wrongIp.ok).toBe(false);
    expect(wrongIp.records[0]).toMatchObject({ ok: false, found: '203.0.113.42' });
    expect(wrongIp.message).toMatch(/Not matching yet: A survival/);
  });
});
