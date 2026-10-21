// Routes for the network page: addresses, UPnP, port checks, DuckDNS, playit.gg and own domains.
import type { FastifyInstance } from 'fastify';
import type { DomainConfig } from '@srvmc/shared';
import type { NetworkService } from '../network.ts';

const domainBody = {
  type: 'object',
  required: ['zone', 'sub', 'target'],
  additionalProperties: false,
  properties: {
    zone: { type: 'string', minLength: 3, maxLength: 253 },
    sub: { type: 'string', maxLength: 200 },
    target: { type: 'string', enum: ['ip', 'duckdns', 'playit'] },
  },
} as const;

export function registerNetworkRoutes(app: FastifyInstance, network: NetworkService): void {
  app.get('/api/network', () => network.overview());
  app.post('/api/network/refresh', () => network.overview(true));

  app.put<{ Body: { domain: string; token: string } }>(
    '/api/network/duckdns',
    {
      schema: {
        body: { type: 'object', required: ['domain', 'token'], additionalProperties: false, properties: { domain: { type: 'string', maxLength: 100 }, token: { type: 'string', maxLength: 64 } } },
      },
    },
    (req) => network.setDuckDns(req.body.domain, req.body.token),
  );
  app.delete('/api/network/duckdns', () => network.removeDuckDns());

  app.post('/api/network/playit', () => network.connectPlayit());
  app.delete('/api/network/playit', () => network.disconnectPlayit());

  app.get<{ Params: { id: string } }>('/api/servers/:id/network', (req) => network.serverNetwork(req.params.id));
  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/servers/:id/network/upnp',
    { schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } } },
    (req) => network.setUpnp(req.params.id, req.body.enabled),
  );
  app.post<{ Params: { id: string } }>('/api/servers/:id/network/check', (req) => network.checkPort(req.params.id));
  app.post<{ Params: { id: string } }>('/api/servers/:id/network/playit', (req) => network.createPlayitTunnel(req.params.id));
  app.put<{ Params: { id: string }; Body: DomainConfig }>('/api/servers/:id/network/domain', { schema: { body: domainBody } }, (req) => network.setDomain(req.params.id, req.body));
  app.delete<{ Params: { id: string } }>('/api/servers/:id/network/domain', (req) => network.setDomain(req.params.id, null));
  app.post<{ Params: { id: string } }>('/api/servers/:id/network/domain/check', (req) => network.checkDomain(req.params.id));
}
