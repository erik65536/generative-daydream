/**
 * Image pipeline: prompt -> generate -> post-process (seamless textures, background removal, trimming)
 * -> optional vision quality check -> retry with new seeds, keeping the best attempt.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { hashOf } from '@gd/shared';
import type { AssetRecord } from '@gd/shared';
import { genai } from './service';
import type { Purpose } from './types';

export interface ProcessedImage {
  png: Buffer;
  width: number;
  height: number;
  anchorY?: number;
  /** Automatic heuristic problems (no vision model needed). */
  problems: string[];
}

// ------------------------------------------------------------------------------------ textures

/** Make a texture tile seamlessly by blending it with a half-offset copy of itself near the edges. */
export async function makeSeamless(input: Buffer, size = 256): Promise<Buffer> {
  const { data, info } = await sharp(input).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const out = Buffer.alloc(data.length);
  const feather = 0.22;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Weight of the original (1 in the center, 0 at the edges).
      const ex = Math.min(x, w - 1 - x) / w, ey = Math.min(y, h - 1 - y) / h;
      const m = Math.min(1, Math.min(ex, ey) / feather);
      const wa = m * m * (3 - 2 * m);
      const sx = (x + w / 2) % w, sy = (y + h / 2) % h;
      const ia = (y * w + x) * ch, ib = (sy * w + sx) * ch;
      for (let c = 0; c < ch; c++) out[ia + c] = Math.round(data[ia + c]! * wa + data[ib + c]! * (1 - wa));
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: ch as 3 } }).png().toBuffer();
}

// ------------------------------------------------------------------------------------ sprites

/** Flood-fill the background from the borders and make it transparent, then trim. */
export async function cutoutSprite(input: Buffer, maxHeight = 256, tolerance = 34): Promise<ProcessedImage> {
  const base = sharp(input).ensureAlpha();
  const meta = await base.metadata();
  const scale = Math.min(1, 640 / Math.max(meta.width ?? 640, meta.height ?? 640));
  const { data, info } = await base
    .resize(Math.round((meta.width ?? 640) * scale), Math.round((meta.height ?? 640) * scale))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const px = (x: number, y: number) => (y * w + x) * 4;
  const alreadyTransparent = (() => {
    let t = 0;
    for (let x = 0; x < w; x++) if (data[px(x, 0) + 3]! < 20) t++;
    return t > w * 0.8;
  })();
  const bg = new Uint8Array(w * h);
  if (!alreadyTransparent) {
    // Background = the dominant border color clusters (so a subject touching an edge is not mistaken for it).
    const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
    const addSample = (x: number, y: number) => {
      const i = px(x, y);
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
      counts.set(k, e);
    };
    for (let x = 0; x < w; x += 2) { addSample(x, 0); addSample(x, h - 1); }
    for (let y = 0; y < h; y += 2) { addSample(0, y); addSample(w - 1, y); }
    const total = [...counts.values()].reduce((s2, e) => s2 + e.n, 0);
    const samples: [number, number, number][] = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .filter((e, i) => i === 0 || e.n / total > 0.12)
      .slice(0, 3)
      .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
    const near = (i: number) => {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      for (const s of samples) if (Math.abs(r - s[0]) + Math.abs(g - s[1]) + Math.abs(b - s[2]) < tolerance * 2.2) return true;
      return false;
    };
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      const k = y * w + x;
      if (bg[k]) return;
      if (!near(k * 4)) return;
      bg[k] = 1;
      stack.push(k);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % w, y = (k / w) | 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
    for (let k = 0; k < w * h; k++) if (bg[k]) data[k * 4 + 3] = 0;
    // Soften the edge: pixels next to background get partial alpha.
    const alpha = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) alpha[k] = data[k * 4 + 3]!;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        if (!alpha[k]) continue;
        let n = 0;
        if (bg[k - 1]) n++;
        if (bg[k + 1]) n++;
        if (bg[k - w]) n++;
        if (bg[k + w]) n++;
        if (n) data[k * 4 + 3] = Math.round(alpha[k]! * (1 - n * 0.2));
      }
  } else for (let k = 0; k < w * h; k++) bg[k] = data[k * 4 + 3]! < 20 ? 1 : 0;

  // Bounding box and heuristics.
  let minX = w, minY = h, maxX = -1, maxY = -1, fg = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[px(x, y) + 3]! > 40) {
        fg++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  const problems: string[] = [];
  if (maxX < 0) return { png: await sharp(input).png().toBuffer(), width: w, height: h, problems: ['no subject found'] };
  const frac = fg / (w * h);
  if (frac < 0.03) problems.push('subject too small');
  if (frac > 0.75) problems.push('background was not removed (subject fills the image)');
  let edgeTouch = 0;
  for (let y = 0; y < h; y++) {
    if (data[px(0, y) + 3]! > 40) edgeTouch++;
    if (data[px(w - 1, y) + 3]! > 40) edgeTouch++;
  }
  for (let x = 0; x < w; x++) if (data[px(x, 0) + 3]! > 40) edgeTouch++;
  let bottomTouch = 0;
  for (let x = 0; x < w; x++) if (data[px(x, h - 1) + 3]! > 40) bottomTouch++;
  if (edgeTouch > (w + h) * 0.08 || bottomTouch > w * 0.12) problems.push('subject is cut off by the image border');
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  const outH = Math.min(maxHeight, chh);
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: cw, height: chh })
    .resize({ height: outH, withoutEnlargement: true })
    .png()
    .toBuffer();
  const m2 = await sharp(png).metadata();
  return { png, width: m2.width ?? cw, height: m2.height ?? outH, anchorY: 0.97, problems };
}

// ------------------------------------------------------------------------------------ quality check

const QualitySchema = z.object({
  score: z.coerce.number().min(0).max(10),
  matchesDescription: z.boolean(),
  problems: z.array(z.string()).max(6),
});

export async function qualityCheck(png: Buffer, kind: AssetRecord['kind'], description: string): Promise<{ score: number; problems: string[] } | null> {
  const g = genai();
  if (g.isProcedural('image.check')) return null;
  const preview = await sharp(png).flatten({ background: '#7f7f7f' }).resize(512, 512, { fit: 'inside' }).png().toBuffer();
  const criteria: Record<AssetRecord['kind'], string> = {
    texture: 'a flat, evenly lit, top-down surface texture that could tile; no objects, people, text, borders or perspective.',
    sprite: 'exactly one full-body character or creature, fully visible (not cut off), clean silhouette, no text, no extra characters, no scenery.',
    object: 'exactly one object, fully visible, clean silhouette, no text, no scenery.',
    icon: 'exactly one clearly readable item centered, no text, no hands, no scenery.',
    portrait: 'a single character portrait, face clearly visible, no text.',
  };
  try {
    const r = await g.structured('image.check', {
      system: 'You are a strict art director reviewing generated game assets. Judge only what you see.',
      prompt: `This image should depict: "${description}".\nRequirements: ${criteria[kind]}\nScore 0-10 for how usable this is as a game asset (10 = perfect, 6 = acceptable, below 5 = must regenerate). List concrete problems.`,
      schema: QualitySchema,
      name: 'image_review',
      images: [preview],
      maxTokens: 400,
    });
    return { score: r.score, problems: r.problems };
  } catch (e) {
    console.warn('[images] quality check failed:', (e as Error).message);
    return null;
  }
}

// ------------------------------------------------------------------------------------ orchestration

const KIND_PURPOSE: Record<AssetRecord['kind'], Purpose> = {
  texture: 'image.texture',
  sprite: 'image.sprite',
  object: 'image.sprite',
  icon: 'image.icon',
  portrait: 'image.sprite',
};

export function buildPrompt(kind: AssetRecord['kind'], subject: string, style: string): { prompt: string; negative: string } {
  switch (kind) {
    case 'texture':
      return { prompt: `${subject}, seamless tileable texture, top-down orthographic view, flat even lighting, no shadows, highly detailed surface, ${style}`, negative: 'perspective, horizon, objects, people, text, frame, border, vignette' };
    case 'sprite':
      return { prompt: `${subject}, single full body character standing, three-quarter view facing the viewer, entire figure visible from head to feet, centered, isolated on a plain flat light gray background, game character sprite, ${style}`, negative: 'cropped, cut off, multiple characters, scenery, background details, text, watermark, frame' };
    case 'object':
      return { prompt: `${subject}, single object, entire object visible, three-quarter isometric view, centered, isolated on a plain flat light gray background, game asset, ${style}`, negative: 'cropped, multiple objects, scenery, people, text, watermark, frame' };
    case 'icon':
      return { prompt: `${subject}, single item, centered, game inventory icon, isolated on a plain flat light gray background, ${style}`, negative: 'hands, people, multiple items, text, watermark, frame, scenery' };
    case 'portrait':
      return { prompt: `${subject}, head and shoulders portrait, ${style}`, negative: 'text, watermark, multiple people' };
  }
}

/** Generate (or regenerate) one asset; writes the PNG and returns the updated record. */
export async function produceAsset(rec: AssetRecord, style: string, outDir: string, worldSeed: string): Promise<AssetRecord> {
  const g = genai();
  const purpose = KIND_PURPOSE[rec.kind];
  if (g.isProcedural(purpose)) return { ...rec, status: 'skipped' };
  const pc = g.purpose(purpose);
  const check = g.purpose('image.check');
  const maxAttempts = pc.maxAttempts ?? 3;
  const minScore = check.minScore ?? 6;
  const { prompt, negative } = buildPrompt(rec.kind, rec.prompt, style);
  let best: { img: ProcessedImage; score: number } | null = null;
  let lastError: string | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      const raw = await g.image(purpose, {
        prompt,
        negativePrompt: negative,
        seed: hashOf(worldSeed, rec.key, attempt) % 2147483647,
        transparent: rec.kind !== 'texture',
      });
      let img: ProcessedImage;
      if (rec.kind === 'texture') {
        const png = await makeSeamless(raw, 256);
        img = { png, width: 256, height: 256, problems: [] };
      } else {
        img = await cutoutSprite(raw, rec.kind === 'icon' ? 128 : rec.kind === 'object' ? 224 : 256);
      }
      let score = img.problems.length ? 4 : 7;
      const review = await qualityCheck(img.png, rec.kind, rec.prompt);
      if (review) score = Math.min(review.score, img.problems.length ? 5 : 10);
      if (!best || score > best.score) best = { img, score };
      if (score >= minScore && !img.problems.length) break;
      lastError = [...img.problems, ...(review?.problems ?? [])].join('; ');
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  if (!best) return { ...rec, status: 'failed', error: lastError, attempts };
  fs.mkdirSync(outDir, { recursive: true });
  const file = `${rec.key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  fs.writeFileSync(path.join(outDir, file), best.img.png);
  return { ...rec, status: 'ok', file, score: best.score, attempts, width: best.img.width, height: best.img.height, anchorY: best.img.anchorY, error: best.score < minScore ? lastError : undefined };
}
