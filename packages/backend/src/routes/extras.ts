// Routes for Discord notifications, player statistics, one-click add-ons and the Velocity network.
import type { FastifyInstance } from 'fastify';
import { DISCORD_EVENTS, type AddonId } from '@srvmc/shared';
import type { AddonService } from '../addons.ts';
import type { DiscordService } from '../discord.ts';
import type { PlayerStatsService } from '../playerstats.ts';
import type { ProxyService } from '../proxy.ts';
import { UserError } from '../providers/types.ts';

const ADDONS = new Set<AddonId>(['geyser', 'bluemap']);

function addonId(v: string): AddonId {
  if (!ADDONS.has(v as AddonId)) throw new UserError('Neznámý doplněk.');
  return v as AddonId;
}

export function registerExtraRoutes(app: FastifyInstance, s: { discord: DiscordService; stats: PlayerStatsService; addons: AddonService; proxy: ProxyService }): void {
  app.put<{ Params: { id: string }; Body: { webhook?: string; events: string[] } }>(
    '/api/servers/:id/discord',
    {
      schema: {
        body: {
          type: 'object',
          required: ['events'],
          additionalProperties: false,
          properties: { webhook: { type: 'string', maxLength: 300 }, events: { type: 'array', maxItems: 10, items: { type: 'string', enum: [...DISCORD_EVENTS] } } },
        },
      },
    },
    async (req, reply) => {
      await s.discord.configure(req.params.id, req.body);
      reply.code(204);
    },
  );
  app.delete<{ Params: { id: string } }>('/api/servers/:id/discord', async (req, reply) => {
    await s.discord.remove(req.params.id);
    reply.code(204);
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/discord/test', async (req, reply) => {
    await s.discord.test(req.params.id);
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/stats', (req) => s.stats.list(req.params.id));

  app.get<{ Params: { id: string } }>('/api/servers/:id/addons', (req) => s.addons.list(req.params.id));
  app.post<{ Params: { id: string; addon: string } }>('/api/servers/:id/addons/:addon', (req) => s.addons.install(req.params.id, addonId(req.params.addon)));
  app.delete<{ Params: { id: string; addon: string } }>('/api/servers/:id/addons/:addon', (req) => s.addons.remove(req.params.id, addonId(req.params.addon)));
  app.post<{ Params: { id: string } }>('/api/servers/:id/addons/bluemap/consent', (req) => s.addons.consent(req.params.id));

  app.get<{ Params: { id: string } }>('/api/servers/:id/proxy', (req) => s.proxy.state(req.params.id));
  app.put<{ Params: { id: string }; Body: { servers: { id: string; alias?: string }[] } }>(
    '/api/servers/:id/proxy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['servers'],
          additionalProperties: false,
          properties: {
            servers: {
              type: 'array',
              maxItems: 50,
              items: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', maxLength: 64 }, alias: { type: 'string', maxLength: 32 } } },
            },
          },
        },
      },
    },
    (req) => s.proxy.save(req.params.id, req.body.servers),
  );
}
