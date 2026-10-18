/**
 * Image pipeline: prompt -> generate -> post-process (seamless textures, matte cleanup, trimming)
 * -> vision quality check -> retry with new seeds, keeping the best attempt. Variants (pose frames, an open
 * chest) are painted from the approved base image as a reference, so they stay the same character or object.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { hashOf } from '@gd/shared';
import type { AssetRecord } from '@gd/shared';
import { genai } from './service';
import type { Purpose } from './types';
import { inspectionImages, inspectionView, processSprite, referenceFrame, type ProcessedImage } from './matte';
import { profileFor, type AssetKind, type PromptProfile } from './promptprofiles';
import { paintWalkStrip, stripFrame } from './poses';

export type { ProcessedImage };
export { processSprite as cutoutSprite };

// ------------------------------------------------------------------------------------ textures

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
  const feather = ratio <= 3 ? 0.1 : 0.28;
  const smooth = (e: number) => {
    const m = Math.min(1, e / feather);
    return m * m * (3 - 2 * m);
  };
  // Blend each axis on its own (first across the vertical seam, then the horizontal one), so the
  // transition bands stay straight instead of forming the diagonal cross a joint blend leaves.
  const pass = (src: Buffer, horizontal: boolean): Buffer => {
    const out = Buffer.alloc(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const e = horizontal ? Math.min(x, w - 1 - x) / w : Math.min(y, h - 1 - y) / h;
        const wa = smooth(e);
        const sx = horizontal ? (x + w / 2) % w : x, sy = horizontal ? y : (y + h / 2) % h;
        const ia = (y * w + x) * ch, ib = (sy * w + sx) * ch;
        for (let c = 0; c < ch; c++) out[ia + c] = Math.round(src[ia + c]! * wa + src[ib + c]! * (1 - wa));
      }
    return out;
  };
  const out = pass(pass(data, true), false);
  return sharp(out, { raw: { width: w, height: h, channels: ch as 3 } }).png().toBuffer();
}

/**
 * How differently a texture's centre and border read (mean brightness): continuous surfaces score near zero, a
 * pit or panel with a rim, or a corridor drawn in perspective, scores high.
 */
export async function framedness(png: Buffer): Promise<number> {
  const { data } = await sharp(png).resize(64, 64).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let c = 0, cn = 0, e = 0, en = 0;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 3;
      const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      const d = Math.min(x, y, 63 - x, 63 - y);
      if (d < 7) (e += l), en++;
      else if (d >= 16) (c += l), cn++;
    }
  return Math.abs(c / cn - e / en);
}

/**
 * Very dark surfaces read as holes on a dark map, and their sheen and ripples vanish. Lift them with a gamma
 * curve to a readable brightness, which brings out the detail they already have (the colours stay).
 */
export async function liftDark(png: Buffer, target = 52): Promise<Buffer> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 3) sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  const mean = sum / (data.length / 3);
  if (mean >= target * 0.6) return png;
  const g = Math.log(target / 255) / Math.log(Math.max(2, mean) / 255);
  const lut = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * Math.pow(v / 255, g)));
  for (let i = 0; i < data.length; i++) data[i] = lut[data[i]!]!;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

/** A 2x2 tiling of a texture so the checker can see seams and repetition. */
async function tiledPreview(png: Buffer): Promise<Buffer> {
  const t = await sharp(png).resize(256, 256).png().toBuffer();
  return sharp({ create: { width: 512, height: 512, channels: 3, background: '#000' } })
    .composite([{ input: t, left: 0, top: 0 }, { input: t, left: 256, top: 0 }, { input: t, left: 0, top: 256 }, { input: t, left: 256, top: 256 }])
    .png()
    .toBuffer();
}

// ------------------------------------------------------------------------------------ variants

/** What changes in each variant, painted from the base image as a reference. */
export const VARIANTS: Record<string, { kinds: AssetKind[]; change: string }> = {
  walk: { kinds: ['sprite'], change: 'walking toward the left (an eight-frame walk cycle guided by pose skeletons)' },
  walk_a: { kinds: ['sprite'], change: 'walking, caught mid-stride with the left leg reaching far forward and the right leg pushing off far behind, the arms swinging in opposition' },
  walk_b: { kinds: ['sprite'], change: 'walking, caught mid-stride with the right leg reaching far forward and the left leg pushing off far behind, the arms swinging in opposition' },
  attack: { kinds: ['sprite'], change: 'in the middle of a powerful attack, lunging forward and striking with whatever weapon, claws or power they carry, the body twisted into the blow' },
  open: { kinds: ['object'], change: 'opened: its lid or door swung fully open, revealing the inside' },
};

/** Key of a variant of an asset ("spr_npc_x@walk_a"). */
export const variantKey = (baseKey: string, variant: string) => `${baseKey}@${variant}`;

// ------------------------------------------------------------------------------------ quality check

const QualitySchema = z.object({
  score: z.coerce.number().min(0).max(10),
  matchesDescription: z.boolean(),
  problems: z.array(z.string()).max(6),
});

const CRITERIA: Record<AssetKind, string> = {
  texture: 'a flat, evenly lit, top-down surface texture that tiles; no objects, people, text, borders or perspective.',
  sprite: 'exactly one full-body character or creature, fully visible (not cut off), clean silhouette, well lit and readable, no text, no extra characters, no scenery, no fog, glow or ground around it.',
  object: 'exactly one object, fully visible, clean silhouette, well lit and readable, no text, no scenery, no fog, glow or ground around it.',
  icon: 'exactly one clearly readable item centered, no text, no hands, no scenery.',
  portrait: 'a single character portrait, face clearly visible, no text.',
};

/** Quality levels, each with what it means for a game asset (checkers calibrate on the descriptions). */
const LEVELS = [
  'unusable: broken, garbled, the wrong subject, or unreadable at game size',
  'poor: clear defects such as artefacts, wrong framing, missing parts or leftover background',
  'mediocre: usable but with noticeable flaws',
  'acceptable: fits the game, only minor flaws',
  'good: clean, readable, well made game art that fits its description',
  'excellent: polished, professional game art',
];
const MATCH_LEVELS = [
  'unrelated: shows something else',
  'barely: a few elements of the description',
  'partly: the right kind of thing, but important details differ',
  'mostly: the subject is right, small details differ',
  'closely: the subject and its main details match',
  'exactly: everything described is there',
];

export interface Review {
  score: number;
  problems: string[];
}

const FACING_QUESTION = "Which side of the image is the figure's body turned toward (its chest and feet, the way it would walk), as the viewer sees it? Ignore where the eyes look.";
const SPLIT_QUESTION = "Are the figure's head and its body turned toward opposite sides of the image (for example the body faces left while the face looks right)?";
const FACING_CHOICES = { left: 'toward the left edge of the image', right: 'toward the right edge of the image', front: 'straight at the viewer' };

/** Score an image 0-10 with the configured checker: a decision model (fast, probabilistic) or a vision LLM. */
export async function qualityCheck(png: Buffer, kind: AssetKind, description: string, reference?: Buffer): Promise<Review | null> {
  const g = genai();
  if (g.isProcedural('image.check')) return null;
  const isTex = kind === 'texture';
  // Transparent assets are shown on magenta beside their alpha mask, so fog, glows and backdrop panels show.
  const view = isTex ? await tiledPreview(png) : await inspectionView(png);
  // Variants are judged on their own: reference conditioning keeps identity, and small checkers compare two
  // images unreliably (they rejected faithful frames). A vision LLM still gets the original for context.
  const refView = reference && !g.isDecision('image.check') ? await inspectionView(reference) : undefined;
  // OpenAI's decision model reads a side-by-side view as two subjects: it gets the asset and its mask apart.
  const split = !isTex && g.providerConfig(g.purpose('image.check').provider).type === 'openai-decision';
  const images = split ? await inspectionImages(png) : refView ? [view, refView] : [view];
  try {
    if (g.isDecision('image.check')) {
      const a = await g.decide('image.check', {
        state: isTex
          ? `A generated game texture, shown tiled 2x2. It should depict: "${description}". Requirements: ${CRITERIA[kind]}`
          : split
            ? `A generated game asset. Image 1: the cut-out asset on a plain magenta background (magenta is empty, transparent space, not part of the asset). Image 2: the same asset's opacity mask (white = opaque, black = transparent); it is the same single asset, not a second one. It should depict: "${description}". Requirements: ${CRITERIA[kind]}`
            : `A generated game asset. Left panel: the cut-out subject on a magenta background (magenta means empty, transparent space). Right panel: its opacity mask (white = opaque). It should depict: "${description}". Requirements: ${CRITERIA[kind]}${refView ? ' The second image shows the original it must match, in the same layout.' : ''}`,
        images,
        questions: {
          quality: { type: 'score', instructions: 'Judged as a game asset shown small on screen (not as a standalone artwork): how usable is it?', criteria: LEVELS },
          match: { type: 'score', instructions: 'How well does the image match the description?', criteria: MATCH_LEVELS },
          ...(isTex
            ? {
                flat: { type: 'noul' as const, instructions: 'Is this a flat top-down surface texture with no objects, horizon or perspective?' },
                seams: { type: 'noul' as const, instructions: 'Are there visible seams, lines or obvious repeating blotches where the four tiles meet?' },
              }
            : {
                single: { type: 'noul' as const, instructions: 'Does the image show a single subject: one character, creature, object or item? A pile, stack, set or arrangement that forms one thing counts as one.' },
                whole: { type: 'noul' as const, instructions: 'Is the whole subject visible, not cut off by the image edge?' },
                clean: { type: 'noul' as const, instructions: 'Apart from the subject itself, is there any fog, mist, smoke, glow, aura, ground patch, shadow, floor or rectangular background panel? Look at the white area of the mask: anything beyond the subject counts.' },
                dark: { type: 'noul' as const, instructions: 'Is the subject so dark or murky that its shape and details are hard to make out?' },
              }),
          text: { type: 'noul', instructions: 'Does the image contain any text, letters, watermark or signature?' },
        },
      });
      if (process.env.GD_DEBUG_CHECK) console.log('[check]', JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.type === 'score' ? +v.score.toFixed(2) : v.type === 'noul' ? +v.noul.toFixed(2) : v.choice]))));
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
      const penalize = (cond: boolean, why: string, by = 3) => {
        if (!cond) return;
        score -= by;
        problems.push(why);
      };
      penalize(isTex && yes('flat') < 0.5, 'not a flat top-down texture');
      penalize(isTex && yes('seams') > 0.6, 'visible seams when tiled', 2);
      penalize(!isTex && yes('single') < 0.5, 'more than one subject');
      penalize(!isTex && yes('whole') < 0.5, 'subject cut off');
      penalize(!isTex && yes('clean') > 0.5, 'background, fog or glow left around the subject', 4);
      penalize(!isTex && yes('dark') > 0.55, 'too dark to read', 3);
      penalize(yes('text') > 0.5, 'contains text');
      if (lvl('match') < 4) problems.push('does not match the description');
      return { score: Math.max(0, Math.min(10, score)), problems };
    }
    const r = await g.structured('image.check', {
      system: 'You are a strict art director reviewing generated game assets. Judge only what you see.',
      prompt: `${isTex ? 'The texture is shown tiled 2x2.' : 'Image 1, left: the cut-out subject on magenta (magenta = empty, transparent). Right: its opacity mask.'}${refView ? ' Image 2 shows the original it must match.' : ''}\nIt should depict: "${description}".\nRequirements: ${CRITERIA[kind]}\nAny fog, glow, ground or background panel left around a subject is a serious problem. Score 0-10 for how usable this is as a game asset (10 = perfect, 6 = acceptable, below 5 = must regenerate). List concrete problems.`,
      schema: QualitySchema,
      name: 'image_review',
      images,
      maxTokens: 400,
    });
    return { score: r.score, problems: r.problems };
  } catch (e) {
    console.warn('[images] quality check failed:', (e as Error).message);
    return null;
  }
}

// ------------------------------------------------------------------------------------ prompts

const KIND_PURPOSE: Record<AssetKind, Purpose> = {
  texture: 'image.texture',
  sprite: 'image.sprite',
  object: 'image.sprite',
  icon: 'image.icon',
  portrait: 'image.sprite',
};

const KIND_NOUN: Record<AssetKind, string> = { texture: 'surface', sprite: 'character', object: 'object', icon: 'item', portrait: 'character' };

/** Framing every brief carries (the prompt writer must respect it). */
export const BRIEF_FRAMING: Record<AssetKind, string> = {
  texture: 'A seamless tileable surface texture seen straight from above (top-down orthographic, no perspective or vanishing point), filling the whole square frame edge to edge with one continuous material and no objects, shapes, pools, patches, holes, horizon, border, shadow or vignette; the material continues off every edge so tiles join invisibly, at a scale of roughly one metre across the frame.',
  sprite: 'A game character sprite: one full-body figure standing in a relaxed ready stance, in a three-quarter view turned slightly to the left, with head, gaze, chest and feet all turned the same way, centred, the entire figure visible from the top of the head to the soles of the feet with a little empty space around it.',
  object: 'A game prop seen from a high three-quarter angle (about 35 degrees from above, as in an isometric game): one object shown whole and centred, standing upright as it would stand on the ground (a sign on its post, a lantern on its base or pole, a table on its legs), with empty space around it.',
  icon: 'A game inventory icon: one item centred and shown whole, slightly angled, filling most of a square frame, no hands.',
  portrait: 'A head-and-shoulders character portrait.',
};

const VARIANT_FRAMING: Record<AssetKind, string> = {
  texture: '',
  sprite: 'Full body from the top of the head to the soles of the feet, same three-quarter view, same size in the frame as the reference.',
  object: 'Shown whole from the same high three-quarter angle, same size in the frame as the reference.',
  icon: 'Same framing as the reference.',
  portrait: 'Same framing as the reference.',
};

/** Walls are vertical faces on the map: their surface is seen straight on, not from above. */
const WALL_FRAMING = 'A seamless tileable wall surface seen straight on (a flat front elevation, no perspective), filling the whole square frame edge to edge with no objects, floor, ceiling, border or vignette; the masonry, planks or panels continue off every edge so tiles join invisibly, at a scale of roughly two metres across the frame.';

/** The impassable role (liquid, chasm or void): the expanse itself, never an object or a hole with a rim. */
const HAZARD_FRAMING = 'A seamless tileable surface seen straight from above (top-down orthographic, no perspective): only the substance itself is visible, filling 100% of the square like a close-up of a flat liquid surface or an endless depth, with no floor, rim, shore, edge, outline, puddle shape or object anywhere in the frame; it continues off every edge so tiles join invisibly.';

const framingFor = (rec: AssetRecord) => (rec.kind !== 'texture' ? BRIEF_FRAMING[rec.kind] : rec.key.endsWith('_wall') ? WALL_FRAMING : rec.key.endsWith('_water') ? HAZARD_FRAMING : BRIEF_FRAMING.texture);

/** Brief handed to the image.prompt LLM. */
export function assetBrief(rec: AssetRecord, style: string): string {
  return `${rec.kind.toUpperCase()}. ${framingFor(rec)} Subject: ${rec.prompt}. Art style: ${style}.`;
}

/** System prompt for the LLM that turns briefs into full prompts for a given image model. */
export function imagePromptSystem(profile: PromptProfile): string {
  return `You are the art director of a game, writing prompts for an image model trained on long descriptive captions. For each brief, describe the finished image as an observer would, in one English paragraph of 100 to 180 words, present tense, third person.

Open with one sentence naming the medium, the art style and the subject. Then describe the subject in order: for a figure, build, posture, face, hair, then each garment with its colour and material, then anything held and in which hand; for an object, its shape, materials, colours, wear and details; for a surface, the one material that fills the whole frame, its pattern, colour variation and wear, never a container, rim or surrounding ground and nothing in the middle. Use positional phrases (in the upper part of the frame, at the left hip, along the lower edge). Name colours with modifiers (deep navy, muted olive) and materials precisely (weathered oak, brushed iron).

Describe only the subject itself. Characters, creatures, props and icons stand alone on nothing: write nothing about surroundings, ground, floor, base, backdrop, weather, sky, atmosphere or effects drifting around the subject. Express the world's mood through the subject's own design, colours, materials and wear, not through lighting effects. Give the lighting one short sentence: soft, even studio light with a gentle rim light, so the subject reads clearly with good contrast and mid-tones; in a dark or grim world use deep, rich colours rather than darkness. Textures are lit flat and evenly, with no single dominant feature, so they repeat well; even a dark material is shown in deep but readable tones with visible sheen or grain, never near-black.

Respect every framing requirement in the brief. No quality boosters (masterpiece, 8k), no instructions to the model, no quotation marks, and no text, letters or signage in the image.${profile.writerNotes ? `\n\n${profile.writerNotes}` : ''}`;
}

/** Used when no LLM is available: a plain observer-style paragraph assembled from the brief. */
function describeFallback(rec: AssetRecord, style: string): string {
  const medium = rec.kind === 'texture' ? 'seamless top-down texture' : rec.kind === 'icon' ? 'game icon illustration' : 'game asset illustration';
  return `The image is a ${style} ${medium} of ${rec.prompt}. ${framingFor(rec)} The lighting is soft and even with a gentle rim light, giving the forms volume and clear contrast. The overall composition is clean and readable, with a cohesive palette and a clear silhouette.`;
}

function tagPrompt(kind: AssetKind, subject: string, style: string): string {
  switch (kind) {
    case 'texture':
      return `${subject}, seamless tileable texture, top-down orthographic view, flat even lighting, highly detailed surface, ${style}`;
    case 'sprite':
      return `${subject}, single full body character standing, three-quarter view, entire figure visible from head to feet, centered, game character sprite, ${style}`;
    case 'object':
      return `${subject}, single object, entire object visible, high three-quarter isometric view, centered, game asset, ${style}`;
    case 'icon':
      return `${subject}, single item, centered, game inventory icon, ${style}`;
    case 'portrait':
      return `${subject}, head and shoulders portrait, ${style}`;
  }
}

function profileForKind(kind: AssetKind): { profile: PromptProfile; alpha: 'native' | 'cutout' } {
  const g = genai();
  const pc = g.providerConfig(g.purpose(KIND_PURPOSE[kind]).provider);
  return { profile: profileFor(pc), alpha: pc.alpha === 'native' ? 'native' : 'cutout' };
}

/** Does any image purpose want long descriptive prompts written by the image.prompt LLM? */
export function wantsDescriptivePrompts(): boolean {
  const g = genai();
  if (g.isProcedural('image.prompt')) return false;
  return (['image.texture', 'image.sprite', 'image.icon'] as const).some((p) => !g.isProcedural(p) && profileFor(g.providerConfig(g.purpose(p).provider)).style === 'descriptive');
}

/** The profile the prompt writer should target (the sprite model's, which most assets use). */
export function writerProfile(): PromptProfile {
  const g = genai();
  return profileFor(g.providerConfig(g.purpose('image.sprite').provider));
}

/** Can variants be painted from a reference image with the configured sprite model? */
export function supportsVariants(): boolean {
  const g = genai();
  if (g.isProcedural('image.sprite')) return false;
  const pc = g.providerConfig(g.purpose('image.sprite').provider);
  return pc.type === 'comfyui' && !!pc.editWorkflow;
}

export function buildPrompt(rec: AssetRecord, style: string): { prompt: string; negative: string } {
  const { profile, alpha } = profileForKind(rec.kind);
  const negative = profile.negative[rec.kind] ?? '';
  const transparent = rec.kind !== 'texture';
  if (rec.variant) {
    const v = VARIANTS[rec.variant];
    const prompt = profile.variantTemplate
      .replace('{kindNoun}', KIND_NOUN[rec.kind])
      .replace('{variant}', v?.change ?? rec.variant)
      .replace('{framing}', VARIANT_FRAMING[rec.kind])
      .replace('{subject}', rec.prompt);
    return { prompt: alpha === 'native' || !transparent ? prompt : prompt + profile.cutoutSuffix, negative };
  }
  const body = profile.style === 'descriptive' ? (rec.imagePrompt ?? describeFallback(rec, style)) : tagPrompt(rec.kind, rec.prompt, style);
  if (!transparent) return { prompt: body, negative };
  return { prompt: alpha === 'native' ? profile.alphaWrap.replace('{prompt}', body) : body + profile.cutoutSuffix, negative };
}

// ------------------------------------------------------------------------------------ orchestration

interface Candidate {
  img: ProcessedImage;
  score: number;
  problems: string[];
}

async function generateCandidate(rec: AssetRecord, style: string, worldSeed: string, attempt: number, reference?: { png: Buffer; figureRatio: number; sprite?: Buffer }): Promise<ProcessedImage> {
  const g = genai();
  const seed = hashOf(worldSeed, rec.key, attempt + (rec.roll ?? 0) * 1000) % 2147483647;
  // Humanoid walk cycles: a pose-guided sheet of frames painted from the approved character.
  if (rec.variant === 'walk' && reference?.sprite) return paintWalkStrip(reference.sprite, rec.prompt, seed);
  const { prompt, negative } = buildPrompt(rec, style);
  const raw = await g.image(KIND_PURPOSE[rec.kind], {
    prompt,
    negativePrompt: negative,
    seed,
    transparent: rec.kind !== 'texture',
    references: reference ? [reference.png] : undefined,
  });
  if (rec.kind === 'texture') {
    const png = await liftDark(await makeSeamless(raw, 256));
    return { png, width: 256, height: 256, problems: (await framedness(png)) > 25 ? ['a framed shape or perspective instead of a continuous surface'] : [] };
  }
  const img = await processSprite(raw, rec.kind === 'icon' ? 128 : rec.kind === 'object' ? 224 : 256);
  return img;
}

/**
 * Produce many assets in rounds: generate every pending image (image model resident), then score every
 * candidate (checker resident), then regenerate only the rejects. This keeps GPU model swaps to two per round.
 * Variants wait for their base asset and are painted from its approved image.
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
  const refs = new Map<string, { png: Buffer; figureRatio: number; sprite?: Buffer } | null>();
  const minScore = g.purpose('image.check').minScore ?? 6;
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  const finish = (rec: AssetRecord) => {
    if (finished.has(rec.key)) return;
    finished.add(rec.key);
    const b = best.get(rec.key);
    if (!b) return onDone({ ...rec, status: 'failed', error: errors.get(rec.key), attempts: attempts.get(rec.key) });
    // The best attempt is always kept (every world's art is its own; nothing falls back to procedural art). A weak
    // one carries its problems in `error`, and the art job repairs it with a rewritten prompt.
    fs.mkdirSync(outDir, { recursive: true });
    const file = fileFor(rec.key);
    fs.writeFileSync(path.join(outDir, file), b.img.png);
    const ref = rec.ref ? refs.get(rec.ref) : undefined;
    const relHeight = ref && b.img.figureRatio ? Math.max(0.5, Math.min(1.4, b.img.figureRatio / ref.figureRatio)) : undefined;
    onDone({ ...rec, status: 'ok', file, score: b.score, attempts: attempts.get(rec.key), width: b.img.width, height: b.img.height, anchorY: b.img.anchorY, relHeight, frames: b.img.frames, error: b.score < minScore ? b.problems.join('; ') || undefined : undefined });
  };
  /** Reference image for a variant: its base asset's approved file (null when the base is not usable). */
  const referenceFor = async (rec: AssetRecord) => {
    if (!rec.ref) return undefined;
    if (!refs.has(rec.ref)) {
      const file = path.join(outDir, fileFor(rec.ref));
      if (!fs.existsSync(file)) refs.set(rec.ref, null);
      else {
        const pc = g.purpose(purposeOf(rec));
        refs.set(rec.ref, await referenceFrame(fs.readFileSync(file), pc.width ?? 832, pc.height ?? 1216));
      }
    }
    return refs.get(rec.ref) ?? null;
  };
  // Bases before variants, so a variant's reference exists when its round comes.
  let pending = [...active.filter((r) => !r.ref), ...active.filter((r) => r.ref)];
  const inBatch = new Set(active.map((r) => r.key));
  for (let round = 0; pending.length; round++) {
    // Phase 1: generate every pending asset while the image model is resident.
    const fresh: { rec: AssetRecord; img: ProcessedImage }[] = [];
    for (const rec of pending) {
      if (shouldStop?.()) return;
      // A variant waits for its base when that base is still being painted in this batch.
      if (rec.ref && inBatch.has(rec.ref) && !finished.has(rec.ref)) continue;
      const ref = await referenceFor(rec);
      if (ref === null) {
        // The base never made it: nothing to paint the variant from.
        finished.add(rec.key);
        onDone({ ...rec, status: 'skipped', error: 'base image missing' });
        continue;
      }
      attempts.set(rec.key, (attempts.get(rec.key) ?? 0) + 1);
      try {
        fresh.push({ rec, img: await generateCandidate(rec, style, worldSeed, round + (rec.variant ? 17 * rec.variant.length : 0), ref) });
      } catch (e) {
        errors.set(rec.key, (e as Error).message);
      }
    }
    // Phase 2: score every candidate while the checker is resident (also when stopping: they are paid for).
    for (const entry of fresh) {
      const { rec } = entry;
      let img = entry.img;
      const ref = rec.ref ? refs.get(rec.ref) : undefined;
      // A walk strip is judged by its passing frame against the character it was painted from.
      const judged = img.frames ? await stripFrame(img.png, img.frames, 2) : img.png;
      const review = await qualityCheck(judged, rec.kind, rec.variant ? `${rec.prompt}, ${VARIANTS[rec.variant]?.change ?? rec.variant}` : rec.prompt, ref ? fs.readFileSync(path.join(outDir, fileFor(rec.ref!))) : undefined);
      // The game draws characters facing left (mirrored to go right): a frame painted facing right is mirrored.
      const facing = rec.kind === 'sprite' && !img.frames ? await facingCheck(img.png) : null;
      if (facing?.facing === 'right') img = { ...img, png: await sharp(img.png).flop().png().toBuffer() };
      // A head turned against the body reads as walking backwards whichever way it is drawn: paint it again.
      const notes = [...(img.notes ?? []), ...(facing?.split ? ['head and body turned opposite ways'] : [])];
      const problems = [...img.problems, ...(review?.problems ?? []), ...notes];
      let score = review ? review.score : 7;
      if (img.problems.length) score = Math.min(score, 4);
      score -= notes.reduce((t, n) => t + (n.includes('fog') || n.includes('dark') ? 2 : 1), 0);
      const prev = best.get(rec.key);
      if (!prev || score > prev.score) best.set(rec.key, { img, score, problems });
      if (score >= minScore && !img.problems.length) finish(rec);
    }
    // Out of attempts: keep the best try.
    for (const rec of pending) if (!finished.has(rec.key) && (attempts.get(rec.key) ?? 0) >= limit(rec)) finish(rec);
    pending = pending.filter((r) => !finished.has(r.key));
    // Stopping: approved images are saved; the rest are painted again next time.
    if (shouldStop?.()) return;
  }
}

/**
 * Which way a painted character faces. The game draws characters facing left (mirrored to go right). The
 * checker sees the figure alone on plain grey, once as painted and once mirrored; only answers that flip with
 * the mirror count (a checker leaning one way whatever it sees gives "front", and nothing is changed).
 */
export async function facingOf(png: Buffer): Promise<'left' | 'right' | 'front' | null> {
  return (await facingCheck(png))?.facing ?? null;
}

/** Facing (as in facingOf) and whether the head is turned against the body. */
export async function facingCheck(png: Buffer): Promise<{ facing: 'left' | 'right' | 'front'; split: boolean } | null> {
  const g = genai();
  if (g.isProcedural('image.check')) return null;
  let split = false;
  const plain = (b: Buffer) => sharp(b).resize(384, 384, { fit: 'contain', background: { r: 128, g: 128, b: 128, alpha: 1 } }).flatten({ background: '#808080' }).png().toBuffer();
  const ask = async (b: Buffer): Promise<string | null> => {
    const view = await plain(b);
    if (g.isDecision('image.check')) {
      const a = await g.decide('image.check', { state: 'A game character on a plain grey background.', images: [view], questions: { facing: { type: 'choice', instructions: FACING_QUESTION, criteria: FACING_CHOICES }, split: { type: 'noul', instructions: SPLIT_QUESTION } } });
      if (a.split?.type === 'noul' && a.split.noul > 0.6) split = true;
      return a.facing?.type === 'choice' ? (a.facing as { choice: string }).choice : null;
    }
    const r = await g.structured('image.check', { system: 'Judge only what you see.', prompt: `${FACING_QUESTION} Answer left, right or front. Also: ${SPLIT_QUESTION}`, schema: z.object({ facing: z.enum(['left', 'right', 'front']), split: z.boolean() }), name: 'facing', images: [view], maxTokens: 80 });
    if (r.split) split = true;
    return r.facing;
  };
  try {
    const asPainted = await ask(png);
    const mirrored = await ask(await sharp(png).flop().png().toBuffer());
    const facing = asPainted === 'left' && mirrored === 'right' ? 'left' : asPainted === 'right' && mirrored === 'left' ? 'right' : 'front';
    return { facing, split };
  } catch {
    return null;
  }
}

/** Generate (or regenerate) one asset; writes the PNG and returns the updated record. */
export async function produceAsset(rec: AssetRecord, style: string, outDir: string, worldSeed: string): Promise<AssetRecord> {
  let out: AssetRecord = { ...rec, status: 'failed' };
  await produceAssets([rec], style, outDir, worldSeed, (r) => (out = r));
  return out;
}
