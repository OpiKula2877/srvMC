// Routes for mods, plugins, modpacks and the login mode (paid / paid + unpaid / anyone).
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AuthMode, ContentHit, ContentSource, ModpackSource } from '@srvmc/shared';
import { getAuthState, setAuthMode } from '../auth.ts';
import { checkUpdates, checkUploadedJar, contentTargets, installContent, listInstalled, modrinthLoaders, removeContent, setEnabled, targetFor, updateContent, type ContentContext } from '../content.ts';
import { checkDiskRoom } from '../disk.ts';
import { saveUpload, validName } from '../files.ts';
import { readJarMeta } from '../jarmeta.ts';
import type { ServerManager } from '../manager.ts';
import { searchModrinth } from '../modrinth.ts';
import type { Paths } from '../paths.ts';
import { curseForgeKeySet, saveCurseForgeKey, searchCurseForge } from '../curseforge.ts';
import type { ManualDownloads } from '../manual.ts';
import { packVersions, searchPacks } from '../providers/modpack.ts';
import { UserError } from '../providers/index.ts';
import { searchHangar, searchSpiget } from '../sources.ts';
import { t } from '@srvmc/shared';

const SOURCES = ['modrinth', 'hangar', 'spigot', 'curseforge'] as const;
const MAX_JAR = 200 * 1024 * 1024;

const offsetOf = (v?: string) => Math.max(0, Math.min(10_000, Number(v) || 0));

export function registerModRoutes(app: FastifyInstance, manager: ServerManager, paths: Paths, manual: ManualDownloads): void {
  const inst = (id: string) => manager.get(id);
  const ctxFor = (id: string): ContentContext => ({ paths, trashDir: path.join(paths.trash, id), manual });
  const afterChange = async (id: string) => {
    await manager.refreshPregen(inst(id));
    manager.emit('files-changed', id);
  };

  app.get<{ Params: { id: string } }>('/api/servers/:id/content/targets', (req) => contentTargets(inst(req.params.id).cfg));

  app.get<{ Params: { id: string }; Querystring: { source: ContentSource; folder: string; q?: string; offset?: string; hideClient?: string } }>(
    '/api/servers/:id/content/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['source', 'folder'],
          properties: { source: { type: 'string', enum: SOURCES }, folder: { type: 'string', enum: ['plugins', 'mods'] }, q: { type: 'string', maxLength: 100 }, offset: { type: 'string' }, hideClient: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const i = inst(req.params.id);
      const target = targetFor(i.cfg, req.query.folder);
      const { source } = req.query;
      if (!target.sources.includes(source)) throw new UserError(t('This source does not fit this server.'));
      const query = req.query.q?.trim() ?? '';
      const offset = offsetOf(req.query.offset);
      let hits: ContentHit[];
      if (source === 'modrinth') {
        hits = await searchModrinth({ query, loaders: modrinthLoaders(i.cfg, target.kind), gameVersion: i.cfg.version, kind: target.kind, hideClientOnly: req.query.hideClient !== '0', offset });
      } else if (source === 'curseforge') {
        hits = await searchCurseForge(query, target.kind, modrinthLoaders(i.cfg, target.kind), i.cfg.version, offset);
      } else if (source === 'hangar') {
        hits = await searchHangar(query, i.cfg.version, offset);
      } else {
        hits = await searchSpiget(query, offset);
      }
      const installed = new Set((await listInstalled(i)).filter((x) => x.folder === target.folder && x.source === source && x.projectId).map((x) => x.projectId!.toLowerCase()));
      return hits.map((h) => ({ ...h, installed: installed.has(h.id.toLowerCase()) }));
    },
  );

  app.get<{ Params: { id: string } }>('/api/servers/:id/content', (req) => listInstalled(inst(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/servers/:id/content/updates', async (req) => {
    const i = inst(req.params.id);
    return checkUpdates(i, await listInstalled(i));
  });

  app.post<{ Params: { id: string }; Body: { source: ContentSource; id: string; folder: string } }>(
    '/api/servers/:id/content/install',
    {
      schema: {
        body: {
          type: 'object',
          required: ['source', 'id', 'folder'],
          additionalProperties: false,
          properties: { source: { type: 'string', enum: SOURCES }, id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._/-]+$' }, folder: { type: 'string', enum: ['plugins', 'mods'] } },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      checkDiskRoom(inst(id).cfg, inst(id).diskUsageMb);
      const result = await manager.runTask(id, 'content', t('Downloading'), () => installContent(inst(id), ctxFor(id), req.body.source, req.body.id, req.body.folder));
      await afterChange(id);
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { folder?: string; file?: string } }>(
    '/api/servers/:id/content/update',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { folder: { type: 'string', enum: ['plugins', 'mods'] }, file: { type: 'string', maxLength: 255 } } } } },
    async (req) => {
      const { id } = req.params;
      const only = req.body.folder && req.body.file ? { folder: req.body.folder, file: req.body.file } : undefined;
      const updated = await manager.runTask(id, 'content', t('Updating'), () => updateContent(inst(id), ctxFor(id), only));
      await afterChange(id);
      return { updated };
    },
  );

  app.put<{ Params: { id: string; folder: string; file: string }; Body: { enabled: boolean } }>(
    '/api/servers/:id/content/:folder/:file/enabled',
    { schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
    async (req, reply) => {
      await setEnabled(inst(req.params.id), req.params.folder, req.params.file, req.body.enabled);
      await afterChange(req.params.id);
      reply.code(204);
    },
  );

  app.delete<{ Params: { id: string; folder: string; file: string } }>('/api/servers/:id/content/:folder/:file', async (req, reply) => {
    await removeContent(inst(req.params.id), ctxFor(req.params.id), req.params.folder, req.params.file);
    await afterChange(req.params.id);
    reply.code(204);
  });

  // A jar from the user's disk: kept only when it fits the server (plugin vs. mod, loader, not client-only).
  app.post<{ Params: { id: string }; Querystring: { folder: string; name: string; overwrite?: string }; Body: Readable }>(
    '/api/servers/:id/content/upload',
    { schema: { querystring: { type: 'object', required: ['folder', 'name'], properties: { folder: { type: 'string', enum: ['plugins', 'mods'] }, name: { type: 'string', maxLength: 255 }, overwrite: { type: 'string' } } } } },
    async (req) => {
      const i = inst(req.params.id);
      const target = targetFor(i.cfg, req.query.folder);
      const { name } = req.query;
      if (!validName(name) || !/\.jar$/i.test(name)) throw new UserError(t('Only .jar files can be uploaded.'));
      if (Number(req.headers['content-length'] ?? 0) > MAX_JAR) throw new UserError(t('The jar is too big (max 200 MB).'));
      checkDiskRoom(i.cfg, i.diskUsageMb, Number(req.headers['content-length'] ?? 0));
      const final = path.join(i.dir, target.folder, name);
      if (req.query.overwrite !== '1' && (await stat(final).catch(() => null))) throw new UserError(t('The file {name} is already on the server.', { name }));
      if (i.running && (await stat(final).catch(() => null))) throw new UserError(t('Stop the server first – Windows keeps the jars locked while it runs.'));

      const tmpName = `srvmc-upload-${randomBytes(6).toString('hex')}.tmp`;
      await mkdir(path.join(i.dir, target.folder), { recursive: true });
      await saveUpload(i.dir, target.folder, tmpName, req.body, MAX_JAR, false);
      const tmp = path.join(i.dir, target.folder, tmpName);
      try {
        const meta = await readJarMeta(tmp).catch(() => {
          throw new UserError(t('The file is not a valid jar.'));
        });
        checkUploadedJar(i.cfg, target, meta);
        await rename(tmp, final);
        i.pushLog('system', `${t('Uploaded: {name}', { name })}${i.running ? ` – ${t('takes effect after a restart.')}` : ''}`);
        await afterChange(req.params.id);
        return { file: name, name: meta.name ?? name, version: meta.version };
      } finally {
        await rm(tmp, { force: true });
      }
    },
  );

  // Files waiting for the user to download them in the browser.
  app.get<{ Params: { id: string } }>('/api/servers/:id/manual', (req) => manual.list(inst(req.params.id).cfg.id));
  app.delete<{ Params: { id: string; item: string } }>('/api/servers/:id/manual/:item', (req, reply) => {
    manual.cancel(inst(req.params.id).cfg.id, req.params.item === 'all' ? undefined : req.params.item);
    reply.code(204);
  });

  // The CurseForge API key (the user's own, from console.curseforge.com).
  app.get('/api/curseforge', () => ({ keySet: curseForgeKeySet() }));
  app.put<{ Body: { key: string } }>(
    '/api/curseforge',
    { schema: { body: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (req) => {
      await saveCurseForgeKey(req.body.key);
      return { keySet: true };
    },
  );
  app.delete('/api/curseforge', async (_req, reply) => {
    await saveCurseForgeKey(null);
    reply.code(204);
  });

  // Modpacks for the new-server wizard.
  app.get<{ Querystring: { q?: string; offset?: string; source?: ModpackSource } }>(
    '/api/modpacks/search',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 100 }, offset: { type: 'string' }, source: { type: 'string', enum: ['modrinth', 'curseforge', 'technic'] } } } } },
    (req) => searchPacks(req.query.source ?? 'modrinth', req.query.q?.trim() ?? '', offsetOf(req.query.offset)),
  );
  app.get<{ Params: { project: string } }>('/api/modpacks/:project/versions', (req) => {
    if (!/^(?:cf:\d{1,12}|technic:[A-Za-z0-9._-]{1,80}|[A-Za-z0-9_-]{1,64})$/.test(req.params.project)) throw new UserError(t('Invalid modpack.'));
    return packVersions(req.params.project);
  });

  // Login mode
  app.get<{ Params: { id: string } }>('/api/servers/:id/auth', (req) => getAuthState(inst(req.params.id)));
  app.put<{ Params: { id: string }; Body: { mode: AuthMode } }>(
    '/api/servers/:id/auth',
    { schema: { body: { type: 'object', required: ['mode'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['online', 'hybrid', 'offline'] } } } } },
    async (req) => {
      const { id } = req.params;
      const state = await manager.runTask(id, 'content', t('Setting the login mode'), () => setAuthMode(inst(id), ctxFor(id), req.body.mode));
      await afterChange(id);
      return state;
    },
  );
}
