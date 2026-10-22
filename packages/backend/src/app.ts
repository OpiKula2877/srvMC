import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { CSRF_HEADER, SERVER_TYPES, type CreateServerRequest, type PanelUser, type ServerType, type SystemInfo, type UpdateServerRequest, type WsEvent } from '@srvmc/shared';
import { allowed, canSee, LOCAL_OWNER, need } from './access.ts';
import { AddonService } from './addons.ts';
import { DiscordService } from './discord.ts';
import { PlayerStatsService } from './playerstats.ts';
import { ProxyService } from './proxy.ts';
import { registerExtraRoutes } from './routes/extras.ts';
import { lanAddresses, readCookie, registerUserRoutes, SESSION_COOKIE } from './routes/users.ts';
import { UserStore } from './users.ts';
import { installedRuntimes } from './java.ts';
import { ServerManager } from './manager.ts';
import { ensureDirs, makePaths, type Paths } from './paths.ts';
import { providerFor, UserError } from './providers/index.ts';
import { BackupService } from './backups.ts';
import { MetricHistory } from './history.ts';
import { NetworkService } from './network.ts';
import { registerContentRoutes } from './routes/content.ts';
import { registerModRoutes } from './routes/mods.ts';
import { registerMonitorRoutes } from './routes/monitor.ts';
import { registerNetworkRoutes } from './routes/network.ts';
import { registerWorldRoutes } from './routes/worlds.ts';
import { Scheduler } from './scheduler.ts';
import type { SecretBox } from './secrets.ts';
import { ServerStore } from './store.ts';
import { Supervisor } from './supervisor.ts';

export const VERSION = '0.9.0';

declare module 'fastify' {
  interface FastifyRequest {
    principal: PanelUser | null;
  }
}

const isLoopback = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export interface BackendOptions {
  /** Port to listen on. 0 picks a free one. Default 8420. */
  port?: number;
  paths?: Paths;
  /** Folder with the built web panel. When set, the backend serves it. */
  webDir?: string;
  /** Extra origins allowed to call the API, e.g. the Vite dev server. */
  devOrigins?: string[];
  autoStartServers?: boolean;
  logger?: boolean;
  /** Seals stored tokens and keys (the desktop app passes Electron safeStorage). */
  secretBox?: SecretBox;
  /** The desktop window sends this in x-srvmc-local and acts as the owner without signing in. */
  localToken?: string;
}

export interface Backend {
  port: number;
  url: string;
  manager: ServerManager;
  close(): Promise<void>;
}

const SERVER_TYPE_IDS = SERVER_TYPES.map((t) => t.id);

const createSchema = {
  body: {
    type: 'object',
    required: ['name', 'type', 'version', 'port', 'ramMaxMb', 'eulaAccepted'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 64 },
      type: { type: 'string', enum: SERVER_TYPE_IDS },
      version: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._+-]+$' },
      build: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9._+-]*$' },
      port: { type: 'integer' },
      ramMaxMb: { type: 'integer' },
      eulaAccepted: { type: 'boolean' },
      startAfterInstall: { type: 'boolean', default: false },
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 64 },
      port: { type: 'integer' },
      ramMinMb: { type: 'integer' },
      ramMaxMb: { type: 'integer' },
      jvmFlags: { type: 'string', enum: ['aikar', 'default'] },
      extraJvmArgs: { type: 'string', maxLength: 2000 },
      timezone: { type: 'string', maxLength: 64 },
      autoStart: { type: 'boolean' },
      backupSchedule: { type: 'string', enum: ['off', 'hourly', '6h', 'daily', 'weekly'] },
      backupTime: { type: 'string', maxLength: 5 },
      backupKeep: { type: 'integer', minimum: 1, maximum: 100 },
      crashRestart: { type: 'boolean' },
      wakeOnJoin: { type: 'boolean' },
      sleepAfterMin: { type: 'integer', minimum: 0, maximum: 1440 },
      diskLimitMb: { type: 'integer', minimum: 0, maximum: 10485760 },
    },
  },
} as const;

function provider(type: string) {
  const p = providerFor(type as ServerType);
  if (!p) throw new UserError('Tento typ serveru zatím není podporovaný.');
  return p;
}

async function systemInfo(paths: Paths): Promise<SystemInfo> {
  let diskFreeMb: number | null = null;
  try {
    const s = await statfs(paths.root);
    diskFreeMb = Math.floor((s.bavail * s.bsize) / 1024 / 1024);
  } catch {
    diskFreeMb = null;
  }
  return {
    platform: process.platform,
    cpus: os.cpus().length,
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.floor(os.freemem() / 1024 / 1024),
    diskFreeMb,
    dataDir: paths.root,
    javaRuntimes: await installedRuntimes(paths),
    version: VERSION,
  };
}

function registerRoutes(app: FastifyInstance, manager: ServerManager, paths: Paths): void {
  // Moderators and starters only get the servers listed on their account.
  const visible = (req: FastifyRequest) => manager.list().filter((s) => req.principal && canSee(req.principal, s.id));
  app.get('/api/system', () => systemInfo(paths));
  app.get('/api/types', () => SERVER_TYPES);
  app.get<{ Params: { type: string }; Querystring: { snapshots?: string } }>('/api/types/:type/versions', (req) =>
    provider(req.params.type).listVersions(req.query.snapshots === 'true'),
  );
  app.get<{ Params: { type: string }; Querystring: { version?: string } }>('/api/types/:type/builds', (req) => {
    if (!req.query.version) throw new UserError('Chybí verze.');
    return provider(req.params.type).listBuilds(req.query.version);
  });
  app.get<{ Querystring: { type?: string } }>('/api/ports/suggest', async (req) => ({
    port: await manager.suggestPort(SERVER_TYPE_IDS.includes(req.query.type as ServerType) ? (req.query.type as ServerType) : 'vanilla'),
  }));

  app.get('/api/servers', (req) => visible(req));
  app.post<{ Body: CreateServerRequest }>('/api/servers', { schema: createSchema }, async (req, reply) => {
    reply.code(201);
    return manager.create(req.body);
  });
  app.get<{ Params: { id: string } }>('/api/servers/:id', (req) => manager.info(manager.get(req.params.id)));
  app.patch<{ Params: { id: string }; Body: UpdateServerRequest }>('/api/servers/:id', { schema: updateSchema }, (req) =>
    manager.update(req.params.id, req.body),
  );
  app.delete<{ Params: { id: string } }>('/api/servers/:id', async (req, reply) => {
    await manager.delete(req.params.id);
    reply.code(204);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/servers/:id/:action', async (req) => {
    const { id, action } = req.params;
    if (action === 'start') return manager.start(id);
    if (action === 'stop') return manager.stop(id);
    if (action === 'restart') return manager.restart(id);
    if (action === 'kill') return manager.kill(id);
    throw new UserError('Neznámá akce.');
  });
  app.post<{ Params: { id: string }; Body: { command: string } }>(
    '/api/servers/:id/command',
    { schema: { body: { type: 'object', required: ['command'], properties: { command: { type: 'string', minLength: 1, maxLength: 1000 } } } } },
    async (req, reply) => {
      manager.command(req.params.id, req.body.command);
      reply.code(204);
    },
  );
  app.get<{ Params: { id: string } }>('/api/servers/:id/log', (req) => manager.get(req.params.id).log);
  app.get<{ Params: { id: string } }>('/api/servers/:id/metrics', (req) => manager.get(req.params.id).metrics);
}

export async function startBackend(opts: BackendOptions = {}): Promise<Backend> {
  const paths = opts.paths ?? makePaths();
  await ensureDirs(paths);
  const manager = new ServerManager(paths, new ServerStore(paths.serversFile));
  await manager.init();
  const users = new UserStore(path.join(paths.root, 'users.json'));
  await users.load();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  let port = opts.port ?? 8420;
  const devOrigins = opts.devOrigins ?? [];
  // With access from the home network on, the panel also answers on this computer's LAN addresses.
  const lan = users.lan;
  const allowedOrigins = () =>
    new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devOrigins, ...(lan ? lanAddresses().map((a) => `http://${a}:${port}`) : [])]);
  const allowedHosts = () => new Set([...allowedOrigins()].map((o) => new URL(o).host));

  /** Who is asking: the desktop window, the only user (no accounts, this computer), or a signed-in account. */
  const principalOf = (req: FastifyRequest): PanelUser | null => {
    if (opts.localToken && req.headers['x-srvmc-local'] === opts.localToken) return LOCAL_OWNER;
    if (!users.hasUsers) return isLoopback(req.socket.remoteAddress) ? LOCAL_OWNER : null;
    return users.session(readCookie(req, SESSION_COOKIE));
  };
  app.decorateRequest('principal', null);

  // The API listens on loopback only, but any web page the user opens could still try to reach it.
  // Rejecting foreign Host headers blocks DNS rebinding; the custom header blocks cross-site form posts.
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts().has(req.headers.host ?? '')) return reply.code(403).send({ error: 'Nepovolený host.' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) return reply.code(403).send({ error: 'Nepovolený původ požadavku.' });
    if (req.url.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
      return reply.code(403).send({ error: 'Chybí ochranná hlavička.' });
    }
    req.principal = principalOf(req);
    const n = need(req.method, req.url);
    if (!n) return;
    if (!req.principal) return reply.code(401).send({ error: 'Přihlas se.' });
    if (!allowed(req.principal, n)) return reply.code(403).send({ error: 'Na tohle nemáš oprávnění.' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const status = err.validation ? 400 : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.validation ? `Neplatná data: ${err.message}` : err.message });
  });

  const clients = new Map<WebSocket, PanelUser>();
  const broadcast = (event: WsEvent) => {
    const data = JSON.stringify(event);
    const serverId = event.type === 'server' ? event.server.id : event.id;
    for (const [ws, user] of clients) {
      if (ws.readyState !== ws.OPEN || !canSee(user, serverId)) continue;
      // The console stream is for moderators and up.
      if (event.type === 'log' && !allowed(user, { cap: 'console' })) continue;
      ws.send(data);
    }
  };
  manager.on('server', (server) => broadcast({ type: 'server', server }));
  manager.on('deleted', (id: string) => broadcast({ type: 'deleted', id }));
  manager.on('log', (id: string, lines) => broadcast({ type: 'log', id, lines }));
  manager.on('metrics', (id: string, point) => broadcast({ type: 'metrics', id, point }));

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    if (!req.principal) return socket.close();
    clients.set(socket, req.principal);
    socket.on('close', () => clients.delete(socket));
  });

  // Uploads stream straight to disk; the server icon is small enough to buffer.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser('image/png', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

  const backups = new BackupService(manager, paths);
  const history = new MetricHistory(paths.metrics);
  const supervisor = new Supervisor(manager, history);
  const scheduler = new Scheduler(manager, backups);
  const network = new NetworkService(manager, paths, VERSION, opts.secretBox);
  const discord = new DiscordService(manager, opts.secretBox);
  const stats = new PlayerStatsService(manager);
  const addons = new AddonService(manager, paths);
  const proxy = new ProxyService(manager, paths);
  manager.on('deleted', (id: string) => {
    void users.forgetServer(id);
    void proxy.forget(id);
  });
  registerRoutes(app, manager, paths);
  registerContentRoutes(app, manager, paths);
  registerModRoutes(app, manager, paths);
  registerWorldRoutes(app, manager, backups, paths);
  registerMonitorRoutes(app, manager, history, scheduler);
  registerNetworkRoutes(app, network);
  registerExtraRoutes(app, { discord, stats, addons, proxy });
  registerUserRoutes(app, users, () => port, (req) => req.principal);

  if (opts.webDir) {
    await app.register(fastifyStatic, {
      root: path.resolve(opts.webDir),
      // Look files up per request, so a rebuilt panel is served without restarting the core.
      wildcard: true,
      // index.html names the hashed bundles, so it must never be served stale after an update;
      // the bundles themselves never change under the same name.
      cacheControl: false,
      setHeaders: (res, file) => {
        res.setHeader('cache-control', file.endsWith('.html') ? 'no-store' : /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Nenalezeno.' });
      return reply.header('cache-control', 'no-store').sendFile('index.html');
    });
  }

  await app.listen({ port, host: lan ? '0.0.0.0' : '127.0.0.1' });
  const address = app.server.address();
  if (address && typeof address === 'object') port = address.port;

  if (opts.autoStartServers) void manager.autoStart();
  backups.start();
  supervisor.start();
  scheduler.start();
  await network.start();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    manager,
    async close() {
      backups.stop();
      scheduler.stop();
      await network.stop();
      await supervisor.stop();
      await manager.stopAll();
      for (const ws of clients.keys()) ws.close();
      await app.close();
    },
  };
}
