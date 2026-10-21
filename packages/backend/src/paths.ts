import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface Paths {
  root: string;
  servers: string;
  cache: string;
  runtimes: string;
  backups: string;
  trash: string;
  serversFile: string;
}

export function makePaths(root = process.env.SRVMC_HOME ?? path.join(os.homedir(), 'srvMC')): Paths {
  return {
    root,
    servers: path.join(root, 'servers'),
    cache: path.join(root, 'cache'),
    runtimes: path.join(root, 'runtimes'),
    backups: path.join(root, 'backups'),
    trash: path.join(root, 'trash'),
    serversFile: path.join(root, 'servers.json'),
  };
}

export async function ensureDirs(paths: Paths): Promise<void> {
  for (const dir of [paths.root, paths.servers, paths.cache, paths.runtimes, paths.backups, paths.trash]) {
    await mkdir(dir, { recursive: true });
  }
}
