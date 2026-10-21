// Size of a server folder and the soft disk limit.
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '@srvmc/shared';
import { UserError } from './providers/types.ts';

const MB = 1024 * 1024;

/** Total size of regular files under `dir` in bytes. Links are not followed. */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

export function sizeMb(bytes: number): number {
  return Math.round(bytes / MB);
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;

/** Refuses an upload or download into the server that would cross its disk limit. */
export function checkDiskRoom(cfg: Pick<ServerConfig, 'diskLimitMb'>, usageMb: number | undefined, incomingBytes = 0): void {
  const limit = cfg.diskLimitMb ?? 0;
  if (!limit || usageMb === undefined) return;
  const after = usageMb + incomingBytes / MB;
  if (after > limit) {
    throw new UserError(
      incomingBytes
        ? `Překročil bys limit disku serveru (${gb(after)} z ${gb(limit)}). Uvolni místo nebo limit zvyš v Nastavení.`
        : `Server překročil limit disku (${gb(usageMb)} z ${gb(limit)}). Uvolni místo nebo limit zvyš v Nastavení.`,
    );
  }
}
