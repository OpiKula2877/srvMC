export const USER_AGENT = 'srvMC/0.1.0 (self-hosted Minecraft server manager)';

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export async function fetchOk(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { ...rest, signal, headers: { 'User-Agent': USER_AGENT, ...rest.headers } });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

export async function fetchJson<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetchOk(url, init);
  return (await res.json()) as T;
}

const memo = new Map<string, { until: number; value: Promise<unknown> }>();

/** Memoizes an async lookup for `ttlMs`. Failed lookups are not kept. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { until: Date.now() + ttlMs, value });
  value.catch(() => memo.delete(key));
  return value;
}
