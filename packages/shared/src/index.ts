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
  { id: 'modpack', name: 'Modpack', tag: 'Modrinth', color: '#5BD27A', defaultPort: 25565, available: true },
  { id: 'bedrock', name: 'Bedrock', tag: 'Mobil · konzole · Win10', color: '#6AA9FF', defaultPort: 19132, available: true },
  { id: 'bedrock-preview', name: 'Bedrock Preview', tag: 'Testovací Bedrock', color: '#9CC6FF', defaultPort: 19132, available: true },
  { id: 'velocity', name: 'Velocity', tag: 'Proxy · síť serverů', color: '#4FB5A5', defaultPort: 25577, available: true },
  { id: 'hytale', name: 'Hytale', tag: 'Experimentální', color: '#F07A6A', defaultPort: 5520, available: true },
];

/** Which game a server type belongs to: decides files, commands, ports and what the panel offers. */
export type Edition = 'java' | 'bedrock' | 'hytale';

export function editionOf(type: ServerType): Edition {
  if (type === 'bedrock' || type === 'bedrock-preview') return 'bedrock';
  if (type === 'hytale') return 'hytale';
  return 'java';
}

/** The protocol of the server's main port: TCP for Java and Bedrock (NetherNet handshake), UDP for Hytale (QUIC). */
export function portProtocol(type: ServerType): 'TCP' | 'UDP' {
  return editionOf(type) === 'hytale' ? 'UDP' : 'TCP';
}

/**
 * Bedrock 26+ speaks NetherNet: a TCP handshake on the server port, gameplay over UDP ports the
 * server picks per player. srvMC pins those to port … port + BEDROCK_UDP_PORTS - 1 so they can be forwarded.
 */
export const BEDROCK_UDP_PORTS = 20;

export function bedrockUdpRange(port: number): [number, number] {
  return [port, port + BEDROCK_UDP_PORTS - 1];
}

/** Xbox gamertags: letters, digits and spaces, newer ones with a #1234 suffix. */
export const GAMERTAG_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,15}(#\d{1,4})?$/;

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
  /** "native": launchArgs[0] is a program in the server folder (Bedrock), started without Java. */
  runtime?: 'native';
  /** Hytale: the server signed in to the owner's Hytale account and keeps the credentials. */
  hytaleAuthed?: boolean;
  eulaAccepted: boolean;
  autoStart: boolean;
  installed: boolean;
  createdAt: string;
  backupSchedule?: BackupSchedule;
  /** "HH:MM" for daily and weekly backups. */
  backupTime?: string;
  /** How many automatic backups to keep. */
  backupKeep?: number;
  /** Set for servers created from a modpack. */
  modpack?: ModpackInfo;
  /** Start again after a crash (at most 3 times in 10 minutes). Default: on. */
  crashRestart?: boolean;
  /** While stopped, answer the server list ping on the port and start when a player tries to join. */
  wakeOnJoin?: boolean;
  /** Stop the server after this many minutes without players. 0 or missing = never. */
  sleepAfterMin?: number;
  /** Soft size limit of the server folder in MB. 0 or missing = no limit. */
  diskLimitMb?: number;
  schedule?: ScheduledTask[];
  /** Keep the port open on the router through UPnP. */
  upnp?: boolean;
  /** The player-facing domain the user set up for this server. */
  domain?: DomainConfig;
  /** Discord channel webhook (sealed) and the events posted there. */
  discord?: { webhook: string; events: DiscordEvent[] };
  /** UDP port Geyser listens on for Bedrock players (crossplay). */
  geyserPort?: number;
  /** Port of BlueMap's web map. */
  bluemapPort?: number;
  /** Velocity: the servers behind this proxy, in the order players are sent to them. */
  proxy?: { servers: { id: string; alias: string }[] };
  /** A backend: the Velocity server it sits behind. */
  behindProxy?: string;
}

export const DISCORD_EVENTS = ['start', 'stop', 'crash', 'join', 'leave', 'sleep'] as const;
export type DiscordEvent = (typeof DISCORD_EVENTS)[number];

export interface PlayerStat {
  name: string;
  uuid?: string;
  online: boolean;
  firstSeen?: number;
  lastSeen?: number;
  /** Time on the server counted by srvMC (from the console and old logs). */
  playMs: number;
  sessions: number;
  /** Minecraft's own statistics (Java). */
  game?: { playTicks?: number; deaths?: number; mobKills?: number; playerKills?: number; blocksMined?: number; distanceKm?: number };
}

export type AddonId = 'geyser' | 'bluemap';

export interface AddonState {
  id: AddonId;
  supported: boolean;
  /** Why it does not fit this server. */
  reason?: string;
  installed: boolean;
  port?: number;
  /** Where to open it (BlueMap's map). */
  url?: string;
  /** BlueMap needs the owner to agree to downloading Mojang's game resources. */
  needsConsent?: boolean;
  /** The add-on still has to create its config on the next start. */
  pendingStart?: boolean;
}

export interface ProxyBackend {
  id: string;
  name: string;
  type: ServerType;
  port: number;
  alias?: string;
  linked: boolean;
  supported: boolean;
  reason?: string;
  /** Linked to another proxy. */
  elsewhere?: string;
}

export interface ProxyState {
  backends: ProxyBackend[];
  /** Velocity has not written velocity.toml yet (it does on the first start). */
  pendingStart: boolean;
}

export type PanelRole = 'owner' | 'admin' | 'moderator' | 'starter';

export interface PanelUser {
  id: string;
  name: string;
  role: PanelRole;
  /** Servers the user may see; owners and admins always see all. */
  servers: 'all' | string[];
  createdAt: number;
}

export interface AuthInfo {
  user: PanelUser | null;
  /** Accounts exist: everyone except the desktop window signs in. */
  authRequired: boolean;
  /** The desktop app's own window (always the owner). */
  local: boolean;
  lan: { enabled: boolean; addresses: string[] };
}

export type DomainTarget = 'ip' | 'duckdns' | 'playit';

export interface DomainConfig {
  /** Registered domain, e.g. "mojedomena.cz". */
  zone: string;
  /** Name inside it, e.g. "survival"; empty = the domain itself. */
  sub: string;
  target: DomainTarget;
}

export interface DnsRecord {
  type: 'A' | 'CNAME' | 'SRV';
  /** Relative to the zone, as registrars ask for it ("survival", "_minecraft._tcp.survival", "@"). */
  name: string;
  value: string;
}

export interface DomainCheck {
  host: string;
  records: { record: DnsRecord; found: string | null; ok: boolean }[];
  /** Players can use the domain already. */
  ok: boolean;
  message: string;
}

export interface DuckDnsState {
  configured: boolean;
  /** Subdomain without .duckdns.org */
  domain?: string;
  lastUpdate?: number;
  lastOk?: boolean;
  error?: string;
}

export type PlayitStatus = 'off' | 'claiming' | 'starting' | 'running' | 'error';

export interface PlayitTunnel {
  id: string;
  name: string;
  /** What players type, e.g. "brave-fox.gl.joinmc.link". */
  address: string;
  localPort: number | null;
  pending: boolean;
  disabled?: string;
}

export interface PlayitState {
  status: PlayitStatus;
  /** While claiming: the page where the user approves srvMC on their playit account. */
  claimUrl?: string;
  error?: string;
  tunnels: PlayitTunnel[];
}

export interface NetworkOverview {
  lanIp: string | null;
  publicIp: string | null;
  /** The router's internet address as UPnP reports it. */
  routerIp: string | null;
  upnp: boolean;
  /** The provider shares one public address between customers: port forwarding cannot work. */
  cgnat: boolean | null;
  duckdns: DuckDnsState;
  playit: PlayitState;
}

export interface ServerNetwork {
  port: number;
  /** Main port: TCP (Java, Bedrock), UDP (Hytale). */
  protocol: 'TCP' | 'UDP';
  edition: Edition;
  /** Bedrock: the UDP ports for gameplay that also need forwarding. */
  udpRange?: [number, number];
  /** Geyser's UDP port: Bedrock players join this Java server there. */
  geyserPort?: number;
  upnp: { enabled: boolean; mapped: boolean; error?: string };
  /** playit.gg address of the tunnel to this server's port. */
  playit: PlayitTunnel | null;
  domain?: DomainConfig;
  records: DnsRecord[];
}

export interface PortCheck {
  address: string;
  open: boolean;
  checkedAt: number;
}

export type ScheduleAction = 'restart' | 'start' | 'stop' | 'backup' | 'command';

export interface ScheduledTask {
  id: string;
  action: ScheduleAction;
  /** For 'command': the console command (without a slash). */
  command?: string;
  /** 'days': at `time` on the chosen weekdays; 'interval': every `everyMin` minutes, counted from `time`. */
  repeat: 'days' | 'interval';
  /** "HH:MM" */
  time: string;
  /** Weekdays for 'days', 0 = Sunday … 6 = Saturday. */
  days: number[];
  everyMin?: number;
  /** Count down in chat (5 min, 1 min, 10 s) before a restart or stop. */
  warn: boolean;
  enabled: boolean;
  lastRun?: number;
  /** What happened the last time: "ok", or why it was skipped or failed. */
  lastResult?: string;
}

export interface ScheduleState {
  tasks: ScheduledTask[];
  /** Next run per task id (ms), null when disabled. */
  next: Record<string, number | null>;
}

/** What srvMC worked out after a crash. */
export interface CrashInfo {
  at: number;
  /** Plain-language cause when known, else the crash description or exception. */
  summary: string;
  /** Mods or plugins the crash points at. */
  suspects: string[];
  /** Crash report file in crash-reports/, when one was written. */
  report?: string;
  /** Restarting would only crash again (port taken, missing mod, wrong Java…). */
  permanent?: boolean;
}

export type HistoryRange = '1h' | '24h' | '7d' | '30d';

/** One bucket of the load history: average CPU, peak RAM and players, lowest TPS. */
export interface HistoryPoint {
  t: number;
  cpu: number;
  memMb: number;
  players: number;
  tps: number | null;
}

export interface ModpackInfo {
  source: 'modrinth';
  projectId: string;
  versionId: string;
  title: string;
  versionNumber: string;
  /** The mod loader the pack runs on; the server behaves like that type. */
  loader: ServerType;
  iconUrl?: string;
}

export type BackupSchedule = 'off' | 'hourly' | '6h' | 'daily' | 'weekly';

export interface InstallProgress {
  step: string;
  /** 0–100, or null when the length is unknown. */
  pct: number | null;
  text: string;
  /** A page the user has to open (e.g. to sign in), shown as a button. */
  link?: string;
}

export type TaskKind = 'backup' | 'restore' | 'import' | 'export' | 'content';

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
  /** The wake-on-join listener holds the port: the server is stopped but wakes when someone joins. */
  sleeping?: boolean;
  /** Size of the server folder, refreshed every few minutes. */
  diskUsageMb?: number;
  /** Latest ticks per second, when the server type can report it. */
  tps?: number;
  lastCrash?: CrashInfo;
  /** Something the user has to do now, e.g. sign the Hytale server in at a link. */
  notice?: { text: string; link?: string };
  /** A Discord webhook is saved (the URL itself never leaves the core). */
  discordSet?: boolean;
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
  players?: number;
  tps?: number;
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
  crashRestart?: boolean;
  wakeOnJoin?: boolean;
  sleepAfterMin?: number;
  diskLimitMb?: number;
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
  /** Bedrock has an allow list and operators (by XUID) but no ban lists. */
  edition: Edition;
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

// ---- Mods, plugins, modpacks ----

export type ContentKind = 'mod' | 'plugin';
export type ContentSource = 'modrinth' | 'hangar' | 'spigot';

/** Where content goes on a server type: plugins/ for Bukkit-family, mods/ for mod loaders. */
export interface ContentTarget {
  kind: ContentKind;
  folder: 'plugins' | 'mods';
  sources: ContentSource[];
}

export interface ContentHit {
  source: ContentSource;
  id: string;
  title: string;
  author: string;
  description: string;
  downloads: number;
  iconUrl?: string;
  url: string;
  /** Mods that only run in the game client; the server does not need them. */
  clientOnly?: boolean;
  /** Can srvMC download it, or only the author's website can (premium / external). */
  installable: boolean;
  installed?: boolean;
}

export interface InstalledContent {
  file: string;
  folder: 'plugins' | 'mods';
  enabled: boolean;
  size: number;
  name: string;
  version?: string;
  source?: ContentSource;
  projectId?: string;
  iconUrl?: string;
  update?: { versionId: string; versionNumber: string };
}

export interface InstallResult {
  installed: string[];
  /** Dependencies srvMC could not fetch (external sites, client-only). */
  skipped: string[];
}

export interface ModpackHit {
  id: string;
  title: string;
  author: string;
  description: string;
  downloads: number;
  iconUrl?: string;
  versions: string[];
}

export interface ModpackVersion {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
}

export type AuthMode = 'online' | 'hybrid' | 'offline';

export interface AuthState {
  mode: AuthMode;
  /** The server type supports the password + premium bypass mode. */
  hybridSupported: boolean;
}

export * from './properties.ts';
export * from './motd.ts';
