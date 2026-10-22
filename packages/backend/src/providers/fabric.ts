import { cached, fetchJson } from '../http.ts';
import { getVersionMeta, javaMajorFor } from '../mojang.ts';
import { UserError, type PlannedFile, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const META = 'https://meta.fabricmc.net/v2';

interface FabricGame {
  version: string;
  stable: boolean;
}

interface FabricLoaderForGame {
  loader: { version: string; stable: boolean };
}

interface FabricInstaller {
  version: string;
  stable: boolean;
}

const loadersFor = (game: string) =>
  cached(`fabric-loaders-${game}`, 10 * 60_000, () =>
    fetchJson<FabricLoaderForGame[]>(`${META}/versions/loader/${encodeURIComponent(game)}`),
  );

export const fabric: Provider = {
  type: 'fabric',

  async listVersions(includeSnapshots) {
    const games = await cached('fabric-games', 10 * 60_000, () => fetchJson<FabricGame[]>(`${META}/versions/game`));
    return games
      .filter((g) => g.stable || includeSnapshots)
      .map((g) => ({ id: g.version, type: g.stable ? 'release' : 'snapshot' }));
  },

  async listBuilds(version) {
    const loaders = await loadersFor(version);
    return loaders.map(({ loader }) => ({
      id: loader.version,
      label: `Fabric Loader ${loader.version}`,
      channel: loader.stable ? 'stable' : 'beta',
    }));
  },

  async plan(version, build) {
    const loaders = await loadersFor(version);
    if (loaders.length === 0) throw new UserError(t('{name} does not exist.', { name: `Fabric ${version}` }));
    const loader = build ?? (loaders.find((l) => l.loader.stable) ?? loaders[0]!).loader.version;
    if (!loaders.some((l) => l.loader.version === loader)) throw new UserError(t('{name} does not exist.', { name: `Fabric Loader ${loader} (${version})` }));

    const installers = await cached('fabric-installers', 10 * 60_000, () => fetchJson<FabricInstaller[]>(`${META}/versions/installer`));
    const installer = (installers.find((i) => i.stable) ?? installers[0])?.version;
    if (!installer) throw new UserError(t('The Fabric installer is not available.'));

    const files: PlannedFile[] = [
      {
        url: `${META}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`,
        fileName: `fabric-server-${version}-${loader}-${installer}.jar`,
        target: 'fabric-server-launch.jar',
      },
    ];
    // The Fabric launcher looks for the vanilla jar as server.jar. Placing it from the cache saves a download.
    const server = (await getVersionMeta(version).catch(() => undefined))?.downloads.server;
    if (server) files.push({ url: server.url, sha1: server.sha1, size: server.size, fileName: 'server.jar', target: 'server.jar' });

    return { files, javaMajor: await javaMajorFor(version), launchJar: 'fabric-server-launch.jar', build: loader };
  },
};
