// Spigot and CraftBukkit have no official downloads; BuildTools compiles them on this computer.
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { cached, fetchJson, fetchOk } from '../http.ts';
import { javaMajorFor } from '../mojang.ts';
import { compareVersions, UserError, type Provider } from './types.ts';
import { t } from '@srvmc/shared';

const VERSIONS = 'https://hub.spigotmc.org/versions/';
const BUILDTOOLS = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';

interface SpigotVersion {
  /** Class file versions BuildTools accepts, e.g. [65, 69] = Java 21–25. */
  javaVersions?: [number, number];
}

/** Picks the Java version Mojang asks for, kept within the range this Spigot version builds with. */
export function spigotJava(preferred: number, javaVersions?: [number, number]): number {
  if (!javaVersions) return preferred;
  const [min, max] = javaVersions.map((c) => c - 44) as [number, number];
  return Math.min(max, Math.max(min, preferred));
}

/** Builds share one BuildTools working folder (git checkouts), so only one runs at a time. */
let queue: Promise<unknown> = Promise.resolve();

function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-${week}`;
}

export const spigot: Provider = {
  type: 'spigot',

  async listVersions() {
    const html = await cached('spigot-versions', 30 * 60_000, async () => (await fetchOk(VERSIONS)).text());
    const ids = new Set([...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map((m) => m[1]!));
    return [...ids].sort((a, b) => compareVersions(b, a)).map((id) => ({ id, type: 'release' }));
  },

  async listBuilds() {
    return [
      { id: 'spigot', label: t('Spigot (recommended)'), channel: 'stable' },
      { id: 'craftbukkit', label: t('CraftBukkit (plain Bukkit)'), channel: 'stable' },
    ];
  },

  async plan(mc, build) {
    const variant = build ?? 'spigot';
    if (variant !== 'spigot' && variant !== 'craftbukkit') throw new UserError('Vyber Spigot nebo CraftBukkit.');
    const meta = await fetchJson<SpigotVersion>(`${VERSIONS}${encodeURIComponent(mc)}.json`).catch(() => {
      throw new UserError(t('{name} does not exist.', { name: `Spigot ${mc}` }));
    });
    const javaMajor = spigotJava(await javaMajorFor(mc), meta.javaVersions);
    return {
      // The URL never changes, so a week stamp makes the cache pick up new BuildTools releases.
      files: [{ url: `${BUILDTOOLS}?week=${isoWeek()}`, fileName: 'BuildTools.jar', target: '.srvmc-buildtools.jar' }],
      javaMajor,
      build: variant,
      async install(ctx) {
        const jarName = `${variant}-${mc}.jar`;
        const outDir = path.join(ctx.paths.cache, 'spigot');
        const built = path.join(outDir, jarName);
        const target = `${variant}.jar`;
        const buildToolsJar = path.join(ctx.dir, '.srvmc-buildtools.jar');
        try {
          if (!(await stat(built).catch(() => null))) {
            const job = queue.then(async () => {
              if (await stat(built).catch(() => null)) return;
              const work = path.join(ctx.paths.cache, 'buildtools-work');
              await mkdir(work, { recursive: true });
              await mkdir(outDir, { recursive: true });
              // BuildTools compiles with Maven, which needs javac – a JRE is not enough.
              const jdk = await ctx.ensureJdk();
              ctx.progress(t('Compiling {name} {version} – the first time takes 10–30 minutes', { name: variant === 'spigot' ? 'Spigot' : 'CraftBukkit', version: mc }), null);
              let stage = '';
              await ctx.run(['-jar', buildToolsJar, '--rev', mc, '--compile', variant.toUpperCase(), '--output-dir', outDir, '--final-name', jarName, '--nogui'], {
                cwd: work,
                java: jdk,
                timeoutMs: 60 * 60_000,
                onLine: (line) => {
                  const s = /Cloning|Pulling|Applying|Patching|Decompil|Remapping|Building|Compiling|Downloading/i.exec(line)?.[0];
                  if (s && s !== stage) {
                    stage = s;
                    ctx.progress(`BuildTools: ${line.trim().slice(0, 90)}`, null);
                  }
                },
              });
            });
            queue = job.catch(() => undefined);
            await job;
          }
          if (!(await stat(built).catch(() => null))) throw new UserError(t('BuildTools finished, but the resulting jar is missing. The details are in the console.'));
          await copyFile(built, path.join(ctx.dir, target));
        } finally {
          await rm(buildToolsJar, { force: true });
        }
        return ['-jar', target];
      },
    };
  },
};
