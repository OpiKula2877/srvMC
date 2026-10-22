import type { BuildInfo, GameVersion, ModpackInfo, ServerType } from '@srvmc/shared';
import type { DownloadSpec } from '../download.ts';
import type { Paths } from '../paths.ts';

/** A file the installer downloads (through the cache) and copies to `target` inside the server folder. */
export interface PlannedFile extends DownloadSpec {
  target: string;
}

/** What an installer step gets: Java ready, files downloaded, a way to run Java and report progress. */
export interface InstallContext {
  dir: string;
  /** The server's port and name, for installers that write their own config. */
  port: number;
  name: string;
  java: string;
  javaMajor: number;
  paths: Paths;
  log(text: string): void;
  /** `link`: a page the user has to open (sign-in), shown as a button next to the progress. */
  progress(text: string, pct: number | null, link?: string): void;
  /** Runs Java with `args` (output goes to the server console). Rejects on a non-zero exit code. */
  run(args: string[], opts?: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void; java?: string }): Promise<void>;
  /** Path to a full JDK of `javaMajor` (with javac), downloaded on first use. */
  ensureJdk(): Promise<string>;
}

export interface InstallPlan {
  files: PlannedFile[];
  javaMajor: number;
  build: string;
  /** Simple servers: started with `java -jar <launchJar>`. */
  launchJar?: string;
  /** Installer-based servers: runs after the downloads and returns the launch arguments (after the JVM options). */
  install?: (ctx: InstallContext) => Promise<string[]>;
  /** The Minecraft version to show when the requested "version" was something else (a modpack id). */
  displayVersion?: string;
  modpack?: ModpackInfo;
  /** The install step returns [program, ...args] of a native server (Bedrock); no Java is needed. */
  native?: boolean;
}

export interface PlanEnv {
  paths: Paths;
}

export interface Provider {
  type: ServerType;
  listVersions(includeSnapshots: boolean): Promise<GameVersion[]>;
  listBuilds(version: string): Promise<BuildInfo[]>;
  plan(version: string, build?: string, env?: PlanEnv): Promise<InstallPlan>;
}

export class UserError extends Error {
  readonly statusCode = 400;
}

/** Compares dotted versions numerically ("1.21.10" > "1.21.9"). Non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
