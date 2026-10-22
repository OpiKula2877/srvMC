import { createHash } from 'node:crypto';
import { USER_AGENT } from './http.ts';
import { t } from '@srvmc/shared';

export function dashUuid(hex: string): string {
  const h = hex.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The UUID an offline-mode server gives a player: name-based UUID v3 of "OfflinePlayer:<name>". */
export function offlineUuid(name: string): string {
  const md5 = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6]! & 0x0f) | 0x30;
  md5[8] = (md5[8]! & 0x3f) | 0x80;
  return dashUuid(md5.toString('hex'));
}

export interface Profile {
  uuid: string;
  name: string;
}

/** Looks up a paid account. Returns null when no account has that name. */
export async function lookupProfile(name: string): Promise<Profile | null> {
  const res = await fetch(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(t('The Mojang API answered {status}. Try again in a moment.', { status: res.status }));
  const data = (await res.json()) as { id: string; name: string };
  return { uuid: dashUuid(data.id), name: data.name };
}
