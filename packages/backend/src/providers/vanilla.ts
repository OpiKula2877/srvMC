import { getManifest, getVersionMeta, guessJavaMajor, normalizeJavaMajor } from '../mojang.ts';
import { UserError, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

export const vanilla: Provider = {
  type: 'vanilla',

  async listVersions(includeSnapshots) {
    const manifest = await getManifest();
    return manifest.versions
      .filter((v) => v.type === 'release' || (includeSnapshots && v.type === 'snapshot'))
      .map((v) => ({ id: v.id, type: v.type === 'release' ? 'release' : 'snapshot' }));
  },

  async listBuilds() {
    return [{ id: 'official', label: t('Official from Mojang'), channel: 'stable' }];
  },

  async plan(version) {
    const meta = await getVersionMeta(version);
    if (!meta) throw new UserError(t('Version {version} does not exist.', { version }));
    const server = meta.downloads.server;
    if (!server) throw new UserError(t('Version {version} has no server file.', { version }));
    return {
      files: [{ url: server.url, sha1: server.sha1, size: server.size, fileName: 'server.jar', target: 'server.jar' }],
      javaMajor: normalizeJavaMajor(meta.javaVersion?.majorVersion ?? guessJavaMajor(version)),
      launchJar: 'server.jar',
      build: 'official',
    };
  },
};
