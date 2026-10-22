import {
  CSRF_HEADER,
  type AddPlayerRequest,
  type AddonId,
  type AddonState,
  type AuthInfo,
  type DiscordEvent,
  type PanelRole,
  type PanelUser,
  type PlayerStat,
  type ProxyState,
  type AuthMode,
  type AuthState,
  type BackupInfo,
  type BuildInfo,
  type ContentHit,
  type ContentSource,
  type ContentTarget,
  type CreateServerRequest,
  type DatapackInfo,
  type DirListing,
  type FileContent,
  type GameVersion,
  type HistoryPoint,
  type HistoryRange,
  type InstalledContent,
  type InstallResult,
  type LogFileInfo,
  type LoginAccount,
  type LogLine,
  type MetricPoint,
  type CurseForgeState,
  type ManualDownload,
  type ModpackHit,
  type ModpackSource,
  type ModpackVersion,
  type PlayerListKind,
  type PlayersInfo,
  type PregenRequest,
  type DomainCheck,
  type DomainConfig,
  type DuckDnsState,
  type NetworkOverview,
  type PlayitState,
  type PortCheck,
  type ServerNetwork,
  type ScheduledTask,
  type ScheduleState,
  type ServerInfo,
  type ServerType,
  type SystemInfo,
  type UpdateServerRequest,
  type WorldInfo,
} from '@srvmc/shared';
import { t, type Lang } from '@srvmc/shared';

export interface PropertiesResponse {
  values: Record<string, string>;
  exists: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [CSRF_HEADER]: '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('srvmc-unauthorized'));
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? t('Error {status}', { status: res.status }), res.status);
  return data as T;
}

export const api = {
  system: () => request<SystemInfo>('GET', '/api/system'),
  versions: (type: ServerType, snapshots: boolean) => request<GameVersion[]>('GET', `/api/types/${type}/versions?snapshots=${snapshots}`),
  builds: (type: ServerType, version: string) => request<BuildInfo[]>('GET', `/api/types/${type}/builds?version=${encodeURIComponent(version)}`),
  suggestPort: (type: ServerType) => request<{ port: number }>('GET', `/api/ports/suggest?type=${type}`),
  servers: () => request<ServerInfo[]>('GET', '/api/servers'),
  create: (body: CreateServerRequest) => request<ServerInfo>('POST', '/api/servers', body),
  update: (id: string, body: UpdateServerRequest) => request<ServerInfo>('PATCH', `/api/servers/${id}`, body),
  remove: (id: string) => request<void>('DELETE', `/api/servers/${id}`),
  action: (id: string, action: 'start' | 'stop' | 'restart' | 'kill') => request<ServerInfo>('POST', `/api/servers/${id}/${action}`),
  command: (id: string, command: string) => request<void>('POST', `/api/servers/${id}/command`, { command }),
  log: (id: string) => request<LogLine[]>('GET', `/api/servers/${id}/log`),
  metrics: (id: string) => request<MetricPoint[]>('GET', `/api/servers/${id}/metrics`),

  players: (id: string) => request<PlayersInfo>('GET', `/api/servers/${id}/players`),
  addPlayer: (id: string, list: PlayerListKind, body: AddPlayerRequest) => request<PlayersInfo>('POST', `/api/servers/${id}/players/${list}`, body),
  removePlayer: (id: string, list: PlayerListKind, name: string) => request<PlayersInfo>('DELETE', `/api/servers/${id}/players/${list}/${encodeURIComponent(name)}`),
  setWhitelist: (id: string, enabled: boolean) => request<PlayersInfo>('PUT', `/api/servers/${id}/players/whitelist-enabled`, { enabled }),
  kick: (id: string, name: string, reason?: string) => request<void>('POST', `/api/servers/${id}/kick`, { name, reason }),

  properties: (id: string) => request<PropertiesResponse>('GET', `/api/servers/${id}/properties`),
  saveProperties: (id: string, values: Record<string, string>) => request<PropertiesResponse>('PUT', `/api/servers/${id}/properties`, { values }),
  iconUrl: (id: string, bust: number) => `/api/servers/${id}/icon?v=${bust}`,
  uploadIcon: (id: string, png: Blob) => rawUpload('PUT', `/api/servers/${id}/icon`, png, 'image/png'),
  deleteIcon: (id: string) => request<void>('DELETE', `/api/servers/${id}/icon`),

  logs: (id: string) => request<LogFileInfo[]>('GET', `/api/servers/${id}/logs`),
  logFile: (id: string, kind: LogFileInfo['kind'], name: string) => request<{ text: string; truncated: boolean }>('GET', `/api/servers/${id}/logs/${kind}/${encodeURIComponent(name)}`),
  deleteLog: (id: string, kind: LogFileInfo['kind'], name: string) => request<void>('DELETE', `/api/servers/${id}/logs/${kind}/${encodeURIComponent(name)}`),
  logDownloadUrl: (id: string, kind: LogFileInfo['kind'], name: string) => `/api/servers/${id}/logs/${kind}/${encodeURIComponent(name)}/download`,

  files: (id: string, path: string) => request<DirListing>('GET', `/api/servers/${id}/files?path=${encodeURIComponent(path)}`),
  fileContent: (id: string, path: string) => request<FileContent>('GET', `/api/servers/${id}/files/content?path=${encodeURIComponent(path)}`),
  saveFile: (id: string, path: string, content: string) => request<FileContent>('PUT', `/api/servers/${id}/files/content`, { path, content }),
  filesZipUrl: (id: string, paths: string[]) => `/api/servers/${id}/files/download-zip?${paths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}`,
  fileDownloadUrl: (id: string, path: string) => `/api/servers/${id}/files/download?path=${encodeURIComponent(path)}`,
  mkdir: (id: string, path: string) => request<void>('POST', `/api/servers/${id}/files/mkdir`, { path }),
  rename: (id: string, from: string, to: string) => request<void>('POST', `/api/servers/${id}/files/rename`, { from, to }),
  deleteFiles: (id: string, paths: string[]) => request<{ trash: string }>('POST', `/api/servers/${id}/files/delete`, { paths }),
  unzip: (id: string, path: string) => request<{ path: string }>('POST', `/api/servers/${id}/files/unzip`, { path }),
  upload: (id: string, dir: string, file: File, overwrite: boolean, onProgress?: (pct: number) => void) =>
    rawUpload('POST', `/api/servers/${id}/files/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`, file, 'application/octet-stream', onProgress),

  worlds: (id: string) => request<WorldInfo[]>('GET', `/api/servers/${id}/worlds`),
  activateWorld: (id: string, name: string) => request<WorldInfo[]>('POST', `/api/servers/${id}/worlds/${encodeURIComponent(name)}/activate`),
  newWorld: (id: string, body: { name: string; seed?: string; type?: string }) => request<WorldInfo[]>('POST', `/api/servers/${id}/worlds`, body),
  resetWorld: (id: string, name: string, seed?: string) => request<WorldInfo[]>('POST', `/api/servers/${id}/worlds/${encodeURIComponent(name)}/reset`, seed === undefined ? {} : { seed }),
  datapacks: (id: string) => request<DatapackInfo[]>('GET', `/api/servers/${id}/datapacks`),
  uploadDatapack: (id: string, file: File, onProgress?: (pct: number) => void) =>
    rawUpload<DatapackInfo[]>('POST', `/api/servers/${id}/datapacks/upload?name=${encodeURIComponent(file.name)}`, file, 'application/octet-stream', onProgress),
  setDatapackEnabled: (id: string, name: string, enabled: boolean) => request<DatapackInfo[]>('PUT', `/api/servers/${id}/datapacks/${encodeURIComponent(name)}/enabled`, { enabled }),
  removeDatapack: (id: string, name: string) => request<DatapackInfo[]>('DELETE', `/api/servers/${id}/datapacks/${encodeURIComponent(name)}`),
  deleteWorld: (id: string, name: string) => request<WorldInfo[]>('DELETE', `/api/servers/${id}/worlds/${encodeURIComponent(name)}`),
  worldDownloadUrl: (id: string, name: string) => `/api/servers/${id}/worlds/${encodeURIComponent(name)}/download`,
  importWorld: (id: string, file: File, name: string, activate: boolean, onProgress?: (pct: number) => void) =>
    rawUpload<{ name: string; worlds: WorldInfo[] }>(
      'POST',
      `/api/servers/${id}/worlds/import?name=${encodeURIComponent(name)}${activate ? '&activate=1' : ''}`,
      file,
      'application/octet-stream',
      onProgress,
    ),

  backups: (id: string) => request<{ backups: BackupInfo[]; nextRun: number | null }>('GET', `/api/servers/${id}/backups`),
  createBackup: (id: string) => request<{ started: boolean }>('POST', `/api/servers/${id}/backups`),
  restoreBackup: (id: string, file: string) => request<{ started: boolean }>('POST', `/api/servers/${id}/backups/${encodeURIComponent(file)}/restore`),
  deleteBackup: (id: string, file: string) => request<{ backups: BackupInfo[] }>('DELETE', `/api/servers/${id}/backups/${encodeURIComponent(file)}`),
  backupDownloadUrl: (id: string, file: string) => `/api/servers/${id}/backups/${encodeURIComponent(file)}/download`,

  pregenInstall: (id: string) => request<{ files: string[]; needsRestart: boolean }>('POST', `/api/servers/${id}/pregen/install`),
  pregenStart: (id: string, body: PregenRequest) => request<ServerInfo>('POST', `/api/servers/${id}/pregen/start`, body),
  pregenAction: (id: string, action: 'pause' | 'continue' | 'cancel') => request<ServerInfo>('POST', `/api/servers/${id}/pregen/${action}`),

  contentTargets: (id: string) => request<ContentTarget[]>('GET', `/api/servers/${id}/content/targets`),
  searchContent: (id: string, p: { source: ContentSource; folder: string; q: string; offset: number; hideClient: boolean }) =>
    request<ContentHit[]>('GET', `/api/servers/${id}/content/search?${new URLSearchParams({ source: p.source, folder: p.folder, q: p.q, offset: String(p.offset), hideClient: p.hideClient ? '1' : '0' })}`),
  installed: (id: string) => request<InstalledContent[]>('GET', `/api/servers/${id}/content`),
  contentUpdates: (id: string) => request<InstalledContent[]>('GET', `/api/servers/${id}/content/updates`),
  installContent: (id: string, body: { source: ContentSource; id: string; folder: string }) => request<InstallResult>('POST', `/api/servers/${id}/content/install`, body),
  updateContent: (id: string, only?: { folder: string; file: string }) => request<{ updated: string[] }>('POST', `/api/servers/${id}/content/update`, only ?? {}),
  setContentEnabled: (id: string, folder: string, file: string, enabled: boolean) => request<void>('PUT', `/api/servers/${id}/content/${folder}/${encodeURIComponent(file)}/enabled`, { enabled }),
  removeContent: (id: string, folder: string, file: string) => request<void>('DELETE', `/api/servers/${id}/content/${folder}/${encodeURIComponent(file)}`),
  uploadJar: (id: string, folder: string, file: File, overwrite: boolean, onProgress?: (pct: number) => void) =>
    rawUpload<{ file: string; name: string; version?: string }>(
      'POST',
      `/api/servers/${id}/content/upload?folder=${folder}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`,
      file,
      'application/octet-stream',
      onProgress,
    ),

  searchModpacks: (q: string, offset: number, source: ModpackSource) => request<ModpackHit[]>('GET', `/api/modpacks/search?${new URLSearchParams({ q, offset: String(offset), source })}`),
  curseForge: () => request<CurseForgeState>('GET', '/api/curseforge'),
  setCurseForgeKey: (key: string) => request<CurseForgeState>('PUT', '/api/curseforge', { key }),
  removeCurseForgeKey: () => request<void>('DELETE', '/api/curseforge'),
  manualDownloads: (id: string) => request<ManualDownload[]>('GET', `/api/servers/${id}/manual`),
  cancelManual: (id: string, item = 'all') => request<void>('DELETE', `/api/servers/${id}/manual/${item}`),
  modpackVersions: (project: string) => request<ModpackVersion[]>('GET', `/api/modpacks/${encodeURIComponent(project)}/versions`),

  history: (id: string, range: HistoryRange) => request<HistoryPoint[]>('GET', `/api/servers/${id}/history?range=${range}`),
  schedule: (id: string) => request<ScheduleState>('GET', `/api/servers/${id}/schedule`),
  saveSchedule: (id: string, tasks: (Omit<ScheduledTask, 'id'> & { id?: string })[]) => request<ScheduleState>('PUT', `/api/servers/${id}/schedule`, { tasks }),
  runTask: (id: string, task: string) => request<{ result: string }>('POST', `/api/servers/${id}/schedule/${encodeURIComponent(task)}/run`),

  network: () => request<NetworkOverview>('GET', '/api/network'),
  refreshNetwork: () => request<NetworkOverview>('POST', '/api/network/refresh'),
  setDuckDns: (domain: string, token: string) => request<DuckDnsState>('PUT', '/api/network/duckdns', { domain, token }),
  removeDuckDns: () => request<DuckDnsState>('DELETE', '/api/network/duckdns'),
  connectPlayit: () => request<PlayitState>('POST', '/api/network/playit'),
  disconnectPlayit: () => request<PlayitState>('DELETE', '/api/network/playit'),
  serverNetwork: (id: string) => request<ServerNetwork>('GET', `/api/servers/${id}/network`),
  setUpnp: (id: string, enabled: boolean) => request<ServerNetwork>('PUT', `/api/servers/${id}/network/upnp`, { enabled }),
  checkPort: (id: string) => request<PortCheck>('POST', `/api/servers/${id}/network/check`),
  createTunnel: (id: string) => request<ServerNetwork>('POST', `/api/servers/${id}/network/playit`),
  setDomain: (id: string, domain: DomainConfig) => request<ServerNetwork>('PUT', `/api/servers/${id}/network/domain`, domain),
  removeDomain: (id: string) => request<ServerNetwork>('DELETE', `/api/servers/${id}/network/domain`),
  checkDomain: (id: string) => request<DomainCheck>('POST', `/api/servers/${id}/network/domain/check`),

  me: () => request<AuthInfo>('GET', '/api/auth/me'),
  login: (name: string, password: string) => request<AuthInfo>('POST', '/api/auth/login', { name, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  changePassword: (current: string, next: string) => request<{ ok: true }>('POST', '/api/auth/password', { current, next }),
  users: () => request<PanelUser[]>('GET', '/api/users'),
  createUser: (body: { name: string; password: string; role: PanelRole; servers?: 'all' | string[] }) => request<PanelUser>('POST', '/api/users', body),
  updateUser: (id: string, body: { name?: string; password?: string; role?: PanelRole; servers?: 'all' | string[] }) => request<PanelUser>('PATCH', `/api/users/${id}`, body),
  deleteUser: (id: string) => request<void>('DELETE', `/api/users/${id}`),
  setLanguage: (lang: Lang) => request<{ lang: Lang }>('PUT', '/api/panel/language', { lang }),
  canRestart: () => request<{ available: boolean }>('GET', '/api/panel/restart'),
  restartApp: () => request<void>('POST', '/api/panel/restart'),
  setLan: (enabled: boolean) => request<AuthInfo & { restartNeeded: boolean }>('PUT', '/api/panel/lan', { enabled }),

  setDiscord: (id: string, body: { webhook?: string; events: DiscordEvent[] }) => request<void>('PUT', `/api/servers/${id}/discord`, body),
  removeDiscord: (id: string) => request<void>('DELETE', `/api/servers/${id}/discord`),
  testDiscord: (id: string) => request<void>('POST', `/api/servers/${id}/discord/test`),
  stats: (id: string) => request<PlayerStat[]>('GET', `/api/servers/${id}/stats`),
  addons: (id: string) => request<AddonState[]>('GET', `/api/servers/${id}/addons`),
  installAddon: (id: string, addon: AddonId, consent = false) => request<AddonState[]>('POST', `/api/servers/${id}/addons/${addon}${consent ? '?consent=1' : ''}`),
  removeAddon: (id: string, addon: AddonId) => request<AddonState[]>('DELETE', `/api/servers/${id}/addons/${addon}`),
  bluemapConsent: (id: string) => request<AddonState[]>('POST', `/api/servers/${id}/addons/bluemap/consent`),
  proxy: (id: string) => request<ProxyState>('GET', `/api/servers/${id}/proxy`),
  saveProxy: (id: string, servers: { id: string; alias?: string }[]) => request<ProxyState>('PUT', `/api/servers/${id}/proxy`, { servers }),

  auth: (id: string) => request<AuthState>('GET', `/api/servers/${id}/auth`),
  loginAccounts: (id: string) => request<LoginAccount[]>('GET', `/api/servers/${id}/login/accounts`),
  deleteLoginAccount: (id: string, name: string) => request<LoginAccount[]>('DELETE', `/api/servers/${id}/login/accounts/${encodeURIComponent(name)}`),
  setLoginAutologin: (id: string, name: string, autologin: boolean) =>
    request<LoginAccount[]>('PUT', `/api/servers/${id}/login/accounts/${encodeURIComponent(name)}/autologin`, { autologin }),
  setAuth: (id: string, mode: AuthMode) => request<AuthState>('PUT', `/api/servers/${id}/auth`, { mode }),
};

/** Sends a raw body with upload progress (fetch has no upload progress events). */
function rawUpload<T = void>(method: string, url: string, body: Blob, type: string, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader(CSRF_HEADER, '1');
    xhr.setRequestHeader('content-type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) {
        try {
          return resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T);
        } catch {
          return resolve(undefined as T);
        }
      }
      let msg = t('Error {status}', { status: xhr.status });
      try {
        msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg;
      } catch {
        // keep the status message
      }
      reject(new ApiError(msg, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError(t('The connection to the core failed.'), 0));
    xhr.send(body);
  });
}
