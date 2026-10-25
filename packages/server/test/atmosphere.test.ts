import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MIST_SIZE, flatten, measureLight, mendWrap, paintMist, roll, seamMask, seamless, type Draft, type MistPainter } from '../src/worldgen/atmosphere';
import { GpuQueue } from '../src/worldgen/gpu';
import { mockModels } from './helpers';

const N = MIST_SIZE;

/** A noisy RGB tile with a strong brightness gradient across it (not tileable). */
function tile(seed = 1): Buffer {
  const px = Buffer.alloc(N * N * 3);
  let s = seed;
  for (let i = 0; i < N * N; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const v = 40 + ((i % N) / N) * 120 + (s % 60);
    px[i * 3] = v;
    px[i * 3 + 1] = v * 0.9;
    px[i * 3 + 2] = v * 0.8;
  }
  return px;
}

const png = (px: Buffer) => sharp(px, { raw: { width: N, height: N, channels: 3 } }).png().toBuffer();

/** A painter that paints the noise tile and "continues" by filling the mask with flat grey. */
function fakePainter(calls: string[]): MistPainter {
  return {
    paint: async (_p, w, h) => {
      calls.push(`paint ${w}x${h}`);
      return png(tile());
    },
    continue: async (init, mask) => {
      calls.push('continue');
      const px = await sharp(init).removeAlpha().raw().toBuffer();
      const m = await sharp(mask).extractChannel(0).raw().toBuffer();
      for (let k = 0; k < N * N; k++) if (m[k]) px.fill(128, k * 3, k * 3 + 3);
      return png(px);
    },
  };
}

function memoryDraft(): Draft & { files: Map<string, unknown> } {
  const files = new Map<string, unknown>();
  return {
    files,
    json: <T>(n: string) => files.get(`${n}.json`) as T | undefined,
    saveJson: (n, v) => void files.set(`${n}.json`, v),
    png: (n) => files.get(`${n}.png`) as Buffer | undefined,
    savePng: (n, b) => void files.set(`${n}.png`, b),
  };
}

describe('mist tiles', () => {
  it('rolls by half and puts the seams in a cross through the middle', () => {
    const px = tile();
    const r = roll(px, N, 3);
    expect(r.subarray(0, 3)).toEqual(px.subarray(((N / 2) * N + N / 2) * 3, ((N / 2) * N + N / 2) * 3 + 3));
    expect(roll(r, N, 3).equals(px)).toBe(true);
    const m = seamMask(N, 10);
    expect(m[(N / 2) * N + 3]).toBe(255);
    expect(m[3 * N + N / 2]).toBe(255);
    expect(m[3 * N + 3]).toBe(0);
  });

  it('makes a tile seamless: its opposite edges were neighbours in the painting', async () => {
    const calls: string[] = [];
    const out = await seamless(await png(tile()), 'mist', 1, fakePainter(calls));
    const px = tile();
    const at = (b: Buffer, x: number, y: number) => b[(y * N + x) * 3]!;
    // Left edge = column N/2 of the painting, right edge = column N/2 − 1: side by side, so the tile wraps.
    for (const y of [5, 200, 300]) {
      const oy = (y + N / 2) % N;
      expect(at(out, 0, y)).toBe(at(px, N / 2, oy));
      expect(at(out, N - 1, y)).toBe(at(px, N / 2 - 1, oy));
    }
    // The cross is repainted.
    expect(at(out, N / 2, 10)).toBe(128);
    expect(calls).toEqual(['continue']);
  });

  it('flattens large-scale brightness without breaking the wrap', () => {
    const px = tile();
    const flat = flatten(px, N);
    const colMean = (b: Buffer, x: number) => {
      let s = 0;
      for (let y = 0; y < N; y++) s += b[(y * N + x) * 3]!;
      return s / N;
    };
    // Most of the gradient across the tile is gone (relative to the tile's mean brightness).
    const mean = (b: Buffer) => b.reduce((a, v, k) => (k % 3 ? a : a + v), 0) / (N * N);
    const across = (b: Buffer) => Math.abs(colMean(b, 700) - colMean(b, 300)) / mean(b);
    expect(across(px)).toBeGreaterThan(0.3);
    expect(across(flat)).toBeLessThan(across(px) / 2);
    // Uses the full range.
    expect(Math.max(...flat.subarray(0, 30000))).toBeGreaterThan(230);
    // Wrap-invariant: flattening a rolled tile is the rolled flattened tile.
    expect(flatten(roll(px, N, 3), N).equals(roll(flat, N, 3))).toBe(true);
  });

  it('mends a faint seam where the tile wraps, leaving the rest alone', () => {
    // A smooth ramp across the tile: its only jump is at the wrap.
    const px = Buffer.alloc(N * N * 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) px.fill(60 + Math.round((x / N) * 20) + Math.round((y / N) * 20), (y * N + x) * 3, (y * N + x) * 3 + 3);
    const out = mendWrap(px, N);
    const at = (b: Buffer, x: number, y: number) => b[(y * N + x) * 3]!;
    expect(Math.abs(at(px, 0, 300) - at(px, N - 1, 300))).toBeGreaterThan(15);
    expect(Math.abs(at(out, 0, 300) - at(out, N - 1, 300))).toBeLessThan(6);
    expect(Math.abs(at(out, 300, 0) - at(out, 300, N - 1))).toBeLessThan(6);
    expect(at(out, 500, 500)).toBe(at(px, 500, 500));
  });

  it('is painted on the build queue once and resumed from the draft', async () => {
    const calls: string[] = [];
    const draft = memoryDraft();
    const brief = { name: 'Saltglass Flats', kind: 'wilderness', indoor: false, description: 'salt flats by the sea', weather: 'none', fogColor: '#34474a', lightColor: '#c6d1cc' };
    const gpu = new GpuQueue();
    const models = await mockModels();
    try {
      const a = await paintMist(brief, draft, gpu, 0, 5, fakePainter(calls));
      expect(calls).toEqual([`paint ${N}x${N}`, 'continue']);
      expect((draft.json<{ prompt: string }>('mist')?.prompt ?? '').length).toBeGreaterThan(40);
      const meta = await sharp(a).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', N, N]);
      const b = await paintMist(brief, draft, gpu, 0, 5, fakePainter(calls));
      expect(calls.length).toBe(2);
      expect(b.equals(a)).toBe(true);
    } finally {
      models.stop();
    }
  });
});

describe('painting light', () => {
  it('measures the lit colour, the shadow colour and the mean brightness', async () => {
    // A dark blue-grey place with a warm lamp-lit tenth.
    const W = 200, H = 100, px = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) px.set(i % 10 === 0 ? [250, 200, 120] : [20, 26, 40], i * 3);
    const l = await measureLight(await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
    expect(l.light).toBe('#fac878');
    expect(l.shade).toBe('#141a28');
    expect(l.level).toBeGreaterThan(0.16);
    expect(l.level).toBeLessThan(0.18);
  });
});
