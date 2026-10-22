// Routes for worlds, backups and pre-generation.
import { createReadStream } from 'node:fs';
import { rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { editionOf, type PregenRequest } from '@srvmc/shared';
import type { BackupService } from '../backups.ts';
import { installChunky, pregenCommand, startPregen } from '../chunky.ts';
import { addDatapack, datapacksSupported, listDatapacks, removeDatapack, setDatapackEnabled } from '../datapacks.ts';
import { checkDiskRoom } from '../disk.ts';
import { saveUpload } from '../files.ts';
import type { ServerManager } from '../manager.ts';
import type { Paths } from '../paths.ts';
import { UserError } from '../providers/index.ts';
import type { ServerInstance } from '../instance.ts';
import { checkWorldName, findWorlds, importWorld, setActiveWorld, trashWorld, worldBase, worldFolders } from '../worlds.ts';

/** Folder with the world folders; Hytale keeps its universe elsewhere and is not handled here yet. */
function worldsOf(inst: ServerInstance): string {
  const edition = editionOf(inst.cfg.type);
  if (edition === 'hytale') throw new UserError(t('Manage Hytale worlds (the universe folder) in Files for now.'));
  return worldBase(inst.dir, edition);
}

const listWorlds = (inst: ServerInstance) => (editionOf(inst.cfg.type) === 'hytale' ? Promise.resolve([]) : findWorlds(inst.dir, worldsOf(inst)));
import { collectFiles, zipStream } from '../zip.ts';
import { t } from '@srvmc/shared';

const MAX_WORLD_UPLOAD = 20 * 1024 * 1024 * 1024;
const MAX_DATAPACK = 512 * 1024 * 1024;

function attachment(reply: FastifyReply, name: string, size?: number): void {
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('content-type', 'application/zip');
  if (size !== undefined) reply.header('content-length', size);
}

export function registerWorldRoutes(app: FastifyInstance, manager: ServerManager, backups: BackupService, paths: Paths): void {
  const stopped = (id: string, what: string) => {
    const inst = manager.get(id);
    if (inst.running) throw new UserError(t('Stop the server first – {what} does not work while it runs.', { what }));
    if (inst.task) throw new UserError(t('Wait for the task on the server to finish.'));
    return inst;
  };

  // Worlds
  app.get<{ Params: { id: string } }>('/api/servers/:id/worlds', (req) => listWorlds(manager.get(req.params.id)));

  app.post<{ Params: { id: string; name: string } }>('/api/servers/:id/worlds/:name/activate', async (req) => {
    const inst = stopped(req.params.id, t('switching the world'));
    worldsOf(inst);
    await setActiveWorld(inst.dir, req.params.name);
    return listWorlds(inst);
  });

  app.post<{ Params: { id: string }; Body: { name: string; seed?: string; type?: string } }>(
    '/api/servers/:id/worlds',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 64 }, seed: { type: 'string', maxLength: 64 }, type: { type: 'string', enum: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'] } },
        },
      },
    },
    async (req) => {
      const inst = stopped(req.params.id, t('creating a world'));
      checkWorldName(req.body.name);
      if ((await worldFolders(worldsOf(inst), req.body.name)).length) throw new UserError(t('A world with this name already exists.'));
      // Bedrock has no level-type key; its new worlds are always the default kind.
      const type: Record<string, string> = req.body.type && editionOf(inst.cfg.type) === 'java' ? { 'level-type': req.body.type } : {};
      await setActiveWorld(inst.dir, req.body.name, { 'level-seed': req.body.seed ?? '', ...type });
      return listWorlds(inst);
    },
  );

  app.post<{ Params: { id: string; name: string }; Body: { seed?: string } }>(
    '/api/servers/:id/worlds/:name/reset',
    { schema: { body: { type: 'object', properties: { seed: { type: 'string', maxLength: 64 } } } } },
    async (req) => {
      const inst = stopped(req.params.id, t('resetting the world'));
      checkWorldName(req.params.name);
      await trashWorld(inst.dir, req.params.name, path.join(paths.trash, inst.cfg.id), worldsOf(inst));
      if (req.body?.seed !== undefined) await setActiveWorld(inst.dir, req.params.name, { 'level-seed': req.body.seed });
      inst.pushLog('system', t('World {name} moved to the trash. A new one is generated on start.', { name: req.params.name }));
      return listWorlds(inst);
    },
  );

  app.delete<{ Params: { id: string; name: string } }>('/api/servers/:id/worlds/:name', async (req) => {
    const inst = stopped(req.params.id, t('deleting the world'));
    const worlds = await listWorlds(inst);
    if (worlds.find((w) => w.name === req.params.name)?.active) throw new UserError(t('The active world cannot be deleted. Switch to another one first.'));
    await trashWorld(inst.dir, req.params.name, path.join(paths.trash, inst.cfg.id), worldsOf(inst));
    return listWorlds(inst);
  });

  app.get<{ Params: { id: string; name: string } }>('/api/servers/:id/worlds/:name/download', async (req, reply) => {
    const inst = manager.get(req.params.id);
    checkWorldName(req.params.name);
    const base = worldsOf(inst);
    const folders = await worldFolders(base, req.params.name);
    if (folders.length === 0) throw new UserError(t('The world does not exist yet.'));
    const resume = await backups.pauseSaves(inst);
    try {
      const items = await collectFiles(base, folders, (rel) => /(^|\/)session\.lock$/.test(rel));
      const stream = zipStream(items);
      stream.once('close', resume);
      stream.once('end', resume);
      stream.once('error', resume);
      attachment(reply, `${req.params.name}.zip`);
      return reply.send(stream);
    } catch (err) {
      resume();
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Querystring: { name?: string; activate?: string }; Body: Readable }>(
    '/api/servers/:id/worlds/import',
    { schema: { querystring: { type: 'object', properties: { name: { type: 'string', maxLength: 64 }, activate: { type: 'string' } } } } },
    async (req) => {
      const inst = manager.get(req.params.id);
      if (inst.task) throw new UserError(t('Wait for the task on the server to finish.'));
      const base = worldsOf(inst);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_WORLD_UPLOAD) throw new UserError(t('The world is too big (max 20 GB).'));
      const fs = await statfs(inst.dir).catch(() => null);
      if (fs && declared * 2.5 > fs.bavail * fs.bsize) throw new UserError(t('There is not enough disk space to unpack the world.'));
      if (req.query.activate === '1' && inst.running) throw new UserError(t('Stop the server first to make it active.'));
      // A zipped world unpacks to roughly twice its size.
      checkDiskRoom(inst.cfg, inst.diskUsageMb, declared * 2);

      const tmpName = `.srvmc-import-${Date.now()}.zip`;
      await saveUpload(inst.dir, '', tmpName, req.body, MAX_WORLD_UPLOAD, false);
      const zip = path.join(inst.dir, tmpName);
      try {
        const name = await manager.runTask(inst.cfg.id, 'import', t('Unpacking the world'), (report) =>
          importWorld(inst.dir, zip, req.query.name ?? '', (pct) => report(pct, t('Unpacking the world')), base),
        );
        if (req.query.activate === '1') await setActiveWorld(inst.dir, name);
        inst.pushLog('system', t('World uploaded as "{name}".', { name }));
        return { name, worlds: await listWorlds(inst) };
      } finally {
        await rm(zip, { force: true });
        manager.emit('files-changed', inst.cfg.id);
      }
    },
  );

  // Datapacks of the active world
  const packsOf = (id: string) => {
    const inst = manager.get(id);
    if (!datapacksSupported(inst.cfg)) throw new UserError(t('Datapacks work on Java servers only.'));
    return inst;
  };
  const packChanged = (inst: ServerInstance, message: string) => {
    inst.pushLog('system', message);
    manager.emit('files-changed', inst.cfg.id);
  };
  app.get<{ Params: { id: string } }>('/api/servers/:id/datapacks', (req) => listDatapacks(packsOf(req.params.id).dir));
  app.post<{ Params: { id: string }; Querystring: { name: string }; Body: Readable }>(
    '/api/servers/:id/datapacks/upload',
    { schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 } } } } },
    async (req) => {
      const inst = packsOf(req.params.id);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_DATAPACK) throw new UserError(t('The datapack is too big (max 512 MB).'));
      checkDiskRoom(inst.cfg, inst.diskUsageMb, declared * 2);
      const tmpName = `.srvmc-datapack-${Date.now()}.zip`;
      await saveUpload(inst.dir, '', tmpName, req.body, MAX_DATAPACK, false);
      try {
        const name = await addDatapack(inst.dir, path.join(inst.dir, tmpName), req.query.name);
        packChanged(inst, inst.running ? t('Datapack {name} added. It loads after /reload or the next start.', { name }) : t('Datapack {name} added.', { name }));
        return listDatapacks(inst.dir);
      } finally {
        await rm(path.join(inst.dir, tmpName), { force: true });
      }
    },
  );
  app.put<{ Params: { id: string; name: string }; Body: { enabled: boolean } }>(
    '/api/servers/:id/datapacks/:name/enabled',
    { schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
    async (req) => {
      const inst = packsOf(req.params.id);
      if (inst.running) throw new UserError(t('Stop the server first – {what} does not work while it runs.', { what: t('turning datapacks on and off') }));
      await setDatapackEnabled(inst.dir, req.params.name, req.body.enabled);
      packChanged(inst, req.body.enabled ? t('Datapack {name} turned on.', { name: req.params.name }) : t('Datapack {name} turned off.', { name: req.params.name }));
      return listDatapacks(inst.dir);
    },
  );
  app.delete<{ Params: { id: string; name: string } }>('/api/servers/:id/datapacks/:name', async (req) => {
    const inst = packsOf(req.params.id);
    if (inst.running) throw new UserError(t('Stop the server first – {what} does not work while it runs.', { what: t('deleting datapacks') }));
    await removeDatapack(inst.dir, req.params.name);
    packChanged(inst, t('Datapack {name} deleted.', { name: req.params.name }));
    return listDatapacks(inst.dir);
  });

  // Backups
  app.get<{ Params: { id: string } }>('/api/servers/:id/backups', async (req) => {
    const inst = manager.get(req.params.id);
    return { backups: await backups.list(req.params.id), nextRun: backups.nextRun(inst.cfg) };
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/backups', async (req, reply) => {
    manager.get(req.params.id);
    // Big worlds take minutes; the panel follows progress through the server's task field.
    void backups.create(req.params.id, 'manual').catch((err: Error) => manager.get(req.params.id).pushLog('error', t('The backup failed: {message}', { message: err.message })));
    reply.code(202);
    return { started: true };
  });
  app.post<{ Params: { id: string; file: string } }>('/api/servers/:id/backups/:file/restore', async (req, reply) => {
    const inst = stopped(req.params.id, t('restoring a backup'));
    const file = backups.fileFor(inst.cfg.id, req.params.file);
    if (!(await stat(file).catch(() => null))) throw new UserError(t('The backup does not exist.'));
    void backups.restore(req.params.id, req.params.file).catch((err: Error) => inst.pushLog('error', `Obnova selhala: ${err.message}`));
    reply.code(202);
    return { started: true };
  });
  app.delete<{ Params: { id: string; file: string } }>('/api/servers/:id/backups/:file', async (req) => {
    await backups.remove(req.params.id, req.params.file);
    return { backups: await backups.list(req.params.id) };
  });
  app.get<{ Params: { id: string; file: string } }>('/api/servers/:id/backups/:file/download', async (req, reply) => {
    manager.get(req.params.id);
    const file = backups.fileFor(req.params.id, req.params.file);
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) throw new UserError(t('The backup does not exist.'));
    attachment(reply, req.params.file, s.size);
    return reply.send(createReadStream(file));
  });

  // Pre-generation
  app.post<{ Params: { id: string } }>('/api/servers/:id/pregen/install', async (req) => {
    const inst = manager.get(req.params.id);
    const files = await installChunky(inst, paths);
    await manager.refreshPregen(inst);
    inst.pushLog('system', `${t('Installed: {list}', { list: files.join(', ') })}. ${inst.running ? t('Restart the server to load it.') : ''}`);
    return { files, needsRestart: inst.running };
  });
  app.post<{ Params: { id: string }; Body: PregenRequest }>(
    '/api/servers/:id/pregen/start',
    {
      schema: {
        body: {
          type: 'object',
          required: ['dimension', 'radius', 'shape', 'setBorder'],
          additionalProperties: false,
          properties: {
            dimension: { type: 'string', enum: ['overworld', 'nether', 'end'] },
            radius: { type: 'integer', minimum: 100, maximum: 100000 },
            shape: { type: 'string', enum: ['square', 'circle'] },
            setBorder: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const inst = manager.get(req.params.id);
      await startPregen(inst, req.body);
      return manager.info(inst);
    },
  );
  app.post<{ Params: { id: string; action: string } }>('/api/servers/:id/pregen/:action', async (req) => {
    const inst = manager.get(req.params.id);
    const action = req.params.action;
    if (action !== 'pause' && action !== 'continue' && action !== 'cancel') throw new UserError(t('Unknown action.'));
    pregenCommand(inst, action);
    return manager.info(inst);
  });
}
