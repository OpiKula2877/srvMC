// playit.gg: a free tunnel that makes a server reachable from the internet without touching the
// router (works behind CGNAT too). srvMC claims an agent on the user's playit account through the
// web API, keeps the secret key, runs the official agent program and creates tunnels for servers.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { resolveSrv } from 'node:dns/promises';
import type { PlayitTunnel } from '@srvmc/shared';
import { downloadToCache } from './download.ts';
import { USER_AGENT } from './http.ts';
import type { Paths } from './paths.ts';
import { UserError } from './providers/types.ts';

const API = 'https://api.playit.gg';

/** The agent program srvMC runs: the last version that works as a plain process (1.x needs a Windows service). */
export const AGENT = {
  version: '0.17.1',
  url: 'https://github.com/playit-cloud/playit-agent/releases/download/v0.17.1/playit-windows-x86_64-signed.exe',
  sha256: '9b00d6ff7d37d1052e5ae097e1348e11deae8617cd7a8ba39d1777f2006316a3',
  size: 5094152,
  fileName: 'playit-windows-x86_64.exe',
};

export class PlayitApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** POSTs to the playit API. Answers come as {status: "success" | "fail" | "error", data}. */
export async function playitCall<T>(path: string, body: unknown, secret?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...(secret && { authorization: `Agent-Key ${secret}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { status?: string; data?: unknown } | null;
  if (json?.status === 'success') return json.data as T;
  const data = json?.data as { type?: string; message?: string } | string | undefined;
  const code = typeof data === 'string' ? data : (data?.message ?? data?.type ?? `HTTP ${res.status}`);
  throw new PlayitApiError(`playit.gg: ${code}`, code, res.status);
}

export function claimCode(): string {
  return randomBytes(5).toString('hex');
}

export const claimUrl = (code: string) => `https://playit.gg/claim/${code}`;

export type ClaimSetup = 'WaitingForUserVisit' | 'WaitingForUser' | 'UserAccepted' | 'UserRejected';

export function claimSetup(code: string, version: string): Promise<ClaimSetup> {
  return playitCall<ClaimSetup>('/claim/setup', { code, agent_type: 'self-managed', version: `srvMC ${version}` });
}

export async function claimExchange(code: string): Promise<string> {
  return (await playitCall<{ secret_key: string }>('/claim/exchange', { code })).secret_key;
}

interface RunData {
  agent_id: string;
  tunnels: { id: string; name: string; display_address: string; tunnel_type: string | null; agent_config: { fields: { name: string; value: string }[] }; disabled_reason: string | null }[];
  pending: { id: string; name: string; status_msg: string }[];
}

export function toTunnels(run: RunData): PlayitTunnel[] {
  return [
    ...run.tunnels.map((t) => ({
      id: t.id,
      name: t.name,
      address: t.display_address,
      localPort: Number(t.agent_config.fields.find((f) => f.name === 'local_port')?.value) || null,
      pending: false,
      ...(t.disabled_reason && { disabled: t.disabled_reason }),
    })),
    ...run.pending.map((p) => ({ id: p.id, name: p.name, address: '', localPort: null, pending: true, disabled: p.status_msg || undefined })),
  ];
}

export async function agentRunData(secret: string): Promise<{ agentId: string; tunnels: PlayitTunnel[] }> {
  const run = await playitCall<RunData>('/v1/agents/rundata', {}, secret);
  return { agentId: run.agent_id, tunnels: toTunnels(run) };
}

/** A Minecraft Java tunnel from playit to 127.0.0.1:port on this computer. */
export function tunnelRequest(agentId: string, name: string, port: number) {
  return {
    ports: { type: 'tunnel-type', details: 'minecraft-java' },
    origin: {
      type: 'agent',
      data: {
        agent_id: agentId,
        config: {
          fields: [
            { name: 'local_ip', value: '127.0.0.1' },
            { name: 'local_port', value: String(port) },
          ],
        },
      },
    },
    enabled: true,
    alloc: null,
    name: name.slice(0, 60),
    firewall_id: null,
  };
}

export async function createTunnel(secret: string, agentId: string, name: string, port: number): Promise<void> {
  await playitCall('/v1/tunnels/create', tunnelRequest(agentId, name, port), secret);
}

/** Host and port players end up on: "host:port" as shown, or the SRV record playit keeps for its names. */
export async function tunnelEndpoint(address: string): Promise<{ host: string; port: number } | null> {
  if (!address) return null;
  const m = /^(.+):(\d+)$/.exec(address);
  if (m) return { host: m[1]!, port: Number(m[2]) };
  try {
    const srv = (await resolveSrv(`_minecraft._tcp.${address}`))[0];
    if (srv) return { host: srv.name.replace(/\.$/, ''), port: srv.port };
  } catch {
    // No SRV: the plain name on the default port.
  }
  return { host: address, port: 25565 };
}

/** Runs the official agent with the secret key and keeps it running. Events: 'state'. */
export class PlayitAgent extends EventEmitter {
  status: 'off' | 'starting' | 'running' | 'error' = 'off';
  error?: string;
  readonly log: string[] = [];
  private proc?: ChildProcess;
  private wanted = false;
  private restartTimer?: NodeJS.Timeout;
  private backoff = 5000;
  private secret = '';

  constructor(private readonly paths: Paths) {
    super();
  }

  private set(status: PlayitAgent['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.emit('state');
  }

  async start(secret: string): Promise<void> {
    if (process.platform !== 'win32') throw new UserError('playit.gg zatím umím spustit jen na Windows.');
    this.secret = secret;
    this.wanted = true;
    if (this.proc) return;
    this.set('starting');
    let exe: string;
    try {
      exe = await downloadToCache(this.paths, { url: AGENT.url, fileName: AGENT.fileName, sha256: AGENT.sha256, size: AGENT.size });
    } catch (err) {
      this.set('error', `Program playit se nepodařilo stáhnout: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    }
    if (!this.wanted) return this.set('off');
    // The key goes through the environment, not the command line, so other programs cannot read it.
    const proc = spawn(exe, ['-s', 'start'], { env: { ...process.env, PLAYIT_SECRET: secret }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const onLine = (raw: string) => {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!line) return;
      this.log.push(line);
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
      if (/invalid secret|InvalidAgentKey|AgentClaimRejected/i.test(line)) this.set('error', 'playit.gg tajný klíč odmítl. Propoj účet znovu.');
      else if (this.status === 'starting' && /tunnel|connected|agent registered|running/i.test(line)) this.set('running');
    };
    readline.createInterface({ input: proc.stdout! }).on('line', onLine);
    readline.createInterface({ input: proc.stderr! }).on('line', onLine);
    proc.on('error', (err) => this.set('error', `Program playit nejde spustit: ${err.message}`));
    proc.on('exit', (code) => {
      this.proc = undefined;
      if (!this.wanted) return this.set('off');
      if (this.status !== 'error') this.set('error', `Program playit skončil (kód ${code}).`);
      this.scheduleRestart();
    });
    // The agent logs little once it runs; alive after a while counts as running.
    setTimeout(() => {
      if (this.proc === proc && this.status === 'starting') {
        this.backoff = 5000;
        this.set('running');
      }
    }, 8000).unref();
  }

  private scheduleRestart(): void {
    if (!this.wanted || /odmítl/.test(this.error ?? '')) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.start(this.secret), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
  }

  stop(): void {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = undefined;
    this.set('off');
  }
}
