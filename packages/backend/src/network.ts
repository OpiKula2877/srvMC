// Network features in one place: public address and port checks, UPnP port forwarding, DuckDNS,
// playit.gg tunnels and own domains. Settings with secrets live in network.json, sealed.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bedrockUdpRange, editionOf, portProtocol, type DomainCheck, type DomainConfig, type DuckDnsState, type NetworkOverview, type PlayitState, type PlayitTunnel, type PortCheck, type ServerConfig, type ServerNetwork } from '@srvmc/shared';
import { checkDomain, normalizeDomain, recordsFor } from './dnscheck.ts';
import { checkDuckToken, normalizeDuckDomain, updateDuckDns } from './duckdns.ts';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import { checkFromInternet, detectCgnat, lanIp, publicIp } from './netinfo.ts';
import type { Paths } from './paths.ts';
import { agentRunData, claimCode, claimExchange, claimSetup, claimUrl, createTunnel, PlayitAgent, PlayitApiError, tunnelEndpoint } from './playit.ts';
import { UserError } from './providers/types.ts';
import { seal, unseal, type SecretBox } from './secrets.ts';
import { addMapping, deleteMapping, externalIp, findGateway, type Gateway, type Mapping } from './upnp.ts';
import { WakeListener } from './wake.ts';
import { t } from '@srvmc/shared';

const MINUTE = 60_000;

/** Router rules a server needs: its port (TCP, or UDP for Hytale), Bedrock's UDP block, Geyser's UDP port. */
export function mappingsFor(cfg: Pick<ServerConfig, 'type' | 'port' | 'name' | 'geyserPort'>): Mapping[] {
  const description = `srvMC ${cfg.name}`.slice(0, 60);
  const out: Mapping[] = [{ port: cfg.port, protocol: portProtocol(cfg.type), description }];
  if (editionOf(cfg.type) === 'bedrock') {
    const [from, to] = bedrockUdpRange(cfg.port);
    for (let p = from; p <= to; p++) out.push({ port: p, protocol: 'UDP', description });
  }
  // Geyser over NetherNet: Bedrock players find the server over TCP and play over UDP.
  if (cfg.geyserPort) out.push({ port: cfg.geyserPort, protocol: 'TCP', description: `${description} Bedrock` }, { port: cfg.geyserPort, protocol: 'UDP', description: `${description} Bedrock` });
  return out;
}

interface Stored {
  duckdns?: { domain: string; token: string };
  playit?: { secret: string };
}

export class NetworkService {
  private stored: Stored = {};
  private readonly file: string;
  private gateway: { gw: Gateway | null; at: number } | null = null;
  private routerIp: string | null = null;
  private readonly upnp = new Map<string, { port: number; mappings: Mapping[]; mapped: boolean; error?: string }>();
  private duck: DuckDnsState = { configured: false };
  private readonly agent: PlayitAgent;
  private claim?: { code: string; url: string; cancelled: boolean };
  private playitError?: string;
  private tunnels: { list: PlayitTunnel[]; agentId: string | null; at: number } = { list: [], agentId: null, at: 0 };
  private readonly probes = new Map<string, WakeListener>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly manager: ServerManager,
    private readonly paths: Paths,
    private readonly version: string,
    private readonly box?: SecretBox,
  ) {
    this.file = path.join(paths.root, 'network.json');
    this.agent = new PlayitAgent(paths);
    manager.addStartGuard((inst) => this.closeProbe(inst.cfg.id));
    manager.on('configured', (id: string) => void this.syncUpnp(manager.get(id)));
    manager.on('deleted', (id: string) => void this.forgetServer(id));
  }

  // ---- storage ----

  private async load(): Promise<void> {
    try {
      this.stored = JSON.parse(await readFile(this.file, 'utf8')) as Stored;
    } catch {
      this.stored = {};
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.stored, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  private secret(): string | null {
    return unseal(this.box, this.stored.playit?.secret);
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    await this.load();
    const duck = this.stored.duckdns;
    if (duck) this.duck = { configured: true, domain: duck.domain };
    const secret = this.secret();
    if (secret) void this.agent.start(secret).catch(() => undefined);
    else if (this.stored.playit) this.playitError = t('The playit.gg key cannot be read (another installation saved it). Connect the account again.');
    // Leases run out and routers reboot: mappings and the DuckDNS address are refreshed regularly.
    this.timers.push(setInterval(() => void this.renewUpnp(), 20 * MINUTE));
    this.timers.push(setInterval(() => void this.updateDuck(), 10 * MINUTE));
    void this.updateDuck();
    void this.renewUpnp();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.claim) this.claim.cancelled = true;
    this.agent.stop();
    await Promise.all([...this.probes.keys()].map((id) => this.closeProbe(id)));
  }

  // ---- overview ----

  private async gatewayCached(force = false): Promise<Gateway | null> {
    if (!force && this.gateway && Date.now() - this.gateway.at < 10 * MINUTE) return this.gateway.gw;
    const gw = await findGateway().catch(() => null);
    this.gateway = { gw, at: Date.now() };
    this.routerIp = gw ? await externalIp(gw).catch(() => null) : null;
    return gw;
  }

  playitState(): PlayitState {
    if (this.claim && !this.claim.cancelled) return { status: 'claiming', claimUrl: this.claim.url, tunnels: [] };
    if (!this.stored.playit) return { status: 'off', tunnels: [] };
    const error = this.agent.error ?? this.playitError;
    return { status: this.agent.status === 'off' && error ? 'error' : this.agent.status, error, tunnels: this.tunnels.list };
  }

  async overview(force = false): Promise<NetworkOverview> {
    const [lan, pub, gw] = await Promise.all([lanIp(), publicIp(), this.gatewayCached(force)]);
    if (this.stored.playit) await this.refreshTunnels(force).catch(() => undefined);
    return {
      lanIp: lan,
      publicIp: pub,
      routerIp: this.routerIp,
      upnp: !!gw,
      cgnat: detectCgnat(this.routerIp, pub),
      duckdns: this.duck,
      playit: this.playitState(),
    };
  }

  // ---- per server ----

  private tunnelFor(port: number): PlayitTunnel | null {
    return this.tunnels.list.find((t) => t.localPort === port) ?? null;
  }

  async serverNetwork(id: string): Promise<ServerNetwork> {
    const inst = this.manager.get(id);
    const cfg = inst.cfg;
    if (this.stored.playit) await this.refreshTunnels().catch(() => undefined);
    const playit = this.tunnelFor(cfg.port);
    const up = this.upnp.get(id);
    return {
      port: cfg.port,
      protocol: portProtocol(cfg.type),
      edition: editionOf(cfg.type),
      ...(editionOf(cfg.type) === 'bedrock' && { udpRange: bedrockUdpRange(cfg.port) }),
      ...(cfg.geyserPort && { geyserPort: cfg.geyserPort }),
      upnp: { enabled: !!cfg.upnp, mapped: !!up?.mapped && up.port === cfg.port, ...(up?.error && { error: up.error }) },
      playit,
      domain: cfg.domain,
      records: cfg.domain ? await this.records(cfg, cfg.domain, playit) : [],
    };
  }

  private async records(cfg: ServerConfig, domain: DomainConfig, tunnel: PlayitTunnel | null) {
    const java = editionOf(cfg.type) === 'java';
    return recordsFor(domain, {
      port: cfg.port,
      publicIp: await publicIp(),
      duckdns: this.stored.duckdns?.domain,
      playit: tunnel && !tunnel.pending && java ? await tunnelEndpoint(tunnel.address) : null,
      srv: java,
    });
  }

  // ---- UPnP ----

  async setUpnp(id: string, enabled: boolean): Promise<ServerNetwork> {
    const inst = this.manager.get(id);
    if (enabled) {
      const gw = await this.gatewayCached(true);
      if (!gw) throw new UserError(t('The router does not answer UPnP. Turn on UPnP in its settings, or open the port by hand (steps below).'));
    }
    await this.manager.saveConfig(id, (cfg) => {
      cfg.upnp = enabled || undefined;
    });
    await this.syncUpnp(inst);
    const state = this.upnp.get(id);
    if (enabled && state?.error) throw new UserError(t('The router did not open the port: {error}', { error: state.error }));
    return this.serverNetwork(id);
  }

  /** Makes the router match the setting: maps the current port, drops an old one. */
  private async syncUpnp(inst: ServerInstance): Promise<void> {
    const id = inst.cfg.id;
    const current = this.upnp.get(id);
    const want = inst.cfg.upnp ? inst.cfg.port : null;
    const wanted = want === null ? [] : mappingsFor(inst.cfg);
    if (!current && want === null) return;
    const gw = await this.gatewayCached();
    if (!gw) {
      if (want !== null) this.upnp.set(id, { port: want, mappings: wanted, mapped: false, error: t('The router does not answer UPnP.') });
      return;
    }
    try {
      const same = (a: Mapping, b: Mapping) => a.port === b.port && a.protocol === b.protocol;
      if (current?.mapped) for (const m of current.mappings) if (!wanted.some((w) => same(w, m))) await deleteMapping(gw, m);
      if (want === null) {
        this.upnp.delete(id);
        inst.pushLog('system', t('Port closed on the router (UPnP).'));
        return;
      }
      for (const m of wanted) await addMapping(gw, m);
      if (!current?.mapped || current.port !== want) inst.pushLog('system', wanted.length > 1 ? t('Port {port} is open on the router (UPnP, {n} rules).', { port: want, n: wanted.length }) : t('Port {port} is open on the router (UPnP).', { port: want }));
      this.upnp.set(id, { port: want, mappings: wanted, mapped: true });
    } catch (err) {
      this.upnp.set(id, { port: want ?? current?.port ?? 0, mappings: wanted, mapped: false, error: (err as Error).message });
    }
  }

  private async renewUpnp(): Promise<void> {
    for (const inst of this.manager.all()) if (inst.cfg.upnp) await this.syncUpnp(inst);
  }

  private async forgetServer(id: string): Promise<void> {
    await this.closeProbe(id);
    const state = this.upnp.get(id);
    this.upnp.delete(id);
    const gw = state?.mapped ? await this.gatewayCached() : null;
    if (gw && state) for (const m of state.mappings) await deleteMapping(gw, m).catch(() => undefined);
  }

  // ---- port check ----

  /**
   * Asks an outside service whether players can reach ip:port. When nothing listens (server off,
   * not asleep), a short-lived stand-in answers the ping for the duration of the check.
   */
  async checkPort(id: string): Promise<PortCheck> {
    const inst = this.manager.get(id);
    const edition = editionOf(inst.cfg.type);
    if (edition !== 'java') throw new UserError(edition === 'hytale' ? t('Checking the port of a Hytale server (QUIC) from outside is not possible yet.') : t('Checking the port of the new Bedrock (NetherNet) from outside is not possible yet.'));
    const ip = await publicIp();
    if (!ip) throw new UserError(t('Could not find the public IP. Are you connected to the internet?'));
    if (inst.status === 'starting' || inst.status === 'stopping' || inst.launching) throw new UserError(t('Wait until the server has started or stopped.'));
    const address = `${ip}:${inst.cfg.port}`;
    const needProbe = !inst.running && !inst.sleeping;
    if (needProbe) {
      const probe = new WakeListener({
        port: inst.cfg.port,
        kickMessage: t('srvMC is only testing the port.'),
        status: async () => ({ motd: t('srvMC – port test'), maxPlayers: 0 }),
        onJoin: () => undefined,
      });
      try {
        await probe.open();
      } catch {
        throw new UserError(t('Another program holds port {port}, it cannot be tested.', { port: inst.cfg.port }));
      }
      this.probes.set(id, probe);
    }
    try {
      return { address, open: await checkFromInternet(address), checkedAt: Date.now() };
    } catch {
      throw new UserError(t('The port check service is not answering. Try again in a moment.'));
    } finally {
      if (needProbe) await this.closeProbe(id);
    }
  }

  private async closeProbe(id: string): Promise<void> {
    const probe = this.probes.get(id);
    if (!probe) return;
    this.probes.delete(id);
    await probe.close();
  }

  // ---- DuckDNS ----

  async setDuckDns(domain: string, token: string): Promise<DuckDnsState> {
    const name = normalizeDuckDomain(domain);
    const checked = checkDuckToken(token);
    if (!(await updateDuckDns(name, checked).catch(() => false))) throw new UserError(t('DuckDNS refused the change. Check the subdomain name and the token at duckdns.org.'));
    this.stored.duckdns = { domain: name, token: seal(this.box, checked) };
    await this.save();
    this.duck = { configured: true, domain: name, lastUpdate: Date.now(), lastOk: true };
    return this.duck;
  }

  async removeDuckDns(): Promise<DuckDnsState> {
    delete this.stored.duckdns;
    await this.save();
    this.duck = { configured: false };
    return this.duck;
  }

  private async updateDuck(): Promise<void> {
    const stored = this.stored.duckdns;
    if (!stored) return;
    const token = unseal(this.box, stored.token);
    if (!token) {
      this.duck = { configured: true, domain: stored.domain, lastOk: false, error: t('The token cannot be read. Enter it again.') };
      return;
    }
    try {
      const ok = await updateDuckDns(stored.domain, token);
      this.duck = { configured: true, domain: stored.domain, lastUpdate: Date.now(), lastOk: ok, ...(!ok && { error: t('DuckDNS refused the change (the token or name is no longer valid).') }) };
    } catch (err) {
      this.duck = { configured: true, domain: stored.domain, lastUpdate: this.duck.lastUpdate, lastOk: false, error: t('DuckDNS is not answering: {message}', { message: (err as Error).message }) };
    }
  }

  // ---- playit.gg ----

  /** Starts linking the user's playit account. The returned URL is where they approve srvMC. */
  async connectPlayit(): Promise<PlayitState> {
    if (process.platform !== 'win32') throw new UserError(t('playit.gg can only run on Windows for now.'));
    if (this.claim && !this.claim.cancelled) return this.playitState();
    const code = claimCode();
    const claim = { code, url: claimUrl(code), cancelled: false };
    this.claim = claim;
    this.playitError = undefined;
    await claimSetup(code, this.version);
    void this.waitForClaim(claim);
    return this.playitState();
  }

  private async waitForClaim(claim: { code: string; cancelled: boolean }): Promise<void> {
    const until = Date.now() + 15 * MINUTE;
    try {
      while (!claim.cancelled && Date.now() < until) {
        const state = await claimSetup(claim.code, this.version).catch(() => 'WaitingForUser' as const);
        if (state === 'UserRejected') throw new UserError(t('The connection was rejected on playit.gg.'));
        if (state === 'UserAccepted') {
          const secret = await claimExchange(claim.code);
          this.stored.playit = { secret: seal(this.box, secret) };
          await this.save();
          this.claim = undefined;
          void this.agent.start(secret).catch(() => undefined);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!claim.cancelled) this.playitError = t('The connection timed out. Try again.');
    } catch (err) {
      this.playitError = (err as Error).message;
    } finally {
      if (this.claim === claim) this.claim = undefined;
    }
  }

  async disconnectPlayit(): Promise<PlayitState> {
    if (this.claim) this.claim.cancelled = true;
    this.claim = undefined;
    this.agent.stop();
    delete this.stored.playit;
    this.playitError = undefined;
    this.tunnels = { list: [], agentId: null, at: 0 };
    await this.save();
    return this.playitState();
  }

  private async refreshTunnels(force = false): Promise<void> {
    const secret = this.secret();
    if (!secret || (!force && Date.now() - this.tunnels.at < 30_000)) return;
    try {
      const run = await agentRunData(secret);
      this.tunnels = { list: run.tunnels, agentId: run.agentId, at: Date.now() };
    } catch (err) {
      this.tunnels.at = Date.now();
      if (err instanceof PlayitApiError && err.status === 401) this.playitError = t('The playit.gg key is no longer valid. Connect the account again.');
    }
  }

  async createPlayitTunnel(id: string): Promise<ServerNetwork> {
    const inst = this.manager.get(id);
    const edition = editionOf(inst.cfg.type);
    if (edition === 'hytale') throw new UserError(t('For Hytale, create a UDP tunnel to port {port} on playit.gg by hand.', { port: inst.cfg.port }));
    if (edition === 'bedrock') throw new UserError(t('playit.gg does not support the new Bedrock (NetherNet) yet.'));
    const secret = this.secret();
    if (!secret) throw new UserError(t('Connect a playit.gg account first.'));
    await this.refreshTunnels(true);
    if (!this.tunnels.agentId) throw new UserError(t('playit.gg is not answering. Try again in a moment.'));
    if (!this.tunnelFor(inst.cfg.port)) {
      try {
        await createTunnel(secret, this.tunnels.agentId, `srvMC ${inst.cfg.name}`, inst.cfg.port);
      } catch (err) {
        throw new UserError(t('Could not create the tunnel: {message}. You can also add it on playit.gg (Minecraft Java, port {port}).', { message: (err as Error).message, port: inst.cfg.port }));
      }
      inst.pushLog('system', t('playit.gg tunnel created. The address shows up in a moment.'));
    }
    await this.refreshTunnels(true);
    return this.serverNetwork(id);
  }

  // ---- own domain ----

  async setDomain(id: string, domain: DomainConfig | null): Promise<ServerNetwork> {
    const clean = domain ? normalizeDomain(domain) : undefined;
    if (clean?.target === 'duckdns' && !this.stored.duckdns) throw new UserError(t('Set up DuckDNS first.'));
    await this.manager.saveConfig(id, (cfg) => {
      cfg.domain = clean;
    });
    return this.serverNetwork(id);
  }

  async checkDomain(id: string): Promise<DomainCheck> {
    const net = await this.serverNetwork(id);
    if (!net.domain) throw new UserError(t('Enter a domain first.'));
    return checkDomain(net.domain, net.records);
  }
}
