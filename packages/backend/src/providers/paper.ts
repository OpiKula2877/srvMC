import type { BuildInfo } from '@srvmc/shared';
import { cached, fetchJson } from '../http.ts';
import { javaMajorFor } from '../mojang.ts';
import { UserError, type Provider } from './types.ts';

const FILL = 'https://fill.papermc.io/v3/projects';

interface FillProject {
  versions: Record<string, string[]>;
}

interface FillBuild {
  id: number;
  channel: 'STABLE' | 'BETA' | 'ALPHA' | 'RECOMMENDED';
  downloads: Record<string, { name: string; checksums: { sha256: string }; size: number; url: string }>;
}

/** Paper versions without a suffix are releases; `-pre`, `-rc` and the like are test builds. */
export function isPaperRelease(id: string): boolean {
  return !id.includes('-');
}

export function paperChannel(channel: FillBuild['channel']): BuildInfo['channel'] {
  if (channel === 'STABLE' || channel === 'RECOMMENDED') return 'stable';
  if (channel === 'BETA') return 'beta';
  return 'experimental';
}

/** Picks the requested build, else the newest stable one, else the newest of any channel. */
export function pickPaperBuild(builds: FillBuild[], wanted?: string): FillBuild | undefined {
  if (wanted) return builds.find((b) => String(b.id) === wanted);
  const sorted = [...builds].sort((a, b) => b.id - a.id);
  return sorted.find((b) => paperChannel(b.channel) === 'stable') ?? sorted[0];
}

const builds = (project: string, version: string) =>
  cached(`fill-${project}-${version}`, 5 * 60_000, () =>
    fetchJson<FillBuild[]>(`${FILL}/${project}/versions/${encodeURIComponent(version)}/builds`),
  );

export function paperFamily(project: 'paper' | 'folia' | 'velocity', type: Provider['type']): Provider {
  return {
    type,

    async listVersions(includeSnapshots) {
      const p = await cached(`fill-${project}`, 10 * 60_000, () => fetchJson<FillProject>(`${FILL}/${project}`));
      return Object.values(p.versions)
        .flat()
        .filter((id) => includeSnapshots || isPaperRelease(id))
        .map((id) => ({ id, type: isPaperRelease(id) ? 'release' : 'snapshot' }));
    },

    async listBuilds(version) {
      const list = [...(await builds(project, version))].sort((a, b) => b.id - a.id);
      return list.map((b) => {
        const channel = paperChannel(b.channel);
        const suffix = channel === 'stable' ? '' : channel === 'beta' ? ' (beta)' : ' (experimentální)';
        return { id: String(b.id), label: `Build #${b.id}${suffix}`, channel };
      });
    },

    async plan(version, build) {
      const chosen = pickPaperBuild(await builds(project, version), build);
      if (!chosen) throw new UserError(`Build ${build ?? ''} pro ${version} neexistuje.`);
      const dl = chosen.downloads['server:default'];
      if (!dl) throw new UserError(`Build #${chosen.id} nemá soubor ke stažení.`);
      return {
        files: [{ url: dl.url, sha256: dl.checksums.sha256, size: dl.size, fileName: dl.name, target: `${project}.jar` }],
        javaMajor: await javaMajorFor(version),
        launchJar: `${project}.jar`,
        build: String(chosen.id),
      };
    },
  };
}

export const paper = paperFamily('paper', 'paper');
