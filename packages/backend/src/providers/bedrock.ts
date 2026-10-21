// Bedrock Dedicated Server (and its Preview) from Mojang's official download links. A native
// program: the zip unpacks next to the worlds and runs as bedrock_server(.exe), no Java.
import { cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { bedrockUdpRange, type ServerType } from '@srvmc/shared';
import { downloadToCache } from '../download.ts';
import { cached, fetchJson, USER_AGENT } from '../http.ts';
import { UserError, type Provider } from './types.ts';

const LINKS = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';

/** Files a server keeps between updates; an update must not overwrite them with defaults. */
export const BEDROCK_KEEP = new Set(['server.properties', 'allowlist.json', 'permissions.json', 'whitelist.json']);

export interface BedrockLink {
  url: string;
  version: string;
}

export function pickLink(links: { downloadType: string; downloadUrl: string }[], preview: boolean, platform: NodeJS.Platform = process.platform): BedrockLink | null {
  const os = platform === 'win32' ? 'Windows' : 'Linux';
  const want = preview ? `serverBedrockPreview${os}` : `serverBedrock${os}`;
  const link = links.find((l) => l.downloadType === want);
  const version = link && /bedrock-server-([\d.]+)\.zip$/i.exec(link.downloadUrl)?.[1];
  return link && version ? { url: link.downloadUrl, version } : null;
}

export async function latestBedrock(preview: boolean): Promise<BedrockLink> {
  const res = await cached('bedrock-links', 10 * 60_000, () => fetchJson<{ result: { links: { downloadType: string; downloadUrl: string }[] } }>(LINKS));
  const link = pickLink(res.result.links, preview);
  if (!link) throw new UserError(process.platform === 'win32' || process.platform === 'linux' ? 'Mojang teď nenabízí odkaz na Bedrock server.' : 'Bedrock server existuje jen pro Windows a Linux.');
  return link;
}

/** minecraft.net sends Content-MD5 (base64); as hex it lets the download be verified. */
export function md5FromHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const hex = Buffer.from(value, 'base64').toString('hex');
  return hex.length === 32 ? hex : undefined;
}

async function headInfo(url: string): Promise<{ md5?: string; size?: number }> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    const size = Number(res.headers.get('content-length')) || undefined;
    return { md5: md5FromHeader(res.headers.get('content-md5')), size };
  } catch {
    return {};
  }
}

export const bedrockExe = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server');

/**
 * server.properties srvMC keeps for a Bedrock server on `port`. Since 26.x NetherNet is the only
 * transport: a TCP handshake on server-port, then UDP per player. Without pinning, those UDP ports
 * come from the ephemeral range and cannot be forwarded; srvMC pins them to a block of its own.
 */
export function bedrockPortProps(port: number): Record<string, string> {
  const [from, to] = bedrockUdpRange(port);
  return { 'server-port': String(port), 'server-udp-ports': `${from}-${to}` };
}

/** Unpacks the server zip; files the server already has (settings, lists) stay as they are. */
export async function extractBedrock(zip: string, dir: string): Promise<void> {
  const existing = new Set(await readdir(dir).catch(() => [] as string[]));
  const keep = [...BEDROCK_KEEP].filter((f) => existing.has(f));
  const tmp = path.join(dir, `.srvmc-bedrock-${Date.now()}`);
  await extractZip(zip, { dir: tmp });
  try {
    for (const name of await readdir(tmp)) {
      if (keep.includes(name)) continue;
      await cp(path.join(tmp, name), path.join(dir, name), { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function bedrockProvider(type: ServerType, preview: boolean): Provider {
  return {
    type,

    // Mojang only links the newest build of each channel.
    async listVersions() {
      return [{ id: (await latestBedrock(preview)).version, type: 'release' }];
    },

    async listBuilds(version) {
      return [{ id: 'official', label: `Bedrock Dedicated Server ${version}${preview ? ' (Preview)' : ''}`, channel: preview ? 'beta' : 'stable' }];
    },

    async plan(version) {
      const link = await latestBedrock(preview);
      if (version !== link.version) throw new UserError(`Mojang nabízí ke stažení jen nejnovější verzi (${link.version}).`);
      const head = await headInfo(link.url);
      return {
        files: [],
        javaMajor: 0,
        build: 'official',
        native: true,
        displayVersion: link.version,
        async install(ctx) {
          const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
          const zip = await downloadToCache(ctx.paths, { url: link.url, fileName: path.posix.basename(new URL(link.url).pathname), md5: head.md5, size: head.size }, (done, total) =>
            ctx.progress(total ? `Stahuji Bedrock server · ${mb(done)} z ${mb(total)} MB` : `Stahuji Bedrock server · ${mb(done)} MB`, total ? Math.round((done / total) * 100) : null),
          );
          ctx.progress('Rozbaluji Bedrock server', null);
          await extractBedrock(zip, ctx.dir);
          if (!head.md5) ctx.log('Mojang k souboru neposlal kontrolní součet, stažení nešlo ověřit.');
          return [bedrockExe()];
        },
      };
    },
  };
}

export const bedrock = bedrockProvider('bedrock', false);
export const bedrockPreview = bedrockProvider('bedrock-preview', true);
