import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { downloadToCache } from './download.ts';
import { fetchJson } from './http.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/index.ts';

const API = 'https://api.modrinth.com/v2';

interface MrFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1: string; sha512: string };
}

export interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  files: MrFile[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[];
}

/** Picks the newest release (else any) version of a project for the given loaders and game version. */
export async function findVersion(project: string, loaders: string[], gameVersion: string): Promise<MrVersion | null> {
  const q = `loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await fetchJson<MrVersion[]>(`${API}/project/${encodeURIComponent(project)}/version?${q}`);
  return versions.find((v) => v.version_type === 'release') ?? versions[0] ?? null;
}

/** Downloads a project and its required dependencies into `targetDir`. Returns the installed file names. */
export async function installProject(paths: Paths, project: string, loaders: string[], gameVersion: string, targetDir: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(project)) return [];
  seen.add(project);
  const version = await findVersion(project, loaders, gameVersion);
  if (!version) throw new UserError(`Pro ${gameVersion} zatím neexistuje verze ${project} (${loaders.join('/')}).`);
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new UserError(`${project} nemá soubor ke stažení.`);
  if (!/^[\w.+() -]+\.jar$/.test(file.filename)) throw new UserError(`Podezřelý název souboru: ${file.filename}`);

  const cached = await downloadToCache(paths, { url: file.url, fileName: file.filename, sha1: file.hashes.sha1, size: file.size });
  await mkdir(targetDir, { recursive: true });
  await copyFile(cached, path.join(targetDir, file.filename));
  const installed = [file.filename];
  for (const dep of version.dependencies) {
    if (dep.dependency_type === 'required' && dep.project_id) {
      installed.push(...(await installProject(paths, dep.project_id, loaders, gameVersion, targetDir, seen)));
    }
  }
  return installed;
}
