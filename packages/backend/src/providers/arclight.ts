// Arclight: Forge/NeoForge/Fabric servers that also load Bukkit plugins. Releases live on GitHub.
import type { BuildInfo } from '@srvmc/shared';
import { cached, fetchJson } from '../http.ts';
import { javaMajorFor } from '../mojang.ts';
import { compareVersions, UserError, type Provider } from './types.ts';

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

interface GhRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  assets: GhAsset[];
}

export interface ArclightBuild {
  loader: 'forge' | 'neoforge' | 'fabric';
  mc: string;
  version: string;
  prerelease: boolean;
  published: string;
  asset: GhAsset;
}

const ASSET_RE = /^arclight-(forge|neoforge|fabric)-(\d+\.\d+(?:\.\d+)?)-(.+)\.jar$/;
const LOADER_NAME = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric' } as const;
const LOADER_ORDER = { neoforge: 0, forge: 1, fabric: 2 } as const;

export function parseArclightReleases(releases: GhRelease[]): ArclightBuild[] {
  const out: ArclightBuild[] = [];
  for (const r of releases) {
    if (r.draft) continue;
    for (const asset of r.assets) {
      const m = ASSET_RE.exec(asset.name);
      if (m) out.push({ loader: m[1] as ArclightBuild['loader'], mc: m[2]!, version: m[3]!, prerelease: r.prerelease, published: r.published_at, asset });
    }
  }
  return out.sort((a, b) => b.published.localeCompare(a.published) || LOADER_ORDER[a.loader] - LOADER_ORDER[b.loader]);
}

// GitHub allows 60 anonymous requests an hour; the list barely changes.
const builds = () =>
  cached('arclight-releases', 30 * 60_000, async () =>
    parseArclightReleases(await fetchJson<GhRelease[]>('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=50', { headers: { Accept: 'application/vnd.github+json' } })),
  );

// The asset name already says loader, game version and Arclight version.
const buildId = (b: ArclightBuild) => b.asset.name;

async function buildsFor(mc: string): Promise<BuildInfo[]> {
  return (await builds())
    .filter((b) => b.mc === mc)
    .map((b) => ({ id: buildId(b), label: `${LOADER_NAME[b.loader]} · Arclight ${b.version}`, channel: b.prerelease ? 'beta' : 'stable' }));
}

export const arclight: Provider = {
  type: 'arclight',

  async listVersions(includeSnapshots) {
    const stable = new Map<string, boolean>();
    for (const b of await builds()) stable.set(b.mc, (stable.get(b.mc) ?? false) || !b.prerelease);
    return [...stable.entries()]
      .filter(([, s]) => s || includeSnapshots)
      .sort((a, b) => compareVersions(b[0], a[0]))
      .map(([id, s]) => ({ id, type: s ? 'release' : 'snapshot' }));
  },

  listBuilds: buildsFor,

  async plan(mc, build) {
    const all = (await builds()).filter((b) => b.mc === mc);
    const chosen = build ? all.find((b) => buildId(b) === build) : (all.find((b) => !b.prerelease) ?? all[0]);
    if (!chosen) throw new UserError(`Arclight pro ${mc} neexistuje.`);
    const sha256 = chosen.asset.digest?.startsWith('sha256:') ? chosen.asset.digest.slice(7) : undefined;
    return {
      files: [{ url: chosen.asset.browser_download_url, sha256, size: chosen.asset.size, fileName: chosen.asset.name, target: 'arclight.jar' }],
      javaMajor: await javaMajorFor(mc),
      launchJar: 'arclight.jar',
      build: buildId(chosen),
    };
  },
};
