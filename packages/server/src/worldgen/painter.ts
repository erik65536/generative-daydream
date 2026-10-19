/**
 * Painting a place: a guide pass paints the whole place at once (its design, colours and light), then a detail
 * pass repaints it in overlapping sections at game scale, each following its block-out and its part of the
 * guide, blended where they overlap. Then everything a person can stand behind is cut out of the painting.
 */
import fs from 'node:fs';
import sharp from 'sharp';
import type { WorldDefinition, ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { scenePrompt, writePaintBrief } from './backdrop';
import { renderScene, type Scene } from './scene';

const SECTION_PROMPT = (style: string) => `Picture 1 is one part of a finished painting of a 2D isometric RPG map, shown at low resolution. Picture 2 is the same part as a rough block-out of its layout.
Redraw picture 1 at full resolution and sharpness. Change nothing: the same objects in the same places at the same sizes, the same materials, colours, lighting and composition, so it joins seamlessly with the neighbouring parts of the painting. Add only crisp edges and fine detail where picture 1 is blurry. Do not add, remove or move anything; keep empty floor empty. No text or letters.
Art style: ${style}.`;

/** Whether the configured image model can paint places (edit with references, inpaint, upscale). */
export function canPaintPlaces(): boolean {
  const g = genai();
  if (g.isProcedural('image.texture')) return false;
  const cfg = g.providerConfig(g.purpose('image.texture').provider);
  return cfg.type === 'comfyui' && !!cfg.editWorkflow && !!cfg.inpaintWorkflow && !!cfg.upscaleWorkflow;
}

/** A size the painter works at (about 1.6 megapixels by default), and its scale from the original. */
function fit(w: number, h: number, mp = 1_600_000) {
  const sc = Math.min(1, Math.sqrt(mp / (w * h)));
  // Multiples of 32: the edit model resizes references to multiples of 32, and a reference of exactly the output's
  // size keeps the painting aligned with it.
  return { width: Math.max(256, Math.round((w * sc) / 32) * 32), height: Math.max(256, Math.round((h * sc) / 32) * 32), sc };
}

/** Blend weights for a section: 1 inside, ramping to 0 over `f` pixels at edges that overlap a neighbour. */
function featherMask(w: number, h: number, f: number, edges: { l: boolean; r: boolean; t: boolean; b: boolean }): Float32Array {
  // The join sits in the middle of the overlap and is narrow: two different paintings never stack into a ghost.
  const band = 32, start = f / 2 - band / 2;
  const ramp = (d: number) => (d - start) / band;
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 1;
      if (edges.l) a = Math.min(a, ramp(x));
      if (edges.r) a = Math.min(a, ramp(w - 1 - x));
      if (edges.t) a = Math.min(a, ramp(y));
      if (edges.b) a = Math.min(a, ramp(h - 1 - y));
      // Smooth (not linear) so the join has no visible band.
      const t = Math.max(0, Math.min(1, a));
      m[y * w + x] = t * t * (3 - 2 * t);
    }
  return m;
}

export interface PaintOptions {
  seed?: number;
  /** 0: the whole place in one painting (upscaled); 1: plus a detail pass in sections at game scale. */
  detail?: 0 | 1;
  /** Section size in game pixels (the painter works at about 1.6 MP; larger sections are upscaled back). */
  section?: { width: number; height: number };
  report?: (msg: string) => void;
  /** Keep intermediate images (for experiments). */
  debugPrefix?: string;
  /** Replace the painter's whole prompt. */
  prompt?: string;
  /** The art direction to paint from (written by the art director when absent). */
  brief?: string;
  /** The owner's direction for the art director. */
  guidance?: string;
  /** How freely the whole-place pass may repaint the block-out (0 keep, 1 from scratch). */
  guideStrength?: number;
  /** Double the resolution with the upscaler at the end (default on). */
  sharpen?: boolean;
  /** How freely the detail pass may change the whole painting (0 none, 1 repaint). */
  strength?: number;
  /** Megapixels of the whole-place painting (the model's comfortable size is about 1.6). */
  mp?: number;
}

/**
 * Only the map itself is kept: whatever the painter invented beyond its edge (the black around the map's
 * diamond in the block-out) is cleared, with a soft edge.
 */
async function clipToMap(rgb: Buffer, scene: Scene, scale = 1): Promise<Buffer> {
  const lum = await sharp(scene.png).removeAlpha().greyscale().toColourspace("b-w").raw().toBuffer();
  const inside = Buffer.alloc(scene.width * scene.height);
  for (let k = 0; k < inside.length; k++) inside[k] = lum[k]! > 6 ? 255 : 0;
  const W = scene.width * scale, H = scene.height * scale;
  const alpha = await sharp(inside, { raw: { width: scene.width, height: scene.height, channels: 1 } }).resize(W, H).blur(1.5).extractChannel(0).raw().toBuffer();
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

/**
 * Double a painting's resolution with the upscaler (SeedVR2 adds real detail), in overlapping tiles blended
 * across narrow seams. High-density screens then show it pixel for pixel.
 */
export async function upscaleTiled(png: Buffer, F: number, seed: number, report?: (m: string) => void): Promise<Buffer | null> {
  const g = genai();
  const { data: rgba, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, OW = W * F, OH = H * F;
  const TW = Math.min(W, Math.round(3200 / F)), TH = Math.min(H, Math.round(1920 / F)), OV = Math.round(192 / F);
  const starts = (total: number, size: number) => {
    const out: number[] = [];
    for (let v = 0; ; v += size - OV) {
      out.push(Math.min(v, total - size));
      if (v + size >= total) break;
    }
    return out;
  };
  const acc = new Float32Array(OW * OH * 3), wsum = new Float32Array(OW * OH);
  let n = 0;
  const xs = starts(W, TW), ys = starts(H, TH);
  for (const y0 of ys)
    for (const x0 of xs) {
      report?.(`Sharpening: tile ${++n} of ${xs.length * ys.length}`);
      const tile = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract({ left: x0, top: y0, width: TW, height: TH }).removeAlpha().png().toBuffer();
      const up = await g.upscale('image.texture', tile, F, seed);
      if (!up) return null;
      const px = await sharp(up).resize(TW * F, TH * F).removeAlpha().raw().toBuffer();
      const band = 16 * F, start = (OV * F) / 2 - band / 2;
      for (let y = 0; y < TH * F; y++)
        for (let x = 0; x < TW * F; x++) {
          const r = (d: number) => Math.max(0, Math.min(1, (d - start) / band));
          let a = 1;
          if (x0 > 0) a = Math.min(a, r(x));
          if (x0 + TW < W) a = Math.min(a, r(TW * F - 1 - x));
          if (y0 > 0) a = Math.min(a, r(y));
          if (y0 + TH < H) a = Math.min(a, r(TH * F - 1 - y));
          if (!a) continue;
          const k = (y0 * F + y) * OW + x0 * F + x, t = y * TW * F + x;
          wsum[k]! += a;
          for (let c = 0; c < 3; c++) acc[k * 3 + c]! += px[t * 3 + c]! * a;
        }
    }
  const out = Buffer.alloc(OW * OH * 3);
  for (let k = 0; k < OW * OH; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = Math.round(acc[k * 3 + c]! / Math.max(1e-6, wsum[k]!));
  // The map's outline (alpha) is kept from the original.
  const alpha = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extractChannel(3).resize(OW, OH).extractChannel(0).raw().toBuffer();
  return sharp(out, { raw: { width: OW, height: OH, channels: 3 } }).joinChannel(alpha, { raw: { width: OW, height: OH, channels: 1 } }).png().toBuffer();
}

/** Double a painting's resolution (see upscaleTiled). */
export const upscale2x = (png: Buffer, seed: number, report?: (m: string) => void) => upscaleTiled(png, 2, seed, report);

/** Paint a place: the painting at game scale, and the scene it was painted from. */
export async function paintPlace(w: WorldDefinition, z: ZoneDef, o: PaintOptions = {}): Promise<{ painting: Buffer; scene: Scene; scale: number; brief?: string }> {
  const g = genai();
  const seed = o.seed ?? 7;
  const scene = await renderScene(w, z, { props: 'all', ids: true, flatGround: true });
  // The art director's brief for this place (written once, kept with the painting for repaints).
  const brief = o.prompt ? undefined : o.brief ?? (g.isProcedural('world.design') ? undefined : await writePaintBrief(w, z, o.guidance));
  if (brief) o.report?.(`Art direction: ${brief.slice(0, 200)}…`);
  const base = o.prompt ?? scenePrompt(w, z, brief);
  const dbg = async (name: string, png: Buffer) => {
    if (o.debugPrefix) fs.writeFileSync(`${o.debugPrefix}-${name}.png`, png);
  };

  // 1. The whole place at once: its design, colours and light.
  const whole = fit(scene.width, scene.height, (o.mp ?? 2.9) * 1_000_000);
  const block = await sharp(scene.png).resize(whole.width, whole.height).png().toBuffer();
  await dbg('block', block);
  o.report?.(`Painting ${z.name} as a whole (${whole.width}x${whole.height})`);
  // Starting from the block-out itself (not from noise) pins every wall and object to its exact pixels; the
  // strength still leaves the painter free to restyle everything and invent the surfaces.
  const guideMask = await sharp({ create: { width: whole.width, height: whole.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const guideRaw = await g.image('image.texture', { prompt: base, width: whole.width, height: whole.height, references: [block], init: block, mask: guideMask, denoise: o.guideStrength ?? 1, seed });
  let guideSmall: Buffer = await sharp(guideRaw).resize(whole.width, whole.height).png().toBuffer();
  // The painter may still scale or nudge the scene a little: measure it against the block-out and undo it.
  const drift = await measureAlignment(block, guideSmall);
  o.report?.(`Alignment: scale ${drift.scale}, offset ${drift.dx},${drift.dy}`);
  guideSmall = Buffer.from(await realign(guideSmall, drift));
  guideSmall = Buffer.from(await registerLocal(block, guideSmall, o.report));
  await dbg('guide', guideSmall);
  // Without a detail pass: one upscale straight from the painter's size to twice the game's resolution.
  if (!o.detail && o.sharpen !== false) {
    const F = Math.max(2, Math.min(4, Math.ceil(2 / whole.sc)));
    const up = await upscaleTiled(guideSmall, F, seed, o.report);
    if (up) {
      const rgb = await sharp(up).resize(scene.width * 2, scene.height * 2).removeAlpha().raw().toBuffer();
      return { painting: await clipToMap(rgb, scene, 2), scene, scale: 2, brief };
    }
  }
  let guide = await sharp(guideSmall).resize(scene.width, scene.height, { kernel: 'lanczos3' }).png().toBuffer();
  const up = whole.sc < 1 ? await g.upscale('image.texture', guideSmall, Math.min(4, Math.ceil(1 / whole.sc)), seed) : null;
  if (up) guide = await sharp(up).resize(scene.width, scene.height).png().toBuffer();
  await dbg('guide-up', guide);
  if (!o.detail) return { painting: await clipToMap(await sharp(guide).removeAlpha().raw().toBuffer(), scene), scene, scale: 1, brief };

  // 2. Detail: tiles painted at full game scale, one after another, as outpainting. Pixels finished by earlier
  // tiles are locked (mask 0, with a short ramp) so each tile continues its neighbours' colours and materials;
  // the rest is painted afresh (mask 1) from its part of the whole painting and its block-out. Each new part is
  // pulled onto the whole painting (registration) and given its tones; the upscaler then runs over the result.
  const sw = Math.min(scene.width, o.section?.width ?? 1344), sh = Math.min(scene.height, o.section?.height ?? 768);
  const overlap = 192, RAMP = 48;
  const starts = (total: number, size: number) => {
    const out: number[] = [];
    for (let v = 0; ; v += size - overlap) {
      out.push(Math.min(v, total - size));
      if (v + size >= total) break;
    }
    return out;
  };
  const xs = starts(scene.width, sw), ys = starts(scene.height, sh);
  const canvas = Buffer.from(await sharp(guide).removeAlpha().raw().toBuffer());
  const done = new Uint8Array(scene.width * scene.height);
  const lum = await sharp(scene.png).removeAlpha().greyscale().toColourspace("b-w").raw().toBuffer();
  const pf = fit(sw, sh);
  let n = 0;
  for (const y0 of ys)
    for (const x0 of xs) {
      let lit = 0, all = 0;
      for (let y = y0; y < y0 + sh; y += 8) for (let x = x0; x < x0 + sw; x += 8) (all++, lum[y * scene.width + x]! > 8 && lit++);
      if (lit < all * 0.05) continue;
      n++;
      o.report?.(`Painting ${z.name} in detail: tile ${n}`);
      // How open each pixel is: 0 where an earlier tile finished it, rising to 1 over RAMP pixels.
      const dist = new Float32Array(sw * sh).fill(RAMP);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (done[(y0 + y) * scene.width + x0 + x]) dist[y * sw + x] = 0;
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const k = y * sw + x;
          if (x) dist[k] = Math.min(dist[k]!, dist[k - 1]! + 1);
          if (y) dist[k] = Math.min(dist[k]!, dist[k - sw]! + 1);
        }
      for (let y = sh - 1; y >= 0; y--)
        for (let x = sw - 1; x >= 0; x--) {
          const k = y * sw + x;
          if (x < sw - 1) dist[k] = Math.min(dist[k]!, dist[k + 1]! + 1);
          if (y < sh - 1) dist[k] = Math.min(dist[k]!, dist[k + sw]! + 1);
        }
      const open = (t: number) => Math.min(1, dist[t]! / RAMP);
      const region = { left: x0, top: y0, width: sw, height: sh };
      const initRaw = Buffer.alloc(sw * sh * 3), maskRaw = Buffer.alloc(sw * sh);
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const k = (y0 + y) * scene.width + x0 + x, t = y * sw + x;
          for (let c = 0; c < 3; c++) initRaw[t * 3 + c] = canvas[k * 3 + c]!;
          maskRaw[t] = Math.round(open(t) * 255);
        }
      const init = await sharp(initRaw, { raw: { width: sw, height: sh, channels: 3 } }).resize(pf.width, pf.height).png().toBuffer();
      const mask = await sharp(maskRaw, { raw: { width: sw, height: sh, channels: 1 } }).resize(pf.width, pf.height).png().toBuffer();
      const gCrop = await sharp(guide).extract(region).removeAlpha().png().toBuffer();
      const gd = await sharp(gCrop).resize(pf.width, pf.height).png().toBuffer();
      const bl = await sharp(scene.png).extract(region).resize(pf.width, pf.height).png().toBuffer();
      const raw = await g.image('image.texture', { prompt: SECTION_PROMPT(w.concept.artStyle), width: pf.width, height: pf.height, references: [gd, bl], init, mask, seed: seed + n * 101 });
      let tile: Buffer = await sharp(raw).resize(sw, sh).removeAlpha().png().toBuffer();
      tile = Buffer.from(await registerLocal(gCrop, tile));
      const t3 = await sharp(tile).removeAlpha().raw().toBuffer();
      const lowT = await sharp(t3, { raw: { width: sw, height: sh, channels: 3 } }).blur(16).raw().toBuffer();
      const lowG = await sharp(gCrop).removeAlpha().blur(16).raw().toBuffer();
      await dbg(`tile${n}`, tile);
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const t = y * sw + x, k = (y0 + y) * scene.width + x0 + x;
          const a = open(t);
          if (a > 0) for (let c = 0; c < 3; c++) canvas[k * 3 + c] = Math.round(canvas[k * 3 + c]! * (1 - a) + Math.max(0, Math.min(255, t3[t * 3 + c]! + lowG[t * 3 + c]! - lowT[t * 3 + c]!)) * a);
          done[k] = 1;
        }
    }
  const out = canvas;
  const painting = await clipToMap(out, scene);
  await dbg('final', painting);
  return { painting, scene, scale: 1, brief };
}

/**
 * Cut every wall and standing thing out of the painting by its silhouette (from the scene's id map, grown by a
 * couple of pixels into bare ground so a slightly shifted painted object is caught whole), packed into an atlas.
 */
export async function cutOccluders(painting: Buffer, scene: Scene, scale = 1): Promise<{ atlas: Buffer; pieces: number[][] }> {
  const W = scene.width * scale, H = scene.height * scale;
  const ids = scale === 1 ? scene.ids! : await sharp(scene.ids!, { raw: { width: scene.width, height: scene.height, channels: 3 } }).resize(W, H, { kernel: 'nearest' }).raw().toBuffer();
  const owner = new Int32Array(W * H).fill(-1);
  const box = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let k = 0; k < W * H; k++) {
    const id = ((ids[k * 3]! << 16) | (ids[k * 3 + 1]! << 8) | ids[k * 3 + 2]!) - 1;
    if (id < 0) continue;
    owner[k] = id;
    const x = k % W, y = (k / W) | 0;
    const b = box.get(id);
    if (!b) box.set(id, { x0: x, y0: y, x1: x, y1: y });
    else (b.x0 = Math.min(b.x0, x)), (b.y0 = Math.min(b.y0, y)), (b.x1 = Math.max(b.x1, x)), (b.y1 = Math.max(b.y1, y));
  }
  const rgb = await sharp(painting).removeAlpha().raw().toBuffer();
  const GROW = 0, AW = 4096 * Math.min(2, scale);
  let cx = 0, cy = 0, rowH = 0;
  const pieces: number[][] = [];
  const parts: { input: Buffer; raw: { width: number; height: number; channels: 4 }; left: number; top: number }[] = [];
  const byId = new Map(scene.objects.map((ob) => [ob.id, ob]));
  // Tallest first packs the shelves tightly.
  for (const [id, b] of [...box].sort((p, q) => q[1].y1 - q[1].y0 - (p[1].y1 - p[1].y0))) {
    const ob = byId.get(id);
    if (!ob) continue;
    const x0 = Math.max(0, b.x0 - GROW), y0 = Math.max(0, b.y0 - GROW), x1 = Math.min(W - 1, b.x1 + GROW), y1 = Math.min(H - 1, b.y1 + GROW);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = (y0 + y) * W + (x0 + x);
        let mine = owner[k] === id;
        if (!mine && owner[k] === -1)
          for (let dy = -GROW; dy <= GROW && !mine; dy++)
            for (let dx = -GROW; dx <= GROW && !mine; dx++) {
              const xx = x0 + x + dx, yy = y0 + y + dy;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H && owner[yy * W + xx] === id) mine = true;
            }
        if (!mine) continue;
        const q = (y * w + x) * 4;
        data[q] = rgb[k * 3]!;
        data[q + 1] = rgb[k * 3 + 1]!;
        data[q + 2] = rgb[k * 3 + 2]!;
        data[q + 3] = 255;
      }
    if (cx + w > AW) (cx = 0), (cy += rowH + 1), (rowH = 0);
    parts.push({ input: data, raw: { width: w, height: h, channels: 4 }, left: cx, top: cy });
    pieces.push([ob.x, ob.y, Math.round(ob.depth * 100) / 100, ob.kind === 'wall' ? 0 : 1, ob.size, cx, cy, w, h, x0, y0]);
    cx += w + 1;
    rowH = Math.max(rowH, h);
  }
  const atlas = await sharp({ create: { width: AW, height: Math.max(1, cy + rowH), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
  return { atlas, pieces };
}

/**
 * How a painting sits on its block-out: the scale and offset (in painting pixels) that best line up their edges.
 * A painting that matches its block-out gives scale 1 and offset 0.
 */
export async function measureAlignment(block: Buffer, painting: Buffer): Promise<{ scale: number; dx: number; dy: number; score: number }> {
  const meta = await sharp(block).metadata();
  const W = Math.round(meta.width! / 4), H = Math.round(meta.height! / 4);
  const edges = async (png: Buffer) => {
    const { data } = await sharp(png).removeAlpha().resize(W, H).greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    const e = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        const gx = data[k + 1]! - data[k - 1]!, gy = data[k + W]! - data[k - W]!;
        e[k] = Math.min(255, Math.hypot(gx, gy));
      }
    return e;
  };
  const a = await edges(block), b = await edges(painting);
  let best = { scale: 1, dx: 0, dy: 0, score: -Infinity };
  // Compare on a sparse grid of the block-out's strong edges (fast enough to search scale and offset).
  const pts: number[] = [];
  for (let y = 4; y < H - 4; y += 2) for (let x = 4; x < W - 4; x += 2) if (a[y * W + x]! > 40) pts.push(x, y);
  for (let si = -20; si <= 20; si++)
    for (let dy = -20; dy <= 20; dy++)
      for (let dx = -20; dx <= 20; dx++) {
        const sc = 1 + si * 0.005;
        let sum = 0;
        for (let i = 0; i < pts.length; i += 2) {
          // Where the block-out's point lands in the painting: scaled about the centre, then shifted.
          const x = Math.round((pts[i]! - W / 2) * sc + W / 2 + dx), y = Math.round((pts[i + 1]! - H / 2) * sc + H / 2 + dy);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          sum += b[y * W + x]!;
        }
        // Ties go to the smallest change (thick edges match several neighbouring scales equally well).
        sum *= 1 - 0.3 * Math.abs(sc - 1) - 0.0005 * Math.hypot(dx, dy);
        if (sum > best.score) best = { scale: Math.round(sc * 1000) / 1000, dx: dx * 4, dy: dy * 4, score: sum };
      }
  return best;
}

/** Undo a measured scale and offset, so the painting lies exactly on its block-out (same size out). */
export async function realign(painting: Buffer, a: { scale: number; dx: number; dy: number }): Promise<Buffer> {
  const m = await sharp(painting).metadata();
  const W = m.width!, H = m.height!;
  if (Math.abs(a.scale - 1) < 0.003 && !a.dx && !a.dy) return painting;
  // A block-out point p shows up in the painting at s(p - c) + c + d; shrink by s and shift it back.
  const rw = Math.round(W / a.scale), rh = Math.round(H / a.scale);
  const resized = await sharp(painting).resize(rw, rh).png().toBuffer();
  const ox = Math.round(W / 2 - (W / 2 + a.dx) / a.scale), oy = Math.round(H / 2 - (H / 2 + a.dy) / a.scale);
  // Place it on a canvas the original size (cropping what falls outside).
  const l = Math.max(0, -ox), t = Math.max(0, -oy);
  const piece = await sharp(resized).extract({ left: l, top: t, width: Math.min(rw - l, W - Math.max(0, ox)), height: Math.min(rh - t, H - Math.max(0, oy)) }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } }).composite([{ input: piece, left: Math.max(0, ox), top: Math.max(0, oy) }]).png().toBuffer();
}

/**
 * Pull a painting onto its block-out where it drifted locally: the best offset of each patch (by matching
 * edges), smoothed into a displacement field, then every pixel moved back by it.
 */
export async function registerLocal(block: Buffer, painting: Buffer, report?: (m: string) => void): Promise<Buffer> {
  const m = await sharp(painting).metadata();
  const W = m.width!, H = m.height!;
  const S = 2; // matching runs at half resolution
  const w = Math.round(W / S), h = Math.round(H / S);
  const edges = async (png: Buffer) => {
    const data = await sharp(png).removeAlpha().resize(w, h).greyscale().toColourspace('b-w').raw().toBuffer();
    const e = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        e[k] = Math.min(255, Math.hypot(data[k + 1]! - data[k - 1]!, data[k + w]! - data[k - w]!));
      }
    return e;
  };
  const a = await edges(block), b = await edges(painting);
  const CELL = 48, WIN = 40, R = 14;
  const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
  const fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh), conf = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const cx = Math.min(w - 1, gx * CELL + CELL / 2), cy = Math.min(h - 1, gy * CELL + CELL / 2);
      // The block-out's strong edges in this patch.
      const pts: number[] = [];
      for (let y = Math.max(R, cy - WIN); y < Math.min(h - R, cy + WIN); y += 2)
        for (let x = Math.max(R, cx - WIN); x < Math.min(w - R, cx + WIN); x += 2) if (a[y * w + x]! > 30) pts.push(x, y);
      if (pts.length < 40) continue;
      let best = -1, bx = 0, by = 0, zero = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          let sum = 0;
          for (let i = 0; i < pts.length; i += 2) sum += b[(pts[i + 1]! + dy) * w + pts[i]! + dx]!;
          // A slight preference for small moves, so flat patches do not wander.
          sum *= 1 - 0.002 * Math.hypot(dx, dy);
          if (!dx && !dy) zero = sum;
          if (sum > best) (best = sum), (bx = dx), (by = dy);
        }
      const k = gy * gw + gx;
      fx[k] = bx * S;
      fy[k] = by * S;
      conf[k] = best > 0 ? Math.max(0.05, 1 - zero / best + 0.2) * Math.min(1, pts.length / 200) : 0;
    }
  // Smooth the field (confidence-weighted), filling patches without edges from their neighbours.
  const smooth = (src: Float32Array) => {
    let cur = src.slice();
    for (let it = 0; it < 6; it++) {
      const next = new Float32Array(gw * gh);
      for (let gy = 0; gy < gh; gy++)
        for (let gx = 0; gx < gw; gx++) {
          let sum = 0, wsum = 0;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const x = gx + ox, y = gy + oy;
              if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
              const wt = conf[y * gw + x]! * (ox || oy ? 0.6 : 1) + 1e-4;
              sum += cur[y * gw + x]! * wt;
              wsum += wt;
            }
          next[gy * gw + gx] = sum / wsum;
        }
      cur = next;
    }
    return cur;
  };
  const sx = smooth(fx), sy = smooth(fy);
  let maxShift = 0;
  for (let k = 0; k < gw * gh; k++) maxShift = Math.max(maxShift, Math.hypot(sx[k]!, sy[k]!));
  report?.(`Local alignment: largest correction ${maxShift.toFixed(0)} px`);
  // Warp: each output pixel takes the painting's pixel where the block-out's content drifted to.
  const { data: src } = await sharp(painting).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(W * H * 4);
  const field = (f: Float32Array, x: number, y: number) => {
    const u = Math.max(0, Math.min(gw - 1.001, x / S / CELL - 0.5)), v = Math.max(0, Math.min(gh - 1.001, y / S / CELL - 0.5));
    const x0 = Math.floor(u), y0 = Math.floor(v), tx = u - x0, ty = v - y0;
    const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    return f[y0 * gw + x0]! * (1 - tx) * (1 - ty) + f[y0 * gw + x1]! * tx * (1 - ty) + f[y1 * gw + x0]! * (1 - tx) * ty + f[y1 * gw + x1]! * tx * ty;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = Math.max(0, Math.min(W - 1.001, x + field(sx, x, y))), py = Math.max(0, Math.min(H - 1.001, y + field(sy, x, y)));
      const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = src[(y0 * W + x0) * 4 + c]!, v10 = src[(y0 * W + x0 + 1) * 4 + c]!, v01 = src[((y0 + 1) * W + x0) * 4 + c]!, v11 = src[((y0 + 1) * W + x0 + 1) * 4 + c]!;
        out[o + c] = Math.round(v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty);
      }
    }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
