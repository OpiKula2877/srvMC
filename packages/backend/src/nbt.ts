// Minimal NBT reader, enough to read level.dat (world name, version, seed).
import { gunzipSync } from 'node:zlib';

export type NbtValue = number | bigint | string | NbtValue[] | NbtCompound | Int8Array | Int32Array | BigInt64Array;
export interface NbtCompound {
  [key: string]: NbtValue;
}

const MAX_DEPTH = 256;

export function readNbt(input: Buffer): NbtCompound {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: 64 * 1024 * 1024 }) : input;
  let o = 0;

  const u8 = () => buf.readUInt8(o++);
  const i16 = () => {
    const v = buf.readInt16BE(o);
    o += 2;
    return v;
  };
  const i32 = () => {
    const v = buf.readInt32BE(o);
    o += 4;
    return v;
  };
  const str = () => {
    const len = buf.readUInt16BE(o);
    o += 2;
    const s = buf.toString('utf8', o, o + len);
    o += len;
    return s;
  };
  const count = () => {
    const n = i32();
    if (n < 0 || n > buf.length) throw new RangeError('Bad NBT length');
    return n;
  };

  const payload = (type: number, depth: number): NbtValue => {
    if (depth > MAX_DEPTH) throw new RangeError('NBT nested too deep');
    switch (type) {
      case 1:
        return buf.readInt8(o++);
      case 2:
        return i16();
      case 3:
        return i32();
      case 4: {
        const v = buf.readBigInt64BE(o);
        o += 8;
        return v;
      }
      case 5: {
        const v = buf.readFloatBE(o);
        o += 4;
        return v;
      }
      case 6: {
        const v = buf.readDoubleBE(o);
        o += 8;
        return v;
      }
      case 7: {
        const n = count();
        const v = new Int8Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + n));
        o += n;
        return v;
      }
      case 8:
        return str();
      case 9: {
        const inner = u8();
        const n = count();
        const list: NbtValue[] = [];
        for (let i = 0; i < n; i++) list.push(payload(inner, depth + 1));
        return list;
      }
      case 10: {
        const obj: NbtCompound = {};
        for (;;) {
          const t = u8();
          if (t === 0) return obj;
          const name = str();
          obj[name] = payload(t, depth + 1);
        }
      }
      case 11: {
        const n = count();
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) v[i] = i32();
        return v;
      }
      case 12: {
        const n = count();
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) {
          v[i] = buf.readBigInt64BE(o);
          o += 8;
        }
        return v;
      }
      default:
        throw new RangeError(`Unknown NBT tag ${type}`);
    }
  };

  if (u8() !== 10) throw new RangeError('NBT root is not a compound');
  str();
  return payload(10, 0) as NbtCompound;
}

export function nbtPath(root: NbtCompound, ...keys: string[]): NbtValue | undefined {
  let cur: NbtValue | undefined = root;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || ArrayBuffer.isView(cur)) return undefined;
    cur = (cur as NbtCompound)[k];
  }
  return cur;
}
