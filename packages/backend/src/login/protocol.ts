// The few pieces of the Minecraft Java protocol srvMC Login needs: VarInt frames, optional zlib
// compression, strings, and the serverbound packet ids per protocol version (packets.json, made by
// scripts/gen-login-packets.mjs).
import { inflateSync } from 'node:zlib';
import { PACKETS } from './packets.ts';

export interface PacketIds {
  /** Chat line; before 1.19 commands came this way too, starting with "/". */
  chat: number;
  /** 1.19+: a command without the slash. */
  command: number;
  /** 1.20.5+: a command with signed arguments. */
  signedCommand: number;
  /** 1.20.2+, in play: the client goes back to configuration. */
  configAck: number;
  /** 1.20.2+, in configuration: the client goes on to play. */
  finishConfig: number;
}

const ROWS = PACKETS;
const RELEASES = Object.keys(ROWS)
  .map(Number)
  .filter((p) => p < 0x40000000)
  .sort((a, b) => a - b);

/** Ids for a protocol; an unknown one gets those of the newest known release at or below it. */
export function packetIds(protocol: number): { ids: PacketIds; exact: boolean } {
  let row = ROWS[String(protocol)];
  const exact = !!row;
  if (!row) {
    const below = protocol >= 0x40000000 ? RELEASES.at(-1) : [...RELEASES].reverse().find((p) => p <= protocol);
    row = ROWS[String(below ?? RELEASES[0])]!;
  }
  const [chat, command, signedCommand, configAck, finishConfig] = row as [number, number, number, number, number];
  return { ids: { chat, command, signedCommand, configAck, finishConfig }, exact };
}

export function readVarInt(buf: Buffer, pos: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i]!;
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, next: pos + i + 1 };
  }
  throw new Error('VarInt too long');
}

export function varInt(value: number): Buffer {
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

export function readString(buf: Buffer, pos: number): { value: string; next: number } {
  const len = readVarInt(buf, pos);
  if (!len || len.next + len.value > buf.length) throw new Error('Bad string');
  return { value: buf.toString('utf8', len.next, len.next + len.value), next: len.next + len.value };
}

export function str(value: string): Buffer {
  const b = Buffer.from(value, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
}

export function byteArray(value: Buffer): Buffer {
  return Buffer.concat([varInt(value.length), value]);
}

/** One whole frame: `raw` is the frame as it came (length prefix included), forwarded untouched. */
export interface Frame {
  raw: Buffer;
  /** The frame body without the length prefix. */
  body: Buffer;
}

/** Cuts a byte stream into frames. Partial frames wait for more data. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      const len = readVarInt(this.buf, 0);
      if (!len) break;
      if (len.value > 2 * 1024 * 1024 + 8) throw new Error('Frame too big');
      const end = len.next + len.value;
      if (this.buf.length < end) break;
      out.push({ raw: this.buf.subarray(0, end), body: this.buf.subarray(len.next, end) });
      this.buf = this.buf.subarray(end);
    }
    return out;
  }

  /** Bytes after the last whole frame. */
  rest(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }
}

/** A frame's packet id and data, unpacking it when compression is on and the packet was big enough. */
export function openFrame(body: Buffer, compressed: boolean): { id: number; data: Buffer } {
  let payload = body;
  if (compressed) {
    const dataLen = readVarInt(body, 0)!;
    payload = dataLen.value === 0 ? body.subarray(dataLen.next) : inflateSync(body.subarray(dataLen.next), { maxOutputLength: 8 * 1024 * 1024 });
  }
  const id = readVarInt(payload, 0)!;
  return { id: id.value, data: payload.subarray(id.next) };
}

/** Peeks at a compressed frame's id without unpacking: only possible when it was sent uncompressed. */
export function cheapId(body: Buffer, compressed: boolean): number | null {
  if (!compressed) return readVarInt(body, 0)?.value ?? null;
  const dataLen = readVarInt(body, 0);
  if (!dataLen || dataLen.value !== 0) return null;
  return readVarInt(body, dataLen.next)?.value ?? null;
}

/** Builds a frame (uncompressed packets are fine under compression, with data length 0). */
export function frame(id: number, data: Buffer, compressed: boolean): Buffer {
  const payload = Buffer.concat([varInt(id), data]);
  const body = compressed ? Buffer.concat([varInt(0), payload]) : payload;
  return Buffer.concat([varInt(body.length), body]);
}

/** Minecraft's server hash: SHA-1 as a signed (two's complement) hex number. */
export function mcHexDigest(hash: Buffer): string {
  const negative = (hash[0]! & 0x80) !== 0;
  let bytes = hash;
  if (negative) {
    bytes = Buffer.from(hash.map((b) => ~b & 0xff));
    for (let i = bytes.length - 1; i >= 0; i--) {
      bytes[i] = (bytes[i]! + 1) & 0xff;
      if (bytes[i] !== 0) break;
    }
  }
  const hex = bytes.toString('hex').replace(/^0+/, '') || '0';
  return negative ? `-${hex}` : hex;
}
