// Wake on join: while a server is stopped, a small listener on its port answers the Minecraft
// server list ping ("asleep – join to wake it") and starts the real server when a player tries to join.
import net from 'node:net';

export interface WakeStatus {
  /** Server list text, may contain § formatting codes. */
  motd: string;
  maxPlayers: number;
  /** data:image/png;base64,… */
  favicon?: string;
}

export interface WakeOptions {
  port: number;
  status: () => Promise<WakeStatus>;
  /** A player tried to join. The listener has already closed, so the port is free. */
  onJoin: (name: string | null) => void;
  /** Text shown to the player whose join woke the server. */
  kickMessage: string;
}

const MAX_BUFFER = 4096;
const MAX_SOCKETS = 32;

export function writeVarInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Reads a VarInt at `off`; null when the buffer ends first. Throws on a malformed (over 5 bytes) value. */
export function readVarInt(buf: Buffer, off: number): { value: number; size: number } | null {
  let value = 0;
  for (let size = 0; size < 5; size++) {
    if (off + size >= buf.length) return null;
    const b = buf[off + size]!;
    value |= (b & 0x7f) << (7 * size);
    if (!(b & 0x80)) return { value: value | 0, size: size + 1 };
  }
  throw new Error('VarInt je moc dlouhý.');
}

export function mcString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

export function readMcString(buf: Buffer, off: number): { value: string; size: number } | null {
  const len = readVarInt(buf, off);
  if (!len || len.value < 0 || len.value > 32767 * 4) return null;
  const start = off + len.size;
  if (start + len.value > buf.length) return null;
  return { value: buf.subarray(start, start + len.value).toString('utf8'), size: len.size + len.value };
}

export function packet(id: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Splits complete packets off the front of `buf`. */
export function takePackets(buf: Buffer): { packets: { id: number; data: Buffer }[]; rest: Buffer } {
  const packets: { id: number; data: Buffer }[] = [];
  let off = 0;
  for (;;) {
    const len = readVarInt(buf, off);
    if (!len || off + len.size + len.value > buf.length) break;
    if (len.value <= 0 || len.value > MAX_BUFFER) throw new Error('Neplatná délka paketu.');
    const body = buf.subarray(off + len.size, off + len.size + len.value);
    const id = readVarInt(body, 0);
    if (!id) throw new Error('Neplatný paket.');
    packets.push({ id: id.value, data: body.subarray(id.size) });
    off += len.size + len.value;
  }
  return { packets, rest: buf.subarray(off) };
}

export interface Handshake {
  protocol: number;
  nextState: number;
}

export function parseHandshake(data: Buffer): Handshake | null {
  const protocol = readVarInt(data, 0);
  if (!protocol) return null;
  const host = readMcString(data, protocol.size);
  if (!host) return null;
  const portEnd = protocol.size + host.size + 2;
  const next = readVarInt(data, portEnd);
  if (!next) return null;
  return { protocol: protocol.value, nextState: next.value };
}

/** One connection: handshake, then either the status ping or a login attempt. */
function handle(socket: net.Socket, opts: WakeOptions, wake: (name: string | null) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  let state: 'handshake' | 'status' | 'login' = 'handshake';
  let protocol = 0;
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_BUFFER) return socket.destroy();
    // Old clients (before 1.7) send a legacy ping starting with 0xFE; they just get no answer.
    if (state === 'handshake' && buf[0] === 0xfe) return socket.destroy();
    let packets: { id: number; data: Buffer }[];
    try {
      ({ packets, rest: buf } = takePackets(buf));
    } catch {
      return socket.destroy();
    }
    for (const p of packets) {
      if (state === 'handshake') {
        const hs = p.id === 0 ? parseHandshake(p.data) : null;
        if (!hs) return socket.destroy();
        protocol = hs.protocol;
        state = hs.nextState === 1 ? 'status' : 'login';
      } else if (state === 'status') {
        if (p.id === 0) {
          void opts.status().then(
            (st) => {
              const body = {
                version: { name: 'srvMC', protocol },
                players: { max: st.maxPlayers, online: 0, sample: [] },
                description: { text: st.motd },
                ...(st.favicon && { favicon: st.favicon }),
              };
              if (!socket.destroyed) socket.write(packet(0, mcString(JSON.stringify(body))));
            },
            () => socket.destroy(),
          );
        } else if (p.id === 1 && p.data.length === 8) {
          socket.end(packet(1, p.data));
        }
      } else {
        // Login Start: the player name comes first; newer clients add a UUID after it.
        const name = p.id === 0 ? readMcString(p.data, 0)?.value : undefined;
        socket.end(packet(0, mcString(JSON.stringify({ text: opts.kickMessage }))));
        wake(name && /^[A-Za-z0-9_.]{1,16}$/.test(name) ? name : null);
        return;
      }
    }
  });
}

export class WakeListener {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private woke = false;

  constructor(readonly opts: WakeOptions) {}

  get listening(): boolean {
    return !!this.server?.listening;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        if (this.sockets.size >= MAX_SOCKETS) return socket.destroy();
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        handle(socket, this.opts, (name) => {
          if (this.woke) return;
          this.woke = true;
          // Free the port first, then hand over to the real server.
          void this.close().then(() => this.opts.onJoin(name));
        });
      });
      server.once('error', reject);
      server.listen(this.opts.port, () => {
        server.off('error', reject);
        server.on('error', () => undefined);
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) {
      // Let the kick message reach the client before the socket goes.
      setTimeout(() => s.destroy(), 500).unref();
    }
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
