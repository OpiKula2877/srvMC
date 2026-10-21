import { fetchOk } from './http.ts';

const HEX_LENGTH = { sha1: 40, sha256: 64 } as const;

/**
 * Maven repositories publish checksum files next to each artifact. They describe the file that is
 * actually served, so they beat hashes copied into other APIs. A missing one just means no check.
 */
export async function mavenChecksum(url: string, algo: 'sha1' | 'sha256'): Promise<string | undefined> {
  try {
    const text = (await (await fetchOk(`${url}.${algo}`, { timeoutMs: 15_000 })).text()).trim().split(/\s+/)[0];
    return text && new RegExp(`^[0-9a-f]{${HEX_LENGTH[algo]}}$`, 'i').test(text) ? text.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
