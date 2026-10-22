import { cached, fetchJson } from '../http.ts';
import { javaMajorFor } from '../mojang.ts';
import { compareVersions, UserError, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const API = 'https://api.purpurmc.org/v2/purpur';

interface PurpurVersion {
  builds: { latest: string; all: string[] };
}

interface PurpurBuild {
  build: string;
  result: 'SUCCESS' | 'FAILURE';
  md5: string;
}

const versionInfo = (v: string) => cached(`purpur-${v}`, 5 * 60_000, () => fetchJson<PurpurVersion>(`${API}/${encodeURIComponent(v)}`));

export const purpur: Provider = {
  type: 'purpur',

  async listVersions() {
    const data = await cached('purpur', 10 * 60_000, () => fetchJson<{ versions: string[] }>(API));
    return [...data.versions].sort((a, b) => compareVersions(b, a)).map((id) => ({ id, type: 'release' }));
  },

  async listBuilds(version) {
    const info = await versionInfo(version);
    return [...info.builds.all]
      .sort((a, b) => Number(b) - Number(a))
      .map((id) => ({ id, label: `Build #${id}`, channel: 'stable' }));
  },

  async plan(version, build) {
    const info = await versionInfo(version);
    const id = build ?? info.builds.latest;
    if (!info.builds.all.includes(id)) throw new UserError(t('{name} does not exist.', { name: `Build ${id} (${version})` }));
    const meta = await fetchJson<PurpurBuild>(`${API}/${encodeURIComponent(version)}/${id}`);
    if (meta.result !== 'SUCCESS') throw new UserError(t('Build #{id} failed, pick another one.', { id }));
    return {
      files: [{ url: `${API}/${encodeURIComponent(version)}/${id}/download`, md5: meta.md5, fileName: `purpur-${version}-${id}.jar`, target: 'purpur.jar' }],
      javaMajor: await javaMajorFor(version),
      launchJar: 'purpur.jar',
      build: id,
    };
  },
};
