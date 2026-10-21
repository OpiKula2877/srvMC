import { rm } from 'node:fs/promises';
import path from 'node:path';
import { cached, fetchJson } from '../http.ts';
import { mavenChecksum } from '../maven.ts';
import { javaMajorFor } from '../mojang.ts';
import { UserError, type Provider } from './types.ts';

const META = 'https://meta.quiltmc.org/v3';

interface QuiltLoader {
  loader: { version: string };
}

interface QuiltInstaller {
  version: string;
  url: string;
  file_size: number;
}

const loadersFor = (mc: string) => cached(`quilt-loaders-${mc}`, 10 * 60_000, () => fetchJson<QuiltLoader[]>(`${META}/versions/loader/${encodeURIComponent(mc)}`));

export const quilt: Provider = {
  type: 'quilt',

  async listVersions(includeSnapshots) {
    const games = await cached('quilt-games', 10 * 60_000, () => fetchJson<{ version: string; stable: boolean }[]>(`${META}/versions/game`));
    return games.filter((g) => g.stable || includeSnapshots).map((g) => ({ id: g.version, type: g.stable ? 'release' : 'snapshot' }));
  },

  // Quilt's last "stable" loader is years old and cannot read classes of current Minecraft
  // (built for Java 25), so the newest loader is the recommended one even when it is a beta.
  async listBuilds(mc) {
    return (await loadersFor(mc)).map(({ loader }, i) => ({
      id: loader.version,
      label: `Quilt Loader ${loader.version}${i === 0 ? ' (doporučeno)' : ''}`,
      channel: i === 0 || !/beta|alpha|pre|rc/i.test(loader.version) ? 'stable' : 'beta',
    }));
  },

  async plan(mc, build) {
    const builds = await this.listBuilds(mc);
    const loader = build ?? builds[0]?.id;
    if (!loader || !builds.some((b) => b.id === loader)) throw new UserError(`Quilt Loader pro ${mc} neexistuje.`);
    const installers = await cached('quilt-installers', 10 * 60_000, () => fetchJson<QuiltInstaller[]>(`${META}/versions/installer`));
    const inst = installers[0];
    if (!inst) throw new UserError('Quilt installer není dostupný.');
    // The hashes in Quilt Meta can lag behind the file Maven serves; Maven's own checksum is the one to trust.
    const sha256 = await mavenChecksum(inst.url, 'sha256');
    return {
      files: [{ url: inst.url, sha256, size: inst.file_size, fileName: `quilt-installer-${inst.version}.jar`, target: 'quilt-installer.jar' }],
      javaMajor: await javaMajorFor(mc),
      build: loader,
      async install(ctx) {
        ctx.progress('Instaluji Quilt a stahuji server', null);
        await ctx.run(['-jar', 'quilt-installer.jar', 'install', 'server', mc, loader, '--download-server', '--install-dir=.']);
        await rm(path.join(ctx.dir, 'quilt-installer.jar'), { force: true });
        return ['-jar', 'quilt-server-launch.jar'];
      },
    };
  },
};
