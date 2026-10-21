// Forge and NeoForge: both ship an installer that downloads libraries and writes run scripts.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { BuildInfo } from '@srvmc/shared';
import { cached, fetchJson, fetchOk } from '../http.ts';
import { forgeLaunchArgs } from '../installer.ts';
import { mavenChecksum } from '../maven.ts';
import { javaMajorFor } from '../mojang.ts';
import { compareVersions, UserError, type InstallContext, type Provider } from './types.ts';

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

const sha1Of = (url: string) => mavenChecksum(url, 'sha1');

function installerStep(prefix: 'forge' | 'neoforge') {
  return async (ctx: InstallContext): Promise<string[]> => {
    ctx.progress('Spouštím instalátor (stahuje knihovny, chvíli to trvá)', null);
    let lines = 0;
    await ctx.run(['-jar', 'installer.jar', '--installServer'], {
      onLine: () => {
        lines++;
        if (lines % 25 === 0) ctx.progress(`Instalátor pracuje · ${lines} kroků`, null);
      },
    });
    await rm(path.join(ctx.dir, 'installer.jar'), { force: true });
    return forgeLaunchArgs(ctx.dir, prefix);
  };
}

// ---- Forge ----

const forgePromos = () =>
  cached('forge-promos', 10 * 60_000, () => fetchJson<{ promos: Record<string, string> }>('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'));

const forgeMaven = () =>
  cached('forge-maven', 10 * 60_000, async () => {
    const xml = await (await fetchOk(`${FORGE_MAVEN}/maven-metadata.xml`)).text();
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]!);
  });

export async function forgeBuilds(mc: string): Promise<BuildInfo[]> {
  const [promos, all] = await Promise.all([forgePromos(), forgeMaven()]);
  const recommended = promos.promos[`${mc}-recommended`];
  const latest = promos.promos[`${mc}-latest`];
  const builds = all
    .filter((v) => v.startsWith(`${mc}-`))
    .map((v) => ({ full: v, forge: v.slice(mc.length + 1) }))
    .sort((a, b) => compareVersions(b.forge, a.forge));
  const label = (forge: string) => `Forge ${forge}${forge === recommended ? ' (doporučeno)' : forge === latest ? ' (nejnovější)' : ''}`;
  const first = builds.filter((b) => b.forge === recommended || (!recommended && b.forge === latest));
  const rest = builds.filter((b) => !first.includes(b));
  return [...first, ...rest].map((b) => ({ id: b.full, label: label(b.forge), channel: b.forge === recommended || (!recommended && b.forge === latest) ? 'stable' : 'beta' }));
}

export const forge: Provider = {
  type: 'forge',

  async listVersions() {
    const { promos } = await forgePromos();
    const versions = new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, '')));
    return [...versions]
      .filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v))
      .sort((a, b) => compareVersions(b, a))
      .map((id) => ({ id, type: 'release' }));
  },

  listBuilds: forgeBuilds,

  async plan(mc, build) {
    const builds = await forgeBuilds(mc);
    const chosen = build ? builds.find((b) => b.id === build) : (builds.find((b) => b.channel === 'stable') ?? builds[0]);
    if (!chosen) throw new UserError(`Forge pro ${mc} neexistuje.`);
    const url = `${FORGE_MAVEN}/${chosen.id}/forge-${chosen.id}-installer.jar`;
    return {
      files: [{ url, sha1: await sha1Of(url), fileName: `forge-${chosen.id}-installer.jar`, target: 'installer.jar' }],
      javaMajor: await javaMajorFor(mc),
      build: chosen.id,
      install: installerStep('forge'),
    };
  },
};

// ---- NeoForge ----

/** NeoForge 21.1.x is for Minecraft 1.21.1; from 26.x on it mirrors the game version (26.3.0.95 → 26.3). */
export function neoForgeGameVersion(neo: string): string | null {
  const parts = neo.split('-')[0]!.split('.').map(Number);
  if (parts.some((n) => !Number.isInteger(n))) return null;
  const [a, b, c] = parts;
  if (a === undefined || b === undefined) return null;
  // Year-based releases have four parts: 26.3.0.95.
  if (parts.length === 4 && a >= 26) return c ? `${a}.${b}.${c}` : `${a}.${b}`;
  if (parts.length !== 3 || a < 20 || a >= 26) return null;
  return b ? `1.${a}.${b}` : `1.${a}`;
}

const neoVersions = () =>
  cached('neoforge-versions', 10 * 60_000, () => fetchJson<{ versions: string[] }>('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'));

async function neoBuilds(mc: string): Promise<BuildInfo[]> {
  const { versions } = await neoVersions();
  return versions
    .filter((v) => neoForgeGameVersion(v) === mc)
    .sort((a, b) => compareVersions(b, a))
    .map((v) => ({ id: v, label: `NeoForge ${v}`, channel: v.includes('beta') ? 'beta' : 'stable' }));
}

export const neoforge: Provider = {
  type: 'neoforge',

  async listVersions(includeSnapshots) {
    const { versions } = await neoVersions();
    const stable = new Map<string, boolean>();
    for (const v of versions) {
      const mc = neoForgeGameVersion(v);
      if (mc) stable.set(mc, (stable.get(mc) ?? false) || !v.includes('beta'));
    }
    return [...stable.entries()]
      .filter(([, s]) => s || includeSnapshots)
      .sort((a, b) => compareVersions(b[0], a[0]))
      .map(([id, s]) => ({ id, type: s ? 'release' : 'snapshot' }));
  },

  listBuilds: neoBuilds,

  async plan(mc, build) {
    const builds = await neoBuilds(mc);
    const chosen = build ? builds.find((b) => b.id === build) : (builds.find((b) => b.channel === 'stable') ?? builds[0]);
    if (!chosen) throw new UserError(`NeoForge pro ${mc} neexistuje.`);
    const url = `${NEO_MAVEN}/${chosen.id}/neoforge-${chosen.id}-installer.jar`;
    return {
      files: [{ url, sha1: await sha1Of(url), fileName: `neoforge-${chosen.id}-installer.jar`, target: 'installer.jar' }],
      javaMajor: await javaMajorFor(mc),
      build: chosen.id,
      install: installerStep('neoforge'),
    };
  },
};
