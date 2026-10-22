// srvMC Login's proxy: players connect to the server's public port, the proxy passes every byte to
// the Minecraft server on an internal port and only looks at a few packets – the handshake, login
// start, compression, state changes, and chat/commands, so /register, /login, /changepassword and
// /autologin never reach the server. Paid accounts with autologin get Mojang's online-mode check here.
import { createHash, generateKeyPairSync, privateDecrypt, randomBytes, constants as cryptoConsts, type KeyObject } from 'node:crypto';
import net from 'node:net';
import { USER_AGENT } from '../http.ts';
import { cfb8, type StreamCipher } from './cfb8.ts';
import { byteArray, cheapId, frame, FrameReader, mcHexDigest, openFrame, packetIds, readString, readVarInt, str, type PacketIds } from './protocol.ts';

/** Protocol numbers where the packets srvMC reads changed shape. */
const P_1_19 = 759;
const P_1_19_3 = 761;
const P_1_20_2 = 764;
const P_1_20_5 = 766;

export type JoinDecision = { kind: 'pass' } | { kind: 'online' } | { kind: 'kick'; reason: string };

export interface ProxyHooks {
  /** Decides at login start: plain pass-through, Mojang check first (autologin), or refuse. */
  decide(name: string, address: string): Promise<JoinDecision>;
  /** A player reached play state (offline or verified). `verified`: Mojang confirmed the paid account. */
  joined(session: Session): void;
  /** A chat command or line from a player still in play. Return true to swallow it. */
  chat(session: Session, text: string, isCommand: boolean): boolean;
  closed(session: Session): void;
  warn(message: string): void;
}

export interface Session {
  name: string;
  address: string;
  protocol: number;
  verified: boolean;
  /** Set by the login service; until then chat and commands stay out. */
  loggedIn: boolean;
  close(): void;
}

type State = 'handshake' | 'status' | 'login' | 'config' | 'play';

let rsa: { publicDer: Buffer; privateKey: KeyObject } | undefined;
function serverKey() {
  if (!rsa) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    rsa = { publicDer: publicKey.export({ type: 'spki', format: 'der' }), privateKey };
  }
  return rsa;
}

/** Mojang's session server: did this player join with this server hash? */
async function hasJoined(name: string, serverHash: string, ip: string): Promise<boolean> {
  const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverHash)}${ip ? `&ip=${encodeURIComponent(ip)}` : ''}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { name?: string };
    return body.name?.toLowerCase() === name.toLowerCase();
  } catch {
    return false;
  }
}

class Connection implements Session {
  name = '';
  protocol = 0;
  verified = false;
  loggedIn = false;
  private state: State = 'handshake';
  private compressed = false;
  private ids!: PacketIds;
  readonly address: string;
  private joinedOnce = false;
  private readonly fromClient = new FrameReader();
  private readonly fromServer = new FrameReader();
  private backend?: net.Socket;
  private encrypt?: StreamCipher;
  private decrypt?: StreamCipher;
  /** Frames from the client kept while srvMC waits (Mojang check, backend connect). */
  private held: Buffer[] = [];
  private handshake?: Buffer;
  private waiting = false;
  private ended = false;
  private verifyToken?: Buffer;

  constructor(
    private readonly client: net.Socket,
    private readonly backendPort: number,
    private readonly hooks: ProxyHooks,
  ) {
    this.address = client.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    client.setNoDelay(true);
    client.on('data', (d) => this.onClientData(d));
    client.on('error', () => this.close());
    client.on('close', () => this.close());
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.client.destroy();
    this.backend?.destroy();
    if (this.state === 'play' || this.state === 'config') this.hooks.closed(this);
  }

  private toClient(data: Buffer): void {
    if (this.ended) return;
    this.client.write(this.encrypt ? this.encrypt.update(data) : data);
  }

  private onClientData(chunk: Buffer): void {
    try {
      const plain = this.decrypt ? this.decrypt.update(chunk) : chunk;
      if (this.state === 'status') return this.toServer(plain);
      for (const f of this.fromClient.push(plain)) this.clientFrame(f.raw, f.body);
      // A status ping is passed on as it is, once the handshake was read.
      if ((this.state as State) === 'status') this.toServer(this.fromClient.rest());
    } catch {
      this.close();
    }
  }

  private toServer(raw: Buffer): void {
    if (!raw.length) return;
    if (this.waiting || !this.backend) this.held.push(raw);
    else this.backend.write(raw);
  }

  private clientFrame(raw: Buffer, body: Buffer): void {
    switch (this.state) {
      case 'handshake': {
        const { id, data } = openFrame(body, false);
        if (id !== 0) return this.close();
        const proto = readVarInt(data, 0)!;
        const host = readString(data, proto.next);
        const next = readVarInt(data, host.next + 2)!;
        this.protocol = proto.value;
        const p = packetIds(proto.value);
        this.ids = p.ids;
        if (!p.exact && next.value !== 1) this.hooks.warn(`srvMC Login does not know protocol ${proto.value} yet; it uses the newest known packet ids.`);
        this.handshake = raw;
        if (next.value === 1) {
          this.state = 'status';
          this.connectBackend([raw]);
        } else this.state = 'login';
        return;
      }
      case 'login': {
        const { id, data } = openFrame(body, this.compressed);
        if (id === 0 && !this.name) return void this.loginStart(raw, data);
        if (id === 1 && this.verifyToken) return void this.encryptionResponse(data);
        // 1.20.2+: the client confirms the login and moves on to configuration.
        if (id === 3 && this.protocol >= P_1_20_2) this.state = 'config';
        return this.toServer(raw);
      }
      case 'config': {
        const id = cheapId(body, this.compressed) ?? openFrame(body, this.compressed).id;
        if (id === this.ids.finishConfig) this.enterPlay();
        return this.toServer(raw);
      }
      case 'play': {
        const id = this.loggedIn ? cheapId(body, this.compressed) : openFrame(body, this.compressed).id;
        if (id === null) return this.toServer(raw);
        if (id === this.ids.configAck && this.ids.configAck >= 0) {
          this.state = 'config';
          return this.toServer(raw);
        }
        const isCmd = id === this.ids.command || id === this.ids.signedCommand;
        if (isCmd || id === this.ids.chat) {
          const { data } = openFrame(body, this.compressed);
          let text = readString(data, 0).value;
          let command = isCmd;
          // Before 1.19 commands came as chat lines starting with "/".
          if (!isCmd && this.protocol < P_1_19 && text.startsWith('/')) {
            text = text.slice(1);
            command = true;
          }
          if (this.hooks.chat(this, text, command)) return;
        }
        return this.toServer(raw);
      }
      default:
        return this.toServer(raw);
    }
  }

  private enterPlay(): void {
    const first = this.state !== 'play' && !this.joinedOnce;
    this.state = 'play';
    if (first) {
      this.joinedOnce = true;
      this.hooks.joined(this);
    }
  }

  private async loginStart(raw: Buffer, data: Buffer): Promise<void> {
    this.name = readString(data, 0).value;
    if (!/^[A-Za-z0-9_.]{1,16}$/.test(this.name)) return this.disconnect('Invalid name.');
    this.waiting = true;
    const decision = await this.hooks.decide(this.name, this.address).catch((): JoinDecision => ({ kind: 'kick', reason: 'The login check failed. Try again.' }));
    if (this.ended) return;
    if (decision.kind === 'kick') return this.disconnect(decision.reason);
    if (decision.kind === 'online') {
      this.held = [raw, ...this.held];
      this.verifyToken = randomBytes(4);
      const key = serverKey();
      const body = Buffer.concat([str(''), byteArray(key.publicDer), byteArray(this.verifyToken), ...(this.protocol >= P_1_20_5 ? [Buffer.from([1])] : [])]);
      this.toClient(frame(1, body, false));
      return;
    }
    this.held = [raw, ...this.held];
    this.connectBackend([this.handshake!]);
  }

  private async encryptionResponse(data: Buffer): Promise<void> {
    const key = serverKey();
    let pos = 0;
    const secretLen = readVarInt(data, pos)!;
    const secretEnc = data.subarray(secretLen.next, secretLen.next + secretLen.value);
    pos = secretLen.next + secretLen.value;
    let token: Buffer | null = null;
    // 1.19–1.19.2 could send a signature instead of the token; srvMC asks for the token only.
    if (this.protocol >= P_1_19 && this.protocol < P_1_19_3) {
      if (data[pos] !== 1) return this.disconnect('Unsupported login.');
      pos++;
    }
    const tokLen = readVarInt(data, pos)!;
    token = data.subarray(tokLen.next, tokLen.next + tokLen.value);
    const pad = { key: key.privateKey, padding: cryptoConsts.RSA_PKCS1_PADDING };
    let secret: Buffer;
    try {
      secret = privateDecrypt(pad, secretEnc);
      if (!privateDecrypt(pad, token).equals(this.verifyToken!)) return this.disconnect('Login check failed.');
    } catch {
      return this.disconnect('Login check failed.');
    }
    this.verifyToken = undefined;
    this.encrypt = cfb8(secret, false);
    this.decrypt = cfb8(secret, true);
    // Bytes after the response were encrypted already.
    const rest = this.fromClient.rest();
    const hash = mcHexDigest(createHash('sha1').update('').update(secret).update(key.publicDer).digest());
    const ok = await hasJoined(this.name, hash, '');
    if (this.ended) return;
    if (!ok) return this.disconnect('This name is protected by autologin. Join with the paid Minecraft account, or ask the owner to turn autologin off.');
    this.verified = true;
    if (rest.length) for (const f of this.fromClient.push(this.decrypt.update(rest))) this.held.push(f.raw);
    this.connectBackend([this.handshake!]);
  }

  private connectBackend(first: Buffer[]): void {
    this.waiting = true;
    this.held = [...first.filter((b) => b.length), ...this.held];
    const backend = net.connect({ host: '127.0.0.1', port: this.backendPort });
    this.backend = backend;
    backend.setNoDelay(true);
    backend.on('connect', () => {
      for (const b of this.held) backend.write(b);
      this.held = [];
      this.waiting = false;
    });
    backend.on('data', (d) => {
      if (this.state === 'status') return this.toClient(d);
      try {
        for (const f of this.fromServer.push(d)) this.serverFrame(f.raw, f.body);
      } catch {
        this.close();
      }
    });
    backend.on('error', () => {
      if (this.state === 'login' && !this.client.destroyed && !this.ended) this.disconnect('The server is starting. Try again in a moment.');
      else this.close();
    });
    backend.on('close', () => this.close());
  }

  private serverFrame(raw: Buffer, body: Buffer): void {
    if (this.state === 'login') {
      const id = cheapId(body, this.compressed) ?? openFrame(body, this.compressed).id;
      if (id === 3 && !this.compressed) {
        const { data } = openFrame(body, false);
        this.toClient(raw);
        this.compressed = readVarInt(data, 0)!.value >= 0;
        return;
      }
      if (id === 2) {
        this.toClient(raw);
        if (this.protocol < P_1_20_2) this.enterPlay();
        return;
      }
    }
    this.toClient(raw);
  }

  private disconnect(reason: string): void {
    if (this.ended) return;
    if (this.state === 'login' || this.state === 'handshake') this.toClient(frame(0, str(JSON.stringify({ text: reason })), this.compressed));
    setTimeout(() => this.close(), 200);
  }
}

export class LoginProxy {
  private server?: net.Server;
  readonly sessions = new Set<Session>();

  constructor(private readonly hooks: ProxyHooks) {}

  listen(publicPort: number, backendPort: number): Promise<void> {
    const server = net.createServer((socket) => {
      const conn = new Connection(socket, backendPort, {
        ...this.hooks,
        joined: (s) => {
          this.sessions.add(s);
          this.hooks.joined(s);
        },
        closed: (s) => {
          this.sessions.delete(s);
          this.hooks.closed(s);
        },
      });
      void conn;
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(publicPort, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    for (const s of this.sessions) s.close();
    this.sessions.clear();
  }

  find(name: string): Session | undefined {
    for (const s of this.sessions) if (s.name.toLowerCase() === name.toLowerCase()) return s;
    return undefined;
  }
}
