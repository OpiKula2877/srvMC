// Types and constants shared by the backend and the web panel.

export type ServerType =
  | 'vanilla'
  | 'paper'
  | 'purpur'
  | 'spigot'
  | 'fabric'
  | 'quilt'
  | 'forge'
  | 'neoforge'
  | 'arclight'
  | 'modpack'
  | 'bedrock'
  | 'bedrock-preview'
  | 'velocity'
  | 'hytale';

export interface ServerTypeInfo {
  id: ServerType;
  name: string;
  tag: string;
  color: string;
  defaultPort: number;
  /** Implemented in the current release. Others are shown as "coming soon". */
  available: boolean;
  /** Phase of the roadmap in which the type arrives (for the "coming soon" label). */
  phase?: number;
}

export const SERVER_TYPES: ServerTypeInfo[] = [
  { id: 'vanilla', name: 'Vanilla', tag: 'Čistý Minecraft', color: '#7FB069', defaultPort: 25565, available: true },
  { id: 'paper', name: 'Paper', tag: 'Pluginy · rychlý', color: '#E8EAED', defaultPort: 25565, available: true },
  { id: 'fabric', name: 'Fabric', tag: 'Mody · lehký', color: '#DBD0B4', defaultPort: 25565, available: true },
  { id: 'purpur', name: 'Purpur', tag: 'Pluginy · víc nastavení', color: '#B89BD9', defaultPort: 25565, available: true },
  { id: 'spigot', name: 'Spigot / Bukkit', tag: 'Pluginy · kompilace', color: '#F2B33D', defaultPort: 25565, available: true },
  { id: 'quilt', name: 'Quilt', tag: 'Mody · Fabric kompatibilní', color: '#C57BD6', defaultPort: 25565, available: true },
  { id: 'forge', name: 'Forge', tag: 'Mody · klasika', color: '#8C9BAB', defaultPort: 25565, available: true },
  { id: 'neoforge', name: 'NeoForge', tag: 'Mody · nový Forge', color: '#E08A4F', defaultPort: 25565, available: true },
  { id: 'arclight', name: 'Arclight', tag: 'Mody + pluginy', color: '#6FC3C9', defaultPort: 25565, available: true },
  { id: 'modpack', name: 'Modpack', tag: 'Modrinth · CurseForge', color: '#5BD27A', defaultPort: 25565, available: false, phase: 5 },
  { id: 'bedrock', name: 'Bedrock', tag: 'Mobil · konzole · Win10', color: '#6AA9FF', defaultPort: 19132, available: false, phase: 8 },
  { id: 'bedrock-preview', name: 'Bedrock Preview', tag: 'Testovací Bedrock', color: '#9CC6FF', defaultPort: 19132, available: false, phase: 8 },
  { id: 'velocity', name: 'Velocity', tag: 'Proxy · síť serverů', color: '#4FB5A5', defaultPort: 25577, available: false, phase: 9 },
  { id: 'hytale', name: 'Hytale', tag: 'Experimentální', color: '#F07A6A', defaultPort: 5520, available: false, phase: 8 },
];

export function serverTypeInfo(type: ServerType): ServerTypeInfo {
  const info = SERVER_TYPES.find((t) => t.id === type);
  if (!info) throw new Error(`Unknown server type: ${type}`);
  return info;
}

export type ServerStatus = 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'error';

export type JvmFlagsPreset = 'aikar' | 'default';

export interface ServerConfig {
  id: string;
  name: string;
  type: ServerType;
  version: string;
  /** Loader or build version (Paper build id, Fabric loader version). */
  build?: string;
  port: number;
  ramMinMb: number;
  ramMaxMb: number;
  jvmFlags: JvmFlagsPreset;
  extraJvmArgs: string;
  /** IANA time zone passed to Java (-Duser.timezone). Empty = the computer's zone. */
  timezone?: string;
  javaMajor?: number;
  /** Jar to launch, relative to the server folder. Set by the installer. */
  launchJar?: string;
  /** Launch arguments after the JVM options (e.g. ["-jar", "x.jar"] or ["@libraries/…/win_args.txt"]). */
  launchArgs?: string[];
  eulaAccepted: boolean;
  autoStart: boolean;
  installed: boolean;
  createdAt: string;
  backupSchedule?: BackupSchedule;
  /** "HH:MM" for daily and weekly backups. */
  backupTime?: string;
  /** How many automatic backups to keep. */
  backupKeep?: number;
}

export type BackupSchedule = 'off' | 'hourly' | '6h' | 'daily' | 'weekly';

export interface InstallProgress {
  step: string;
  /** 0–100, or null when the length is unknown. */
  pct: number | null;
  text: string;
}

export type TaskKind = 'backup' | 'restore' | 'import' | 'export';

/** A long job running on a server (backup, restore, world import). Only one at a time. */
export interface TaskProgress {
  kind: TaskKind;
  pct: number | null;
  text: string;
}

export interface ServerInfo extends ServerConfig {
  status: ServerStatus;
  players: string[];
  startedAt?: number;
  install?: InstallProgress;
  task?: TaskProgress;
  pregen?: PregenStatus;
  lastError?: string;
  dir: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'cmd' | 'system';

export interface LogLine {
  t: number;
  level: LogLevel;
  text: string;
}

export interface MetricPoint {
  t: number;
  /** CPU usage of the server process, 0–100 % of the whole machine. */
  cpu: number;
  memMb: number;
}

export interface GameVersion {
  id: string;
  type: 'release' | 'snapshot';
}

export interface BuildInfo {
  id: string;
  label: string;
  channel: 'stable' | 'beta' | 'experimental';
}

export interface CreateServerRequest {
  name: string;
  type: ServerType;
  version: string;
  build?: string;
  port: number;
  ramMaxMb: number;
  eulaAccepted: boolean;
  startAfterInstall: boolean;
}

export interface UpdateServerRequest {
  name?: string;
  port?: number;
  ramMinMb?: number;
  ramMaxMb?: number;
  jvmFlags?: JvmFlagsPreset;
  extraJvmArgs?: string;
  timezone?: string;
  autoStart?: boolean;
  backupSchedule?: BackupSchedule;
  backupTime?: string;
  backupKeep?: number;
}

export interface SystemInfo {
  platform: string;
  cpus: number;
  totalMemMb: number;
  freeMemMb: number;
  diskFreeMb: number | null;
  dataDir: string;
  javaRuntimes: number[];
  version: string;
}

export type WsEvent =
  | { type: 'server'; server: ServerInfo }
  | { type: 'deleted'; id: string }
  | { type: 'log'; id: string; lines: LogLine[] }
  | { type: 'metrics'; id: string; point: MetricPoint };

/** Header every state-changing request must carry (simple CSRF guard for the local API). */
export const CSRF_HEADER = 'x-srvmc';

// ---- Players ----

export type PlayerListKind = 'whitelist' | 'ops' | 'bans' | 'ips';

export interface PlayerEntry {
  /** Player name, or the IP address for IP bans. */
  name: string;
  uuid?: string;
  /** Operator level 1–4. */
  level?: number;
  reason?: string;
  created?: string;
  expires?: string;
  source?: string;
}

export interface PlayersInfo {
  whitelist: PlayerEntry[];
  ops: PlayerEntry[];
  bans: PlayerEntry[];
  ips: PlayerEntry[];
  whitelistEnabled: boolean;
  onlineMode: boolean;
  online: string[];
}

export interface AddPlayerRequest {
  name: string;
  reason?: string;
  level?: number;
}

/** Java Edition player names: 3–16 letters, digits or underscores (old accounts may be shorter). */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// ---- Logs and files ----

export interface LogFileInfo {
  name: string;
  kind: 'log' | 'crash';
  size: number;
  mtime: number;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

/** Largest file the panel edits as text. */
export const MAX_TEXT_FILE = 2 * 1024 * 1024;
/** Largest single upload through the file manager. */
export const MAX_UPLOAD = 1024 * 1024 * 1024;

// ---- Worlds, backups, pre-generation ----

export interface WorldInfo {
  /** Folder name of the overworld, also the value of level-name. */
  name: string;
  /** All folders that belong to the world (Paper keeps the Nether and End next to it). */
  folders: string[];
  sizeBytes: number;
  active: boolean;
  version?: string;
  seed?: string;
  lastPlayed?: number;
  levelName?: string;
}

export type BackupKind = 'manual' | 'auto' | 'safety';

export interface BackupInfo {
  file: string;
  kind: BackupKind;
  createdAt: number;
  size: number;
}

export interface PregenStatus {
  installed: boolean;
  state: 'idle' | 'running' | 'paused' | 'done';
  world?: string;
  pct: number;
  chunks: number;
  eta?: string;
  rate?: number;
}

export interface PregenRequest {
  dimension: 'overworld' | 'nether' | 'end';
  radius: number;
  shape: 'square' | 'circle';
  setBorder: boolean;
}

export const DEFAULT_BACKUP_KEEP = 7;

export * from './properties.ts';
export * from './motd.ts';
