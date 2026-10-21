import { cached, fetchJson } from './http.ts';

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export interface ManifestVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  url: string;
  releaseTime: string;
}

export interface Manifest {
  latest: { release: string; snapshot: string };
  versions: ManifestVersion[];
}

export interface VersionMeta {
  id: string;
  javaVersion?: { majorVersion: number };
  downloads: { server?: { url: string; sha1: string; size: number } };
}

export function getManifest(): Promise<Manifest> {
  return cached('mojang-manifest', 10 * 60_000, () => fetchJson<Manifest>(MANIFEST_URL));
}

export async function getVersionMeta(id: string): Promise<VersionMeta | undefined> {
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) return undefined;
  return cached(`mojang-meta-${id}`, 60 * 60_000, () => fetchJson<VersionMeta>(entry.url));
}

/** Fallback when Mojang's metadata has no Java version (very old releases, or ids Mojang does not list). */
export function guessJavaMajor(version: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return 21;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major >= 26) return 25;
  if (major !== 1) return 21;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/** Temurin publishes no JRE for every feature release; map those to the nearest one that runs the game. */
export function normalizeJavaMajor(major: number): number {
  if (major === 16) return 17;
  return major;
}

export async function javaMajorFor(version: string): Promise<number> {
  let major: number | undefined;
  try {
    major = (await getVersionMeta(version))?.javaVersion?.majorVersion;
  } catch {
    major = undefined;
  }
  return normalizeJavaMajor(major ?? guessJavaMajor(version));
}
