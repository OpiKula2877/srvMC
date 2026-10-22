// AES-128/CFB8, the stream cipher of Minecraft's online-mode connections. Electron's crypto
// (BoringSSL) has no CFB8, so it falls back to this small AES block cipher with T-tables.
import { createCipheriv, createDecipheriv, getCiphers } from 'node:crypto';

export interface StreamCipher {
  update(data: Buffer): Buffer;
}

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);

(() => {
  // GF(2^8) log tables, then the S-box: multiplicative inverse plus the affine transform.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i++) {
    let b = i === 0 ? 0 : exp[(255 - log[i]!) % 255]!;
    let s = b;
    for (let k = 0; k < 4; k++) {
      b = ((b << 1) | (b >>> 7)) & 0xff;
      s ^= b;
    }
    SBOX[i] = s ^ 0x63;
  }
  const xt = (v: number) => ((v << 1) ^ (v & 0x80 ? 0x11b : 0)) & 0xff;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]!;
    const s2 = xt(s);
    const s3 = s2 ^ s;
    const w = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = w;
    T1[i] = ((w >>> 8) | (w << 24)) >>> 0;
    T2[i] = ((w >>> 16) | (w << 16)) >>> 0;
    T3[i] = ((w >>> 24) | (w << 8)) >>> 0;
  }
})();

function expandKey(key: Buffer): Uint32Array {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) w[i] = key.readUInt32BE(i * 4);
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1]!;
    if (i % 4 === 0) {
      t = ((SBOX[(t >>> 16) & 0xff]! << 24) | (SBOX[(t >>> 8) & 0xff]! << 16) | (SBOX[t & 0xff]! << 8) | SBOX[t >>> 24]!) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    w[i] = (w[i - 4]! ^ t) >>> 0;
  }
  return w;
}

class JsCfb8 implements StreamCipher {
  private readonly k: Uint32Array;
  // The 16-byte shift register as four big-endian words.
  private r0: number;
  private r1: number;
  private r2: number;
  private r3: number;

  constructor(
    key: Buffer,
    private readonly decrypt: boolean,
  ) {
    this.k = expandKey(key);
    this.r0 = key.readUInt32BE(0);
    this.r1 = key.readUInt32BE(4);
    this.r2 = key.readUInt32BE(8);
    this.r3 = key.readUInt32BE(12);
  }

  update(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    const k = this.k;
    let { r0, r1, r2, r3 } = this;
    const k40 = k[40]! >>> 24;
    for (let i = 0; i < data.length; i++) {
      let a = r0 ^ k[0]!;
      let b = r1 ^ k[1]!;
      let c = r2 ^ k[2]!;
      let d = r3 ^ k[3]!;
      for (let o = 4; o < 40; o += 4) {
        const a2 = T0[a >>> 24]! ^ T1[(b >>> 16) & 0xff]! ^ T2[(c >>> 8) & 0xff]! ^ T3[d & 0xff]! ^ k[o]!;
        const b2 = T0[b >>> 24]! ^ T1[(c >>> 16) & 0xff]! ^ T2[(d >>> 8) & 0xff]! ^ T3[a & 0xff]! ^ k[o + 1]!;
        const c2 = T0[c >>> 24]! ^ T1[(d >>> 16) & 0xff]! ^ T2[(a >>> 8) & 0xff]! ^ T3[b & 0xff]! ^ k[o + 2]!;
        d = T0[d >>> 24]! ^ T1[(a >>> 16) & 0xff]! ^ T2[(b >>> 8) & 0xff]! ^ T3[c & 0xff]! ^ k[o + 3]!;
        a = a2;
        b = b2;
        c = c2;
      }
      // CFB8 uses only the first byte of the block: the last round for that byte alone.
      const inp = data[i]!;
      const o = inp ^ SBOX[a >>> 24]! ^ k40;
      out[i] = o;
      const fed = this.decrypt ? inp : o;
      r0 = ((r0 << 8) | (r1 >>> 24)) >>> 0;
      r1 = ((r1 << 8) | (r2 >>> 24)) >>> 0;
      r2 = ((r2 << 8) | (r3 >>> 24)) >>> 0;
      r3 = ((r3 << 8) | fed) >>> 0;
    }
    this.r0 = r0;
    this.r1 = r1;
    this.r2 = r2;
    this.r3 = r3;
    return out;
  }
}

const NATIVE = getCiphers().includes('aes-128-cfb8');

/** Key and IV are both the shared secret, as Minecraft does it. */
export function cfb8(secret: Buffer, decrypt: boolean, native = NATIVE): StreamCipher {
  if (native) return decrypt ? createDecipheriv('aes-128-cfb8', secret, secret) : createCipheriv('aes-128-cfb8', secret, secret);
  return new JsCfb8(secret, decrypt);
}
