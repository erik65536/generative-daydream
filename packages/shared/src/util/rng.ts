/** Deterministic, seedable random number generation shared by server and client. */

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hash several values into a single 32-bit integer (stable across platforms). */
export function hashOf(...parts: (string | number)[]): number {
  return hashString(parts.join('|'));
}

/** Uniform float in [0,1) derived from a hash, for one-off deterministic rolls. */
export function hashFloat(...parts: (string | number)[]): number {
  let t = hashOf(...parts) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class Rng {
  private state: number;
  constructor(seed: number | string) {
    this.state = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  }
  /** Float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array');
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  pickWeighted<T>(items: readonly T[], weight: (t: T) => number): T {
    const total = items.reduce((s, it) => s + Math.max(0, weight(it)), 0);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weight(it));
      if (r <= 0) return it;
    }
    return items[items.length - 1]!;
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
  /** Fork a child generator so sub-systems don't perturb each other's sequences. */
  fork(label: string): Rng {
    return new Rng(hashOf(this.state, label));
  }
}

let uidCounter = 0;
export function uid(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 9) + (uidCounter++ % 1296).toString(36).padStart(2, '0');
  return prefix ? `${prefix}_${rnd}` : rnd;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x';
}
