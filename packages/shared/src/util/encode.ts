/** Compact encodings for tile layers and bitsets (portable between Node and browsers). */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    parts.push(
      B64[a >> 2]!,
      B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!,
      b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!,
      c === undefined ? '=' : B64[c & 63]!,
    );
  }
  return parts.join('');
}

export function base64ToBytes(str: string): Uint8Array {
  let len = str.length;
  while (len > 0 && str[len - 1] === '=') len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = LOOKUP[str.charCodeAt(i)]!;
    const b = i + 1 < len ? LOOKUP[str.charCodeAt(i + 1)]! : 0;
    const c = i + 2 < len ? LOOKUP[str.charCodeAt(i + 2)]! : -1;
    const d = i + 3 < len ? LOOKUP[str.charCodeAt(i + 3)]! : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0 && o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0 && o < out.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

export class BitSet {
  bytes: Uint8Array;
  constructor(public readonly size: number, data?: string) {
    const need = Math.ceil(size / 8);
    const src = data ? base64ToBytes(data) : new Uint8Array(need);
    if (src.length < need) {
      this.bytes = new Uint8Array(need);
      this.bytes.set(src);
    } else this.bytes = src;
  }
  get(i: number): boolean {
    return (this.bytes[i >> 3]! & (1 << (i & 7))) !== 0;
  }
  /** Sets the bit; returns true if it was previously unset. */
  set(i: number): boolean {
    const had = this.get(i);
    this.bytes[i >> 3] = this.bytes[i >> 3]! | (1 << (i & 7));
    return !had;
  }
  count(): number {
    let c = 0;
    for (const b of this.bytes) {
      let v = b;
      while (v) {
        c += v & 1;
        v >>= 1;
      }
    }
    return c;
  }
  encode(): string {
    return bytesToBase64(this.bytes);
  }
}
