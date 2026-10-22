// Routes for what lives inside a server folder: players, server.properties, icon, logs, files.
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  MANAGED_PROPERTY_KEYS,
  MAX_UPLOAD,
  PROPERTY_KEY_RE,
  editionOf,
  propertyDef,
  type Edition,
  type AddPlayerRequest,
  type LogFileInfo,
  type PlayerListKind,
} from '@srvmc/shared';
import {
  checkServerIcon,
  listDir,
  listLogs,
  logPath,
  makeDir,
  openForDownload,
  readLog,
  readText,
  renamePath,
  saveUpload,
  trashPaths,
  unzipHere,
  writeText,
} from '../files.ts';
import type { ServerInstance } from '../instance.ts';
import type { ServerManager } from '../manager.ts';
import type { Paths } from '../paths.ts';
import { addPlayer, kickPlayer, playersInfo, removePlayer, setWhitelistEnabled } from '../players.ts';
import { checkDiskRoom } from '../disk.ts';
import { readServerProperties, updateServerProperties } from '../properties.ts';
import { UserError } from '../providers/index.ts';
import { t } from '@srvmc/shared';

const LISTS = new Set<PlayerListKind>(['whitelist', 'ops', 'bans', 'ips']);

function listKind(value: string): PlayerListKind {
  if (!LISTS.has(value as PlayerListKind)) throw new UserError(t('Unknown list.'));
  return value as PlayerListKind;
}

function attachment(reply: FastifyReply, name: string, size?: number): void {
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('content-type', 'application/octet-stream');
  if (size !== undefined) reply.header('content-length', size);
}

function notWhileRunning(inst: ServerInstance, what: string): void {
  if (inst.running) throw new UserError(t('Stop the server first – {what} while it runs could damage the world.', { what }));
}

/** Validates edited server.properties values against what the panel knows about each key. */
export function checkPropertyValues(values: Record<string, unknown>, edition: Edition = 'java'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!PROPERTY_KEY_RE.test(key)) throw new UserError(t('Invalid key: {key}', { key }));
    if (MANAGED_PROPERTY_KEYS.has(key)) throw new UserError(t('{key} is changed in the Settings tab.', { key }));
    if (typeof raw !== 'string' || raw.length > 1000) throw new UserError(t('Invalid value for {key}.', { key }));
    const def = propertyDef(key, edition);
    if (def?.type === 'bool' && raw !== 'true' && raw !== 'false') throw new UserError(t('{label}: on or off.', { label: t(def.label) }));
    if (def?.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new UserError(t('{label}: a whole number {min}–{max}.', { label: t(def.label), min: def.min ?? '', max: def.max ?? '' }));
      }
    }
    if (def?.type === 'enum' && !def.options?.some((o) => o.value === raw)) throw new UserError(t('{label}: invalid choice.', { label: t(def.label) }));
    out[key] = raw;
  }
  return out;
}

export function registerContentRoutes(app: FastifyInstance, manager: ServerManager, paths: Paths): void {
  const inst = (id: string) => manager.get(id);

  // Players
  app.get<{ Params: { id: string } }>('/api/servers/:id/players', (req) => playersInfo(inst(req.params.id)));
  app.post<{ Params: { id: string; list: string }; Body: AddPlayerRequest }>(
    '/api/servers/:id/players/:list',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 64 }, reason: { type: 'string', maxLength: 200 }, level: { type: 'integer', minimum: 1, maximum: 4 } },
        },
      },
    },
    async (req) => {
      const i = inst(req.params.id);
      await addPlayer(i, listKind(req.params.list), req.body);
      return playersInfo(i);
    },
  );
  app.delete<{ Params: { id: string; list: string; name: string } }>('/api/servers/:id/players/:list/:name', async (req) => {
    const i = inst(req.params.id);
    await removePlayer(i, listKind(req.params.list), req.params.name);
    return playersInfo(i);
  });
  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/servers/:id/players/whitelist-enabled',
    { schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
    async (req) => {
      const i = inst(req.params.id);
      await setWhitelistEnabled(i, req.body.enabled);
      return playersInfo(i);
    },
  );
  app.post<{ Params: { id: string }; Body: { name: string; reason?: string } }>(
    '/api/servers/:id/kick',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 24 }, reason: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => {
      kickPlayer(inst(req.params.id), req.body.name, req.body.reason);
      reply.code(204);
    },
  );

  // server.properties
  app.get<{ Params: { id: string } }>('/api/servers/:id/properties', async (req) => {
    const { values, exists } = await readServerProperties(inst(req.params.id).dir);
    return { values: Object.fromEntries(values), exists };
  });
  app.put<{ Params: { id: string }; Body: { values: Record<string, unknown> } }>(
    '/api/servers/:id/properties',
    { schema: { body: { type: 'object', required: ['values'], properties: { values: { type: 'object', maxProperties: 200 } } } } },
    async (req) => {
      const i = inst(req.params.id);
      if (!i.cfg.installed) throw new UserError(t('The server is not installed yet.'));
      await updateServerProperties(i.dir, checkPropertyValues(req.body.values, editionOf(i.cfg.type)));
      const { values, exists } = await readServerProperties(i.dir);
      return { values: Object.fromEntries(values), exists };
    },
  );

  // Server icon
  app.get<{ Params: { id: string } }>('/api/servers/:id/icon', async (req, reply) => {
    const file = path.join(inst(req.params.id).dir, 'server-icon.png');
    const buf = await readFile(file).catch(() => null);
    if (!buf) return reply.code(404).send({ error: t('The server has no icon.') });
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return buf;
  });
  app.put<{ Params: { id: string }; Body: Buffer }>('/api/servers/:id/icon', async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new UserError(t('Send a PNG image.'));
    checkServerIcon(req.body);
    await writeFile(path.join(inst(req.params.id).dir, 'server-icon.png'), req.body);
    reply.code(204);
  });
  app.delete<{ Params: { id: string } }>('/api/servers/:id/icon', async (req, reply) => {
    await rm(path.join(inst(req.params.id).dir, 'server-icon.png'), { force: true });
    reply.code(204);
  });

  // Logs
  app.get<{ Params: { id: string } }>('/api/servers/:id/logs', (req) => listLogs(inst(req.params.id).dir));
  app.get<{ Params: { id: string; kind: LogFileInfo['kind']; name: string } }>('/api/servers/:id/logs/:kind/:name', (req) =>
    readLog(inst(req.params.id).dir, req.params.kind, req.params.name),
  );
  app.get<{ Params: { id: string; kind: LogFileInfo['kind']; name: string } }>('/api/servers/:id/logs/:kind/:name/download', async (req, reply) => {
    const file = logPath(inst(req.params.id).dir, req.params.kind, req.params.name);
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) throw new UserError('Log neexistuje.');
    const { stream } = await openForDownload(path.dirname(file), req.params.name);
    attachment(reply, req.params.name, s.size);
    return reply.send(stream);
  });

  // Files
  const pathQuery = { type: 'object', properties: { path: { type: 'string', maxLength: 1024 } } } as const;
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files', { schema: { querystring: pathQuery } }, (req) =>
    listDir(inst(req.params.id).dir, req.query.path ?? ''),
  );
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files/content', { schema: { querystring: pathQuery } }, (req) =>
    readText(inst(req.params.id).dir, req.query.path ?? ''),
  );
  app.put<{ Params: { id: string }; Body: { path: string; content: string } }>(
    '/api/servers/:id/files/content',
    {
      bodyLimit: 3 * 1024 * 1024,
      schema: { body: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string' } } } },
    },
    (req) => writeText(inst(req.params.id).dir, req.body.path, req.body.content),
  );
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/servers/:id/files/download', { schema: { querystring: pathQuery } }, async (req, reply) => {
    const { stream, name, size } = await openForDownload(inst(req.params.id).dir, req.query.path ?? '');
    attachment(reply, name, size);
    return reply.send(stream);
  });
  app.post<{ Params: { id: string }; Querystring: { path?: string; name: string; overwrite?: string }; Body: Readable }>(
    '/api/servers/:id/files/upload',
    {
      schema: {
        querystring: { type: 'object', required: ['name'], properties: { path: { type: 'string', maxLength: 1024 }, name: { type: 'string', maxLength: 255 }, overwrite: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_UPLOAD) throw new UserError(t('The file is too big (max 1 GB).'));
      const i = inst(req.params.id);
      checkDiskRoom(i.cfg, i.diskUsageMb, declared);
      await saveUpload(i.dir, req.query.path ?? '', req.query.name, req.body, MAX_UPLOAD, req.query.overwrite === '1');
      manager.emit('files-changed', i.cfg.id);
      reply.code(204);
    },
  );
  const oneName = { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } } } as const;
  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/servers/:id/files/mkdir', { schema: { body: oneName } }, async (req, reply) => {
    await makeDir(inst(req.params.id).dir, req.body.path);
    reply.code(204);
  });
  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/api/servers/:id/files/rename',
    { schema: { body: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', maxLength: 1024 }, to: { type: 'string', maxLength: 1024 } } } } },
    async (req, reply) => {
      const i = inst(req.params.id);
      notWhileRunning(i, t('renaming'));
      await renamePath(i.dir, req.body.from, req.body.to);
      reply.code(204);
    },
  );
  app.post<{ Params: { id: string }; Body: { paths: string[] } }>(
    '/api/servers/:id/files/delete',
    { schema: { body: { type: 'object', required: ['paths'], properties: { paths: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 1024 } } } } } },
    async (req) => {
      const i = inst(req.params.id);
      notWhileRunning(i, t('deleting'));
      const trash = await trashPaths(i.dir, req.body.paths, path.join(paths.trash, i.cfg.id));
      return { trash };
    },
  );
  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/servers/:id/files/unzip', { schema: { body: oneName } }, async (req) => ({
    path: await unzipHere(inst(req.params.id).dir, req.body.path),
  }));
}
