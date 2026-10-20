/**
 * A place's air and light, for the game to tie everything to the painting: the mist that drifts over unexplored
 * ground and past the painting's edge, and the light the painting itself carries (measured from its pixels).
 *
 * The mist is one square texture that tiles. Luna writes what drifts in the place (sea fog, ash haze, cave spores)
 * from its description and palette, Krea 2 paints it, and it is made seamless the way texture artists do it: rolled
 * by half so its edges meet in a cross in the middle, the cross painted over by AnyPaint (Krea's transformer gains
 * nothing from circular padding), and its large-scale brightness flattened out so no repeat shows. The game reads
 * its brightness as density (see docs/world-art.md).
 */
import sharp from 'sharp';
import { z } from 'zod';
import { profileFor } from '../genai/promptprofiles';
import { genai } from '../genai/service';
import { kreaContinue, kreaPaint } from './comfy';
import type { GpuQueue } from './gpu';

/** The mist tile's size (one Krea window, 1 MP). */
export const MIST_SIZE = 1024;
/** Half-width of the band painted over the seams. */
const SEAM = 96;
/** AnyPaint's redrawn boundary; its paint is kept this far past the band (where old and new already match). */
const REDRAW = 32;
const CUT = 48;

/** What the mist's design needs to know about the place. */
export interface MistBrief {
  name: string;
  kind: string;
  indoor: boolean;
  description: string;
  /** The painting's art direction (palette, light, materials). */
  style?: string;
  weather: string;
  fogColor: string;
  lightColor: string;
}

/** Where a place's steps are saved, so a resumed build picks up where it stopped. */
export interface Draft {
  json<T>(name: string): T | undefined;
  saveJson(name: string, v: unknown): void;
  png(name: string): Buffer | undefined;
  savePng(name: string, b: Buffer): void;
}

/** The painter, replaceable in tests. */
export interface MistPainter {
  paint: (prompt: string, width: number, height: number, seed: number) => Promise<Buffer>;
  continue: (init: Buffer, mask: Buffer, prompt: string, seed: number, redraw: number) => Promise<Buffer>;
}
const KREA: MistPainter = { paint: kreaPaint, continue: kreaContinue };

/** Said after Luna's description: the framing every mist tile needs. */
const FRAMING =
  'A seamless tileable texture seen from directly above, filling the whole square frame edge to edge with an even spread of soft wisps and banks of varying density, over a near-black background. Flat, even light. Nothing solid in it: no ground, no objects, no horizon, no light source, no text.';

const MistSchema = z.object({
  prompt: z.string().min(80).max(900).describe('What drifts in the air of this place, for the image model'),
});

/** Luna's description of the place's mist, for Krea (a plain one when no model is configured). */
export async function designMist(b: MistBrief): Promise<string> {
  const g = genai();
  const plain = `Drifting ${b.weather === 'none' ? (b.indoor ? 'dusty haze' : 'mist') : `${b.weather} haze`} in tones of ${b.fogColor} and ${b.lightColor}.`;
  if (g.isProcedural('world.design')) return `${plain} ${FRAMING}`;
  const profile = profileFor({ checkpoint: 'krea2' });
  const out = await g.structured('world.design', {
    system: 'You are the art director of a 2D isometric RPG. Each place has a layer of drifting air painted as a tileable texture, laid over unexplored ground and the edges of the place.',
    prompt: `PLACE: ${b.name} (${b.kind}${b.indoor ? ', indoors' : ''}): ${b.description}
${b.style ? `Art direction: ${b.style}\n` : ''}Light colour ${b.lightColor}, shadow colour ${b.fogColor}${b.weather !== 'none' ? `, weather: ${b.weather}` : ''}.

Describe the air of this place as it would drift across it, seen from above: what it is (sea fog, river mist, ash haze, cave spores, smoke, dust, steam, pollen), its colours (from the palette, with the denser parts lighter than the thin parts), and its texture (soft billows, fine streaks, curling wisps, sparse motes). Two or three sentences, describing only the drifting air itself, in the art style.${profile.writerNotes ? `\n\n${profile.writerNotes}` : ''}`,
    schema: MistSchema,
    name: 'mist',
    maxTokens: 800,
  });
  return `${out.prompt.trim()} ${FRAMING}`;
}

/** The seams of a tile rolled by half: a cross through the middle, white where AnyPaint paints. */
export function seamMask(size: number, half = SEAM): Buffer {
  const m = Buffer.alloc(size * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (Math.abs(x + 0.5 - c) < half || Math.abs(y + 0.5 - c) < half) m[y * size + x] = 255;
  return m;
}

/** Roll raw pixels by half the size both ways (the tile's edges meet in the middle). */
export function roll(px: Buffer, size: number, channels: number): Buffer {
  const out = Buffer.alloc(px.length), h = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) px.copy(out, (((y + h) % size) * size + ((x + h) % size)) * channels, (y * size + x) * channels, (y * size + x + 1) * channels);
  return out;
}

/**
 * Blend a tile across its wrap (a few pixels either side of where its edges meet, both ways). Its edges are the
 * painting's centre lines, where ComfyUI's tiled VAE decode (its fallback when the GPU is short of memory) can
 * leave a faint seam. RGB in, RGB out.
 */
export function mendWrap(px: Buffer, size: number, R = 4): Buffer {
  const out = Buffer.from(px);
  const w = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (R * R)));
  const ws = w.reduce((a, b) => a + b);
  const pass = (src: Buffer, along: (line: number, t: number) => number) => {
    const dst = Buffer.from(src);
    for (let line = 0; line < size; line++)
      for (let t = -R; t < R; t++) {
        // Blend fully at the wrap, fading out R pixels from it.
        const keep = (Math.abs(t + 0.5) - 0.5) / R;
        for (let ch = 0; ch < 3; ch++) {
          let s = 0;
          for (let i = -R; i <= R; i++) s += src[along(line, (t + i + size) % size) * 3 + ch]! * w[i + R]!;
          const k = along(line, (t + size) % size) * 3 + ch;
          dst[k] = Math.round(src[k]! * keep + (s / ws) * (1 - keep));
        }
      }
    return dst;
  };
  return pass(pass(out, (y, x) => y * size + x), (x, y) => y * size + x);
}

/**
 * Even out a tile's large-scale brightness (a wrap-around blur divided out) and stretch it to the full range, so
 * it repeats without a visible pattern and its brightness reads as density. Keeps its colours. RGB in, RGB out.
 */
export function flatten(px: Buffer, size: number): Buffer {
  const G = 64, cell = size / G;
  const luma = (i: number) => 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
  const low = new Float32Array(G * G);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) low[Math.floor(y / cell) * G + Math.floor(x / cell)]! += luma((y * size + x) * 3) / (cell * cell);
  // Wrap-around Gaussian, separable, sigma 10 cells (about a sixth of the tile: billows smaller than that stay).
  const S = 10, R = S * 3, k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * S * S)));
  const ks = k.reduce((a, b) => a + b);
  const blur = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(G * G);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) s += src[((y + i * dy + G) % G) * G + ((x + i * dx + G) % G)]! * k[i + R]!;
        out[y * G + x] = s / ks;
      }
    return out;
  };
  const smooth = blur(blur(low, 1, 0), 0, 1);
  const mean = smooth.reduce((a, b) => a + b) / smooth.length;
  // Bilinear, wrapping, between cell centres.
  const at = (x: number, y: number) => {
    const fx = x / cell - 0.5, fy = y / cell - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const v = (cx: number, cy: number) => smooth[((cy + G) % G) * G + ((cx + G) % G)]!;
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  };
  const even = new Float32Array(px.length);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const f = (mean + 4) / (at(x, y) + 4), i = (y * size + x) * 3;
      for (let ch = 0; ch < 3; ch++) even[i + ch] = px[i + ch]! * f;
    }
  // Stretch brightness (not colour): the 2nd to the 98th percentile becomes the full range, each pixel's colour
  // scaled with it, so the thin parts go dark and the dense ones light without the hues getting louder.
  const lum = (i: number) => 0.2126 * even[i]! + 0.7152 * even[i + 1]! + 0.0722 * even[i + 2]!;
  const hist = new Uint32Array(1024);
  for (let i = 0; i < even.length; i += 3) hist[Math.max(0, Math.min(1023, Math.round(lum(i) * 2)))]!++;
  const pct = (p: number) => {
    let n = 0;
    for (let i = 0; i < 1024; i++) if ((n += hist[i]!) >= p * size * size) return i / 2;
    return 511.5;
  };
  const lo = pct(0.02), hi = Math.max(lo + 8, pct(0.98));
  const out = Buffer.alloc(px.length);
  for (let i = 0; i < even.length; i += 3) {
    const l = lum(i), f = (Math.max(0, Math.min(1, (l - lo) / (hi - lo))) * 255) / Math.max(1, l);
    for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.max(0, Math.min(255, Math.round(even[i + ch]! * f)));
  }
  return out;
}

/** Make a painted square tile seamless: roll by half and paint over the cross where its edges now meet. */
export async function seamless(tile: Buffer, prompt: string, seed: number, painter: MistPainter = KREA): Promise<Buffer> {
  const N = MIST_SIZE;
  const rolled = roll(await sharp(tile).resize(N, N).removeAlpha().raw().toBuffer(), N, 3);
  const mask = seamMask(N);
  const png = (b: Buffer, channels: 1 | 3) => sharp(b, { raw: { width: N, height: N, channels } }).png().toBuffer();
  const painted = await sharp(await painter.continue(await png(rolled, 3), await png(mask, 1), prompt, seed, REDRAW)).resize(N, N).removeAlpha().raw().toBuffer();
  // Only the band and just past it come from the new paint: the edges stay exactly as rolled, so they still meet.
  const keep = seamMask(N, SEAM + CUT);
  for (let k = 0; k < N * N; k++) if (keep[k]) painted.copy(rolled, k * 3, k * 3, k * 3 + 3);
  return rolled;
}

/**
 * The place's mist, as a finished tile (WebP, RGB; brightness is density): designed, painted and made seamless on
 * the build's GPU queue, each step saved so a resumed build picks up where it stopped.
 */
export async function paintMist(b: MistBrief, draft: Draft, gpu: GpuQueue, priority: number, seed: number, painter: MistPainter = KREA): Promise<Buffer> {
  const prompt = draft.json<{ prompt: string }>('mist')?.prompt ?? (await designMist(b));
  draft.saveJson('mist', { prompt });
  let tile = draft.png('mist');
  if (!tile) {
    tile = await gpu.run('krea', priority, async () => seamless(await painter.paint(prompt, MIST_SIZE, MIST_SIZE, seed), prompt, seed + 1, painter));
    tile = await sharp(tile, { raw: { width: MIST_SIZE, height: MIST_SIZE, channels: 3 } }).png().toBuffer();
    draft.savePng('mist', tile);
  }
  const px = await sharp(tile).removeAlpha().raw().toBuffer();
  return sharp(flatten(mendWrap(px, MIST_SIZE), MIST_SIZE), { raw: { width: MIST_SIZE, height: MIST_SIZE, channels: 3 } }).webp({ quality: 88 }).toBuffer();
}

const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The light a painting carries: the colour of its lit parts (its brightest tenth), of its shadows (its darkest
 * third) and its mean brightness (0..1). Characters drawn over it take this light.
 */
export async function measureLight(image: Buffer): Promise<{ light: string; shade: string; level: number }> {
  const { data } = await sharp(image).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = data.length / 3;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += lum[i] = 0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!;
  const sorted = Float32Array.from(lum).sort();
  const mean = (pick: (l: number) => boolean) => {
    const acc = [0, 0, 0];
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (!pick(lum[i]!)) continue;
      m++;
      for (let ch = 0; ch < 3; ch++) acc[ch]! += data[i * 3 + ch]!;
    }
    return acc.map((v) => v / Math.max(1, m));
  };
  const top = sorted[Math.floor(n * 0.9)]!, bottom = sorted[Math.floor(n * 0.33)]!;
  return { light: hex(mean((l) => l >= top)), shade: hex(mean((l) => l <= bottom)), level: Math.round((sum / n / 255) * 1000) / 1000 };
}
