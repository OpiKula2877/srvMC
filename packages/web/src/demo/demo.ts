// Demo mode (vite build --mode demo): the panel runs on made-up data, for screenshots of the README.
// The API and the live connection are answered right here; nothing reaches a real core.
import type {
  AddonState,
  AuthInfo,
  ContentHit,
  ContentTarget,
  GameVersion,
  HistoryPoint,
  InstalledContent,
  LogLine,
  MetricPoint,
  PanelUser,
  PlayerStat,
  PlayersInfo,
  ServerInfo,
  ServerType,
  SystemInfo,
} from '@srvmc/shared';
import okIcon from './ok-icon.png?url';
import modrinth from './modrinth.json';

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The same "random" numbers on every run, so screenshots can be made again. */
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function server(over: Partial<ServerInfo> & Pick<ServerInfo, 'id' | 'name' | 'type' | 'version' | 'port' | 'status'>): ServerInfo {
  return {
    ramMinMb: 1024,
    ramMaxMb: 4096,
    jvmFlags: 'aikar',
    extraJvmArgs: '',
    eulaAccepted: true,
    autoStart: false,
    installed: true,
    createdAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    players: [],
    dir: `C:\\Users\\OpiKula\\srvMC\\servers\\${over.id}`,
    javaMajor: 25,
    crashRestart: true,
    ...over,
  };
}

const ONLINE = ['OpiKula', 'Monndy', 'Lynx_CZ', 'Kubik42', 'Nela_MC'];

const SERVERS: ServerInfo[] = [
  server({ id: 'survival', name: 'OK Survival', type: 'paper', version: '26.3', build: '211', port: 25565, status: 'running', ramMaxMb: 6144, startedAt: now - 7 * HOUR - 12 * MIN, players: ONLINE, autoStart: true, diskUsageMb: 3480, discordSet: true, createdAt: new Date(now - 60 * 24 * HOUR).toISOString() }),
  server({
    id: 'create',
    name: 'Create Workshop',
    type: 'modpack',
    version: '1.21.1',
    port: 25566,
    status: 'running',
    ramMaxMb: 8192,
    startedAt: now - 2 * HOUR - 40 * MIN,
    players: ['Monndy', 'TomasB'],
    javaMajor: 21,
    modpack: { source: 'curseforge', projectId: 'cf:925200', versionId: '6421022', title: 'Create Workshop', versionNumber: '2.4.1', loader: 'neoforge' },
    createdAt: new Date(now - 50 * 24 * HOUR).toISOString(),
  }),
  server({ id: 'bedrock', name: 'Bedrock Friends', type: 'bedrock', version: '1.26.52.3', port: 19132, status: 'running', runtime: 'native', ramMaxMb: 2048, startedAt: now - 5 * HOUR, players: ['xX Steve Xx'], createdAt: new Date(now - 40 * 24 * HOUR).toISOString() }),
  server({ id: 'creative', name: 'Creative Build', type: 'fabric', version: '26.3', port: 25567, status: 'stopped', sleeping: true, wakeOnJoin: true, sleepAfterMin: 15, createdAt: new Date(now - 30 * 24 * HOUR).toISOString() }),
  server({ id: 'lobby', name: 'Network Lobby', type: 'velocity', version: '4.3.0', build: '44', port: 25577, status: 'stopped', ramMaxMb: 1024, createdAt: new Date(now - 20 * 24 * HOUR).toISOString() }),
  server({ id: 'hytale', name: 'Hytale Test', type: 'hytale', version: '2026.1', port: 5520, status: 'stopped', createdAt: new Date(now - 10 * 24 * HOUR).toISOString() }),
];

/** Players over the last hours: a quiet morning, a busy afternoon, a few left now. */
function playersAt(t: number): number {
  const h = (now - t) / HOUR;
  if (h > 7) return 0;
  const curve = Math.sin(((7 - h) / 7) * Math.PI) * 9 + 1.5;
  return Math.max(0, Math.round(curve + (rand() - 0.5) * 2));
}

function historyFor(range: string): HistoryPoint[] {
  const step = range === '1h' ? MIN : range === '24h' ? 5 * MIN : range === '7d' ? 30 * MIN : 2 * HOUR;
  const span = range === '1h' ? HOUR : range === '24h' ? 24 * HOUR : range === '7d' ? 7 * 24 * HOUR : 30 * 24 * HOUR;
  const out: HistoryPoint[] = [];
  const started = now - 7 * HOUR - 12 * MIN;
  for (let t = now - span; t <= now; t += step) {
    if (t < started) continue;
    const players = playersAt(t);
    const age = (t - started) / HOUR;
    out.push({
      t,
      cpu: Math.min(95, 6 + players * 4.2 + rand() * 6 + (age < 0.1 ? 40 : 0)),
      memMb: Math.round(1900 + Math.min(age, 3) * 520 + players * 95 + rand() * 180),
      players,
      tps: Math.min(20, players > 8 ? 18.6 + rand() * 1.4 : 19.6 + rand() * 0.4),
    });
  }
  return out;
}

function metricsFor(s: ServerInfo): MetricPoint[] {
  if (s.status !== 'running') return [];
  const base = s.id === 'create' ? 5200 : s.id === 'bedrock' ? 700 : 3900;
  return Array.from({ length: 80 }, (_, i) => {
    const t = now - (80 - i) * 5000;
    return { t, cpu: 8 + rand() * 18 + (i % 17 === 0 ? 14 : 0), memMb: Math.round(base + Math.sin(i / 9) * 160 + rand() * 90), players: s.players.length, tps: 19.7 + rand() * 0.3 };
  });
}

function logFor(s: ServerInfo): LogLine[] {
  const start = s.startedAt ?? now - HOUR;
  const at = (min: number) => start + min * MIN;
  const info = (t: number, text: string): LogLine => ({ t, level: 'info', text });
  const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);
  const lines: LogLine[] = [
    { t: at(0), level: 'system', text: 'Starting paper-26.3-211.jar · Java 25 · 6144 MB RAM' },
    info(at(0.1), `[${clock(at(0.1))} INFO]: Starting minecraft server version 26.3`),
    info(at(0.2), `[${clock(at(0.2))} INFO]: Loading properties`),
    info(at(0.3), `[${clock(at(0.3))} INFO]: This server is running Paper version 26.3-211 (MC: 26.3)`),
    info(at(0.4), `[${clock(at(0.4))} INFO]: [LuckPerms] Loading server plugin LuckPerms v5.5.17`),
    info(at(0.4), `[${clock(at(0.4))} INFO]: [EssentialsX] Loading server plugin Essentials v2.21.2`),
    info(at(0.5), `[${clock(at(0.5))} INFO]: [WorldEdit] Loading server plugin WorldEdit v7.3.15`),
    info(at(0.6), `[${clock(at(0.6))} INFO]: Preparing level "world"`),
    info(at(0.9), `[${clock(at(0.9))} INFO]: Done (18.402s)! For help, type "help"`),
    { t: at(0.9), level: 'system', text: 'The server is ready. Players can join.' },
  ];
  const events: [number, string][] = [
    [12, 'OpiKula joined the game'],
    [14, '<OpiKula> evening everyone, the nether hub is done'],
    [31, 'Monndy joined the game'],
    [33, '<Monndy> nice! heading there now'],
    [70, 'Lynx_CZ joined the game'],
    [96, 'Kubik42 joined the game'],
    [140, 'Nela_MC joined the game'],
    [142, '<Nela_MC> who wants to raid the ocean monument?'],
    [143, '<Kubik42> me!'],
    [300, 'Lynx_CZ has made the advancement [Monster Hunter]'],
    [380, '<OpiKula> backup at 4 am, server keeps running'],
    [425, 'Monndy has made the advancement [Hot Tourist Destinations]'],
  ];
  for (const [m, text] of events) lines.push(info(at(m), `[${clock(at(m))} INFO]: ${text}`));
  lines.push({ t: at(428), level: 'cmd', text: '> say Server restart on Sunday at 6:00' });
  lines.push(info(at(428), `[${clock(at(428))} INFO]: [Server] Server restart on Sunday at 6:00`));
  lines.push({ t: at(429), level: 'warn', text: `[${clock(at(429))} WARN]: Can't keep up! Is the server overloaded? Running 2104ms or 42 ticks behind` });
  return lines.filter((l) => l.t <= now);
}

const uuid = (n: number) => `${(0x6a1f3c00 + n).toString(16)}-4b1d-4c2e-9f3a-${(0x1a2b3c4d5e6f + n * 7919).toString(16).padStart(12, '0')}`;

const PLAYERS: PlayersInfo = {
  whitelist: ['OpiKula', 'Monndy', 'Lynx_CZ', 'Kubik42', 'Nela_MC', 'TomasB', 'Eliska_W', 'Dominik_P'].map((name, i) => ({ name, uuid: uuid(i) })),
  ops: [
    { name: 'OpiKula', uuid: uuid(0), level: 4 },
    { name: 'Monndy', uuid: uuid(1), level: 3 },
  ],
  bans: [{ name: 'Griefer_99', uuid: uuid(20), reason: 'Burned down the village' }],
  ips: [],
  whitelistEnabled: true,
  onlineMode: true,
  online: ONLINE,
  edition: 'java',
};

const STATS: PlayerStat[] = [
  ['OpiKula', 212, 64, 41, 1847, 92316, 412.7],
  ['Monndy', 187, 51, 27, 2213, 61089, 368.3],
  ['Lynx_CZ', 96, 30, 19, 984, 40572, 201.9],
  ['Kubik42', 74, 22, 33, 1436, 28853, 155.4],
  ['Nela_MC', 58, 18, 8, 617, 19641, 122.1],
  ['TomasB', 31, 11, 6, 243, 9128, 64.6],
  ['Eliska_W', 12, 5, 2, 79, 3157, 21.2],
].map(([name, hours, sessions, deaths, mobKills, blocksMined, km], i) => ({
  name: name as string,
  uuid: uuid(i),
  online: ONLINE.includes(name as string),
  firstSeen: now - (40 - i) * 24 * HOUR,
  lastSeen: ONLINE.includes(name as string) ? now : now - (i + 1) * 26 * HOUR,
  playMs: (hours as number) * HOUR,
  sessions: sessions as number,
  game: { deaths: deaths as number, mobKills: mobKills as number, blocksMined: blocksMined as number, distanceKm: km as number },
}));

const proj = new Map(modrinth.proj.map((p) => [p.slug, p]));
const plugin = (slug: string, file: string, version: string, update?: string): InstalledContent => {
  const p = proj.get(slug)!;
  return { file, folder: 'plugins', enabled: true, size: 400_000 + Math.round(rand() * 6_000_000), name: p.title, version, source: 'modrinth', projectId: p.id, iconUrl: p.iconUrl ?? undefined, ...(update && { update: { versionId: 'x', versionNumber: update } }) };
};
const INSTALLED: InstalledContent[] = [
  plugin('essentialsx', 'EssentialsX-2.21.2.jar', '2.21.2'),
  plugin('luckperms', 'LuckPerms-Bukkit-5.5.17.jar', '5.5.17', '5.5.20'),
  plugin('worldedit', 'worldedit-bukkit-7.3.15.jar', '7.3.15'),
  plugin('coreprotect', 'CoreProtect-23.1.jar', '23.1'),
  plugin('chunky', 'Chunky-Bukkit-1.4.40.jar', '1.4.40'),
  plugin('simple-voice-chat', 'voicechat-bukkit-2.6.4.jar', '2.6.4', '2.6.6'),
  plugin('tab-was-taken', 'TAB-5.2.4.jar', '5.2.4'),
  plugin('squaremap', 'squaremap-paper-1.3.6.jar', '1.3.6'),
];
const HITS: ContentHit[] = modrinth.hits.slice(0, 8).map((h) => ({
  source: 'modrinth',
  id: h.id,
  title: h.title,
  author: h.author,
  description: h.description,
  downloads: h.downloads,
  iconUrl: h.iconUrl ?? undefined,
  url: `https://modrinth.com/plugin/${h.slug}`,
  installable: true,
  installed: h.slug === 'chunky',
}));

const ME: PanelUser = { id: 'u-opikula', name: 'OpiKula', role: 'owner', servers: 'all', createdAt: now - 30 * 24 * HOUR };
const USERS: PanelUser[] = [
  ME,
  { id: 'u-monndy', name: 'Monndy', role: 'admin', servers: 'all', createdAt: now - 28 * 24 * HOUR },
  { id: 'u-kubik', name: 'Kubik42', role: 'moderator', servers: ['survival', 'create'], createdAt: now - 20 * 24 * HOUR },
  { id: 'u-nela', name: 'Nela_MC', role: 'starter', servers: ['survival'], createdAt: now - 9 * 24 * HOUR },
];
const AUTH: AuthInfo = { user: ME, authRequired: true, local: false, lan: { enabled: true, addresses: ['http://192.168.1.20:8420'] } };
const SYSTEM: SystemInfo = { platform: 'win32', cpus: 16, totalMemMb: 32768, freeMemMb: 13900, diskFreeMb: 412_000, dataDir: 'C:\\Users\\OpiKula\\srvMC', javaRuntimes: [17, 21, 25], version: '1.1.0' };
const TARGETS: ContentTarget[] = [{ kind: 'plugin', folder: 'plugins', sources: ['modrinth', 'hangar', 'spigot', 'curseforge'] }];
const ADDONS: AddonState[] = [
  { id: 'geyser', supported: true, installed: true, port: 19133 },
  { id: 'bluemap', supported: true, installed: false },
];
const VERSIONS: GameVersion[] = ['26.3', '26.2', '26.1.2', '26.1', '1.21.11', '1.21.10', '1.21.8', '1.21.4', '1.20.6', '1.20.1'].map((id) => ({ id, type: 'release' }));

const PROPS: Record<string, string> = {
  motd: '§6§lSeason 4 is live! §8• §a26.3 §8• §fsurvival\n§7Events every Friday §8• §bok.gg/discord',
  'max-players': '30',
  gamemode: 'survival',
  difficulty: 'hard',
  pvp: 'true',
  'white-list': 'true',
  'online-mode': 'true',
  'view-distance': '12',
  'simulation-distance': '10',
  'spawn-protection': '0',
  'level-name': 'world',
  'level-seed': '8723401245',
  'allow-flight': 'true',
  'server-port': '25565',
};

const typeVersions = (type: ServerType) => (type === 'velocity' ? [{ id: '4.3.0', type: 'release' as const }] : VERSIONS);

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : status, headers: { 'content-type': 'application/json' } });
}

async function answer(method: string, url: URL): Promise<Response> {
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  if (p === '/api/auth/language') return json({ lang: new URLSearchParams(location.search).get('lang') ?? 'en' });
  if (p === '/api/auth/me') return json(AUTH);
  if (p === '/api/system') return json(SYSTEM);
  if (p === '/api/servers' && method === 'GET') return json(SERVERS);
  if (p === '/api/users') return json(USERS);
  if (p === '/api/panel/restart') return json({ available: true });
  if (p === '/api/curseforge') return json({ keySet: true });
  if ((m = p.match(/^\/api\/types\/([\w-]+)\/versions$/))) return json(typeVersions(m[1] as ServerType));
  if ((m = p.match(/^\/api\/types\/([\w-]+)\/builds$/))) return json([{ id: '211', label: 'Build 211 (latest)', channel: 'stable' }]);
  if (p === '/api/ports/suggest') return json({ port: 25568 });
  if ((m = p.match(/^\/api\/servers\/([\w-]+)(?:\/(.*))?$/))) {
    const s = SERVERS.find((x) => x.id === m![1]);
    if (!s) return json({ error: 'Not found' }, 404);
    switch (m[2] ?? '') {
      case '':
        return json(s);
      case 'log':
        return json(s.status === 'running' ? logFor(s) : []);
      case 'metrics':
        return json(metricsFor(s));
      case 'history':
        return json(s.id === 'survival' ? historyFor(url.searchParams.get('range') ?? '24h') : []);
      case 'players':
        return json(PLAYERS);
      case 'stats':
        return json(STATS);
      case 'properties':
        return json({ values: PROPS, exists: true });
      case 'icon':
        return fetch(okIcon);
      case 'content/targets':
        return json(TARGETS);
      case 'content':
      case 'content/updates':
        return json(INSTALLED);
      case 'content/search':
        return json(HITS);
      case 'addons':
        return json(ADDONS);
      case 'manual':
        return json([]);
      case 'auth':
        return json({ mode: 'online', hybridSupported: true });
      default:
        return json([]);
    }
  }
  return json({});
}

// The panel talks to the core with fetch and one WebSocket; both are answered here.
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return answer((init?.method ?? 'GET').toUpperCase(), url);
  return realFetch(input, init);
};

class DemoSocket extends EventTarget {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    super();
    setTimeout(() => {
      this.onopen?.();
      // The live feed: recent load of the running servers, for the cards on the overview.
      setTimeout(() => {
        for (const s of SERVERS) for (const point of metricsFor(s)) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'metrics', id: s.id, point }) }));
      }, 50);
    }, 10);
  }
  send(): void {}
  close(): void {}
}
window.WebSocket = DemoSocket as unknown as typeof WebSocket;
