import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ServerConfig } from '@srvmc/shared';

/** The server list lives in one JSON file, written atomically (temp file + rename). */
export class ServerStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<ServerConfig[]> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as { servers?: ServerConfig[] };
      return Array.isArray(data.servers) ? data.servers : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  save(servers: ServerConfig[]): Promise<void> {
    const body = JSON.stringify({ version: 1, servers }, null, 2);
    // Serialize writes so an older snapshot never lands after a newer one.
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
