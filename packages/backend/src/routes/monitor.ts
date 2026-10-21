// Routes for the load history and the task scheduler.
import type { FastifyInstance } from 'fastify';
import type { HistoryRange } from '@srvmc/shared';
import type { MetricHistory } from '../history.ts';
import type { ServerManager } from '../manager.ts';
import type { Scheduler } from '../scheduler.ts';

export function registerMonitorRoutes(app: FastifyInstance, manager: ServerManager, history: MetricHistory, scheduler: Scheduler): void {
  app.get<{ Params: { id: string }; Querystring: { range?: HistoryRange } }>(
    '/api/servers/:id/history',
    { schema: { querystring: { type: 'object', properties: { range: { type: 'string', enum: ['1h', '24h', '7d', '30d'] } } } } },
    (req) => {
      manager.get(req.params.id);
      return history.query(req.params.id, req.query.range ?? '24h');
    },
  );

  app.get<{ Params: { id: string } }>('/api/servers/:id/schedule', (req) => scheduler.state(req.params.id));
  app.put<{ Params: { id: string }; Body: { tasks: unknown[] } }>(
    '/api/servers/:id/schedule',
    { schema: { body: { type: 'object', required: ['tasks'], additionalProperties: false, properties: { tasks: { type: 'array', maxItems: 30, items: { type: 'object' } } } } } },
    (req) => scheduler.save(req.params.id, req.body.tasks),
  );
  app.post<{ Params: { id: string; task: string } }>('/api/servers/:id/schedule/:task/run', async (req) => ({
    result: await scheduler.run(req.params.id, req.params.task),
  }));
}
