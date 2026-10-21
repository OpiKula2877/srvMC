import { useSyncExternalStore } from 'react';
import type { LogLine, MetricPoint, ServerInfo, WsEvent } from '@srvmc/shared';
import { api } from './api.ts';

const LOG_LIMIT = 2000;
const METRIC_LIMIT = 300;

export interface LiveState {
  connected: boolean;
  loaded: boolean;
  servers: Record<string, ServerInfo>;
  logs: Record<string, LogLine[]>;
  metrics: Record<string, MetricPoint[]>;
}

let state: LiveState = { connected: false, loaded: false, servers: {}, logs: {}, metrics: {} };
const listeners = new Set<() => void>();
const loadedHistory = new Set<string>();

function set(patch: Partial<LiveState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function apply(ev: WsEvent): void {
  if (ev.type === 'server') set({ servers: { ...state.servers, [ev.server.id]: ev.server } });
  else if (ev.type === 'deleted') {
    const { [ev.id]: _gone, ...rest } = state.servers;
    set({ servers: rest });
  } else if (ev.type === 'log') {
    const lines = [...(state.logs[ev.id] ?? []), ...ev.lines].slice(-LOG_LIMIT);
    set({ logs: { ...state.logs, [ev.id]: lines } });
  } else if (ev.type === 'metrics') {
    const points = [...(state.metrics[ev.id] ?? []), ev.point].slice(-METRIC_LIMIT);
    set({ metrics: { ...state.metrics, [ev.id]: points } });
  }
}

async function refresh(): Promise<void> {
  const list = await api.servers();
  set({ loaded: true, servers: Object.fromEntries(list.map((s) => [s.id, s])) });
}

/** Loads log and metric history for a server once; live events extend it afterwards. */
export async function loadHistory(id: string): Promise<void> {
  if (loadedHistory.has(id)) return;
  loadedHistory.add(id);
  const [log, metrics] = await Promise.all([api.log(id), api.metrics(id)]);
  const seen = new Set((state.logs[id] ?? []).map((l) => `${l.t}|${l.text}`));
  const merged = [...log.filter((l) => !seen.has(`${l.t}|${l.text}`)), ...(state.logs[id] ?? [])].sort((a, b) => a.t - b.t);
  const lastT = metrics.at(-1)?.t ?? 0;
  set({
    logs: { ...state.logs, [id]: merged.slice(-LOG_LIMIT) },
    metrics: { ...state.metrics, [id]: [...metrics, ...(state.metrics[id] ?? []).filter((p) => p.t > lastT)].slice(-METRIC_LIMIT) },
  });
}

let socket: WebSocket | undefined;
let retry = 500;

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    retry = 500;
    loadedHistory.clear();
    set({ connected: true });
    void refresh();
  };
  ws.onmessage = (msg) => apply(JSON.parse(msg.data as string) as WsEvent);
  ws.onclose = () => {
    set({ connected: false });
    socket = undefined;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

export function startLive(): void {
  if (!socket) connect();
}

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

export function upsertServer(server: ServerInfo): void {
  set({ servers: { ...state.servers, [server.id]: server } });
}
