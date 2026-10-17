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
/** How visible the wrap-around seam is: edge mismatch relative to ordinary neighbouring-pixel differences. */
export function seamRatio(data: Buffer, w: number, h: number, ch: number): number {
  const px = (x: number, y: number, k: number) => data[(y * w + x) * ch + k]!;
  let edge = 0, inner = 0;
  const mx = w >> 1, my = h >> 1;
  for (let i = 0; i < Math.min(w, h); i++)
    for (let k = 0; k < 3; k++) {
      edge += Math.abs(px(0, i, k) - px(w - 1, i, k)) + Math.abs(px(i, 0, k) - px(i, h - 1, k));
      inner += Math.abs(px(mx - 1, i, k) - px(mx, i, k)) + Math.abs(px(i, my - 1, k) - px(i, my, k));
    }
  return edge / Math.max(1, inner);
}

/**
 * Make a texture tile seamlessly. Models that tile natively are kept as they are; small seams get a narrow
 * edge-only blend, and only clearly visible seams get the wide half-offset blend (which can ghost).
 */
export async function makeSeamless(input: Buffer, size = 256): Promise<Buffer> {
  const { data, info } = await sharp(input).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const ratio = seamRatio(data, w, h, ch);
  if (ratio <= 1.5) return sharp(data, { raw: { width: w, height: h, channels: ch as 3 } }).png().toBuffer();
  const out = Buffer.alloc(data.length);
  const feather = ratio <= 3 ? 0.1 : 0.32;
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

const CRITERIA: Record<AssetRecord['kind'], string> = {
  texture: 'a flat, evenly lit, top-down surface texture that could tile; no objects, people, text, borders or perspective.',
  sprite: 'exactly one full-body character or creature, fully visible (not cut off), clean silhouette, no text, no extra characters, no scenery.',
  object: 'exactly one object, fully visible, clean silhouette, no text, no scenery.',
  icon: 'exactly one clearly readable item centered, no text, no hands, no scenery.',
  portrait: 'a single character portrait, face clearly visible, no text.',
};

const LEVELS = ['unusable', 'poor', 'mediocre', 'acceptable', 'good', 'excellent'];

/** Score an image 0-10 with the configured checker: a decision model (fast, probabilistic) or a vision LLM. */
export async function qualityCheck(png: Buffer, kind: AssetRecord['kind'], description: string): Promise<{ score: number; problems: string[] } | null> {
  const g = genai();
  if (g.isProcedural('image.check')) return null;
  const preview = await sharp(png).flatten({ background: '#7f7f7f' }).resize(512, 512, { fit: 'inside' }).png().toBuffer();
  try {
    if (g.isDecision('image.check')) {
      const isTex = kind === 'texture';
      const a = await g.decide('image.check', {
        state: `A generated game asset. It should depict: "${description}". Requirements: ${CRITERIA[kind]}`,
        images: [preview],
        questions: {
          quality: { type: 'score', instructions: 'How usable is this image as a polished game asset?', criteria: LEVELS },
          match: { type: 'score', instructions: 'How well does the image match the description?', criteria: LEVELS },
          ...(isTex
            ? { flat: { type: 'noul' as const, instructions: 'Is this a flat top-down surface texture with no objects, horizon or perspective?' } }
            : {
                single: { type: 'noul' as const, instructions: 'Does the image show exactly one subject?' },
                whole: { type: 'noul' as const, instructions: 'Is the whole subject visible, not cut off by the image edge?' },
              }),
          text: { type: 'noul', instructions: 'Does the image contain any text, letters, watermark or signature?' },
        },
      });
      const lvl = (k: string) => {
        const x = a[k];
        return x?.type === 'score' ? (x.score / (LEVELS.length - 1)) * 10 : 5;
      };
      const yes = (k: string) => {
        const x = a[k];
        return x?.type === 'noul' ? x.noul : 0.5;
      };
      const problems: string[] = [];
      let score = Math.min(lvl('quality'), lvl('match') + 1);
      const penalize = (cond: boolean, why: string) => {
        if (!cond) return;
        score -= 3;
        problems.push(why);
      };
      penalize(isTex && yes('flat') < 0.5, 'not a flat top-down texture');
      penalize(!isTex && yes('single') < 0.5, 'more than one subject');
      penalize(!isTex && yes('whole') < 0.5, 'subject cut off');
      penalize(yes('text') > 0.5, 'contains text');
      if (lvl('match') < 4) problems.push('does not match the description');
      return { score: Math.max(0, Math.min(10, score)), problems };
    }
    const r = await g.structured('image.check', {
      system: 'You are a strict art director reviewing generated game assets. Judge only what you see.',
      prompt: `This image should depict: "${description}".\nRequirements: ${CRITERIA[kind]}\nScore 0-10 for how usable this is as a game asset (10 = perfect, 6 = acceptable, below 5 = must regenerate). List concrete problems.`,
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

interface Candidate {
  img: ProcessedImage;
  score: number;
  problems: string[];
}

async function generateCandidate(rec: AssetRecord, style: string, worldSeed: string, attempt: number): Promise<ProcessedImage> {
  const g = genai();
  const pc = g.providerConfig(g.purpose(KIND_PURPOSE[rec.kind]).provider);
  let { prompt, negative } = buildPrompt(rec.kind, rec.prompt, style);
  if (pc.promptStyle === 'descriptive') {
    const para = rec.imagePrompt ?? describeFallback(rec, style);
    prompt = rec.kind === 'texture' ? para
      : pc.alpha === 'native' ? (pc.alphaPrompt ?? DEFAULT_ALPHA_PROMPT).replace('{prompt}', para)
      : `${para} The background is a single flat, even light grey with nothing else in it.`;
  }
  const raw = await g.image(KIND_PURPOSE[rec.kind], { prompt, negativePrompt: negative, seed: hashOf(worldSeed, rec.key, attempt) % 2147483647, transparent: rec.kind !== 'texture' });
  if (rec.kind === 'texture') return { png: await makeSeamless(raw, 256), width: 256, height: 256, problems: [] };
  return cutoutSprite(raw, rec.kind === 'icon' ? 128 : rec.kind === 'object' ? 224 : 256);
}

/**
 * Produce many assets in rounds: generate every pending image (image model resident), then score every
 * candidate (checker resident), then regenerate only the rejects. This keeps GPU model swaps to two per round.
 */
export async function produceAssets(
  recs: AssetRecord[],
  style: string,
  outDir: string,
  worldSeed: string,
  onDone: (rec: AssetRecord) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  const g = genai();
  const purposeOf = (r: AssetRecord) => KIND_PURPOSE[r.kind];
  const limit = (r: AssetRecord) => g.purpose(purposeOf(r)).maxAttempts ?? 3;
  const active = recs.filter((r) => !g.isProcedural(purposeOf(r)));
  for (const r of recs) if (g.isProcedural(purposeOf(r))) onDone({ ...r, status: 'skipped' });
  const best = new Map<string, Candidate>();
  const attempts = new Map<string, number>();
  const errors = new Map<string, string>();
  const finished = new Set<string>();
  const minScore = g.purpose('image.check').minScore ?? 6;
  const finish = (rec: AssetRecord) => {
    if (finished.has(rec.key)) return;
    finished.add(rec.key);
    const b = best.get(rec.key);
    if (!b) return onDone({ ...rec, status: 'failed', error: errors.get(rec.key), attempts: attempts.get(rec.key) });
    fs.mkdirSync(outDir, { recursive: true });
    const file = `${rec.key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
    fs.writeFileSync(path.join(outDir, file), b.img.png);
    onDone({ ...rec, status: 'ok', file, score: b.score, attempts: attempts.get(rec.key), width: b.img.width, height: b.img.height, anchorY: b.img.anchorY, error: b.score < minScore ? b.problems.join('; ') || undefined : undefined });
  };
  let pending = active;
  for (let round = 0; pending.length; round++) {
    // Phase 1: generate every pending asset while the image model is resident.
    const fresh: { rec: AssetRecord; img: ProcessedImage }[] = [];
    for (const rec of pending) {
      if (shouldStop?.()) return;
      attempts.set(rec.key, (attempts.get(rec.key) ?? 0) + 1);
      try {
        fresh.push({ rec, img: await generateCandidate(rec, style, worldSeed, round) });
      } catch (e) {
        errors.set(rec.key, (e as Error).message);
      }
    }
    // Phase 2: score every candidate while the checker is resident.
    for (const { rec, img } of fresh) {
      if (shouldStop?.()) return;
      const review = await qualityCheck(img.png, rec.kind, rec.prompt);
      const problems = [...img.problems, ...(review?.problems ?? [])];
      const score = review ? Math.min(review.score, img.problems.length ? 5 : 10) : img.problems.length ? 4 : 7;
      const prev = best.get(rec.key);
      if (!prev || score > prev.score) best.set(rec.key, { img, score, problems });
      if (score >= minScore && !img.problems.length) finish(rec);
    }
    // Out of attempts: keep the best try.
    for (const rec of pending) if (!finished.has(rec.key) && (attempts.get(rec.key) ?? 0) >= limit(rec)) finish(rec);
    pending = pending.filter((r) => !finished.has(r.key));
  }
}

/** Generate (or regenerate) one asset; writes the PNG and returns the updated record. */
export async function produceAsset(rec: AssetRecord, style: string, outDir: string, worldSeed: string): Promise<AssetRecord> {
  let out: AssetRecord = { ...rec, status: 'failed' };
  await produceAssets([rec], style, outDir, worldSeed, (r) => (out = r));
  return out;
}

// ------------------------------------------------------------------------------------ descriptive prompts

export const DEFAULT_ALPHA_PROMPT = 'This is an RGBA format image with transparency. {prompt} The image has an alpha channel and a transparent background.';

const BRIEF_FRAMING: Record<AssetRecord['kind'], string> = {
  texture: 'A seamless tileable surface texture seen straight from above (top-down orthographic), filling the whole square frame edge to edge with no objects, horizon, border, shadow or vignette; the pattern continues off every edge so tiles join invisibly.',
  sprite: 'A game character sprite: one full-body figure standing in a three-quarter view facing the viewer, centred, the entire figure visible from the top of the head to the soles of the feet with a little empty space around it, no ground, no scenery and no other figures.',
  object: 'A game prop: one object shown whole in a three-quarter isometric view, centred, with empty space around it, no ground, no scenery, no people.',
  icon: 'A game inventory icon: one item centred and shown whole, slightly angled, filling most of a square frame, no hands, no scenery.',
  portrait: 'A head-and-shoulders character portrait.',
};

/** Brief handed to the image.prompt LLM. */
export function assetBrief(rec: AssetRecord, style: string): string {
  return `${BRIEF_FRAMING[rec.kind]} Subject: ${rec.prompt}. Art style: ${style}.`;
}

/** Used when no LLM is available: a plain observer-style paragraph assembled from the brief. */
function describeFallback(rec: AssetRecord, style: string): string {
  const medium = rec.kind === 'texture' ? 'seamless top-down texture' : rec.kind === 'icon' ? 'game icon illustration' : 'game asset illustration';
  return `The image is a ${style} ${medium} of ${rec.prompt}. ${BRIEF_FRAMING[rec.kind]} The lighting is soft and even, coming from the upper left, with gentle shading that gives the forms volume. The overall composition is clean and readable, with a cohesive palette and a clear silhouette.`;
}

export const IMAGE_PROMPT_SYSTEM = `You write prompts for a text-to-image model that was trained on long descriptive captions. For each brief, describe the finished image as an observer would, in one English paragraph of 120 to 200 words, present tense, third person. Open with one sentence naming the medium, the art style, the subject and the background. Then describe the subject in order — for a figure: build, posture, face, hair, then each garment with its colour and material, then anything held and in which hand; for an object or surface: its shape, materials, colours and wear — using positional phrases (in the upper part of the frame, at the left hip, along the lower edge). Give the lighting its own sentence. End with one sentence about the overall composition, palette and mood. Respect every framing requirement in the brief. Name colours with modifiers (deep navy, muted olive) and materials precisely (weathered oak, brushed iron). No quality boosters, no instructions, no quotation marks, and no text, letters or signage in the image.`;
