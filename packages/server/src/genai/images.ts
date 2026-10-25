/**
 * Art for everything drawn over the paintings: characters, creatures, objects and item icons. Luna writes each
 * prompt and picks its chroma-key backdrop; ComfyUI paints it with Krea 2 and marks it with BiRefNet in one job; the
 * subject is cut out against the known backdrop (cutout.ts), its cut is scored, and the painting is checked for
 * content (right subject, framing, pose). Attempts repeat with new seeds (and another key colour when the colours
 * clash) until one passes; the best attempt is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { hashOf } from '@gd/shared';
import type { AssetRecord } from '@gd/shared';
import { genai } from './service';
import type { Purpose } from './types';
import { KEY_NAMES, backdropSentence, cutout, cutoutProblems, finishCutout, type Cutout, type FinishedImage, type KeyColour } from './cutout';

export type AssetKind = Exclude<AssetRecord['kind'], 'painting' | 'texture' | 'sheet'>;
/** An image this pipeline makes (places are painted elsewhere). */
export type ImageRecord = AssetRecord & { kind: AssetKind };
/** How an actor is shown: from the front (people, upright figures) or from the side (animals and other body plans). */
export type View = 'front' | 'side';

/** How the image model wants its prompts (Krea 2: long, natural captions). */
export const KREA_WRITER_NOTES = 'This model likes natural, flowing captions. Keep the subject description concrete and visual. Avoid mentioning anything that should not appear.';

// ------------------------------------------------------------------------------------ briefs and prompts

const KIND_PURPOSE: Record<AssetKind, Purpose> = { sprite: 'image.sprite', object: 'image.sprite', icon: 'image.icon' };

/** The base view of every actor: what the 3D animation step builds the rigged figure from. */
const VIEW_FRAMING: Record<View, string> = {
  front:
    'one full-body figure seen from straight in front, facing the viewer, standing upright in a neutral, relaxed pose: feet a little apart, arms hanging slightly away from the body, anything carried held at the side; centred, the entire figure visible from the top of the head to the soles of the feet with a little empty space around it',
  side: 'one full-body creature seen exactly from the side, in profile facing left, standing in a neutral pose with all its legs visible; centred, the whole body from the front of the head to the tip of the tail visible with a little empty space around it',
};

/** Framing every brief carries (the prompt writer must respect it). */
function framing(rec: ImageRecord): string {
  switch (rec.kind) {
    case 'sprite':
      return rec.view
        ? `A game character model: ${VIEW_FRAMING[rec.view]}.`
        : `A game creature model. If its body runs lengthwise (four or more legs, a crab, an insect, a serpent or eel, a fish, a bird, a crawling body), show ${VIEW_FRAMING.side} (view: side). Otherwise (an upright figure on two legs, or a body with no front and back: a swarm, a cloud, an ooze, a floating shape), show ${VIEW_FRAMING.front} (view: front).`;
    case 'object':
      return 'A game prop seen from a high three-quarter angle (about 35 degrees from above, as the figures of a top-down game are drawn): one object shown whole and centred, standing upright as it would stand on the ground (a sign on its post, a lantern on its base or pole, a table on its legs), with empty space around it.';
    case 'icon':
      return 'A game inventory icon: one item centred and shown whole, slightly angled, filling most of a square frame, no hands.';
  }
}

/** Brief handed to the image.prompt LLM. */
export function assetBrief(rec: ImageRecord, style: string): string {
  return `${rec.kind.toUpperCase()}. ${framing(rec)} Subject: ${rec.prompt}. Art style: ${style}.`;
}

/** How the prompt writer picks the backdrop (one of the chroma keys) for each asset. */
const BACKDROP_GUIDE = `For each brief also choose the backdrop the image is painted on, so the subject can be cut out of it cleanly afterwards: green (chroma-key green), blue (chroma-key blue) or magenta (bright magenta). Choose the one whose hue the subject uses least, judged by its large areas and by its outline, highlights, rim light, glows and anything translucent or wispy, since the backdrop tints soft edges. Small accents matter less than outlines. Skin, wood, leather, brass and rust do not rule out magenta. If the subject is mostly see-through or glowing (glass, crystal, ice, a ghost, a jelly, a lit lantern), the backdrop shows through it and tints its glow: choose the key colour nearest to its own tint (green for green or teal glass, blue for blue or white ice, magenta for pink or violet), so what shows through looks natural. Never mention the backdrop in the prompt itself.`;

/** System prompt for the LLM that turns briefs into Krea prompts. */
export function imagePromptSystem(): string {
  return `You are the art director of a game, writing prompts for an image model trained on long descriptive captions. For each brief, describe the finished image as an observer would, in one English paragraph of 100 to 180 words, present tense, third person.

Open with one sentence naming the medium, the art style and the subject. Then describe the subject in order: for a figure, build, posture, face, hair, then each garment with its colour and material, then anything held and in which hand; for an object, its shape, materials, colours, wear and details. Use positional phrases (in the upper part of the frame, at the left hip, along the lower edge). Name colours with modifiers (deep navy, muted olive) and materials precisely (weathered oak, brushed iron).

Describe only the subject itself. Characters, creatures, props and icons stand alone on nothing: write nothing about surroundings, ground, floor, base, backdrop, weather, sky, atmosphere or effects drifting around the subject, and no cast shadow. Express the world's mood through the subject's own design, colours, materials and wear, not through lighting effects. Give the lighting one short sentence: soft, even studio light with a gentle rim light, so the subject reads clearly with good contrast and mid-tones; in a dark or grim world use deep, rich colours rather than darkness.

Respect every framing requirement in the brief, and for creatures say which view you chose. No quality boosters (masterpiece, 8k), no instructions to the model, no quotation marks, and no text, letters or signage in the image.

${BACKDROP_GUIDE}

${KREA_WRITER_NOTES}`;
}

/** What the prompt writer returns per brief. */
export const promptEntry = <K extends [string, ...string[]]>(keys: K) =>
  z.object({ key: z.enum(keys), prompt: z.string().min(40).max(2400), backdrop: z.enum(KEY_NAMES), view: z.enum(['front', 'side']) });

/** For an asset the prompt writer left out: a plain observer-style paragraph assembled from the brief. */
function describeFallback(rec: ImageRecord, style: string): string {
  const medium = rec.kind === 'icon' ? 'game icon illustration' : 'game asset illustration';
  return `The image is a ${style} ${medium} of ${rec.prompt}. ${framing({ ...rec, view: rec.view ?? 'front' })} The lighting is soft and even with a gentle rim light, giving the forms volume and clear contrast. The overall composition is clean and readable, with a cohesive palette and a clear silhouette.`;
}

/** The full image prompt of an asset painted on `key`. */
export function buildPrompt(rec: ImageRecord, style: string, key: KeyColour): string {
  return `${rec.imagePrompt ?? describeFallback(rec, style)} ${backdropSentence(key)}`;
}

/** Canvas per asset: actors in their view's orientation, props and icons square. */
export function canvasOf(rec: ImageRecord): { width: number; height: number } {
  if (rec.kind === 'sprite') return (rec.view ?? 'front') === 'side' ? { width: 1216, height: 832 } : { width: 832, height: 1216 };
  return { width: 1024, height: 1024 };
}

/** Longest side of the kept image: actors keep detail for the 3D animation step; icons are shown small. */
const MAX_SIDE: Record<AssetKind, number> = { sprite: 768, object: 512, icon: 256 };

// ------------------------------------------------------------------------------------ content check

const CRITERIA: Record<AssetKind, string> = {
  sprite: 'exactly one full-body character or creature, fully visible (not cut off), clean silhouette, well lit and readable, no text, no extra characters, no scenery.',
  object: 'exactly one object, fully visible, clean silhouette, well lit and readable, no text, no scenery.',
  icon: 'exactly one clearly readable item centered, no text, no hands, no scenery.',
};

/** Quality levels, each with what it means for a game asset (checkers calibrate on the descriptions). */
const LEVELS = [
  'unusable: broken, garbled, the wrong subject, or unreadable at game size',
  'poor: clear defects such as artefacts, wrong framing or missing parts',
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

const POSE_QUESTION: Record<View, string> = {
  front: 'Is it seen from straight in front, facing the viewer, in a neutral, relaxed pose (a figure standing upright), with its whole body visible? Answer yes for a swarm, cloud or shape that has no front.',
  side: 'Is the creature shown from the side, in profile, in a neutral pose, with its whole body visible?',
};

export interface Review {
  score: number;
  problems: string[];
  /** Side views: which way the creature faces (the game wants left). */
  facing?: 'left' | 'right' | 'front';
}

/**
 * Score the painting 0-10 for content with the checker (Luna's decision model). It sees the painting itself, on its
 * plain key-colour backdrop: the cut is judged by the known-backdrop score, not here.
 */
export async function qualityCheck(painting: Buffer, rec: Pick<ImageRecord, 'kind' | 'prompt' | 'view'>, key: KeyColour): Promise<Review | null> {
  const g = genai();
  if (!g.configured('image.check')) return null;
  const view = await sharp(painting).removeAlpha().resize(512, 512, { fit: 'inside' }).png().toBuffer();
  const pose = rec.kind === 'sprite' ? POSE_QUESTION[rec.view ?? 'front'] : undefined;
  const state = `A generated game asset, painted on a plain ${key} studio backdrop (the backdrop is not part of it; separate pieces of one subject, such as coins in a heap or a swarm, are fine). It should depict: "${rec.prompt}". Requirements: ${CRITERIA[rec.kind]}`;
  try {
    const a = await g.decide('image.check', {
      state,
      images: [view],
      questions: {
        quality: { type: 'score', instructions: 'Judged as a game asset shown small on screen (not as a standalone artwork): how usable is it?', criteria: LEVELS },
        match: { type: 'score', instructions: 'How well does the image match the description?', criteria: MATCH_LEVELS },
        single: { type: 'noul', instructions: 'Does the image show a single subject: one character, creature, object or item? A pile, set, swarm or arrangement that forms one thing counts as one.' },
        whole: { type: 'noul', instructions: 'Is the whole subject visible, not cut off by the image edge?' },
        dark: { type: 'noul', instructions: 'Is the subject so dark or murky that its shape and details are hard to make out?' },
        text: { type: 'noul', instructions: 'Does the image contain any text, letters, watermark or signature?' },
        ...(pose ? { pose: { type: 'noul' as const, instructions: pose } } : {}),
        ...(rec.view === 'side' ? { facing: { type: 'choice' as const, instructions: "Which side of the image is the creature's head toward?", criteria: { left: 'the left edge of the image', right: 'the right edge of the image', front: 'it faces the viewer' } } } : {}),
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
    penalize(yes('single') < 0.5, 'more than one subject');
    penalize(yes('whole') < 0.5, 'subject cut off');
    penalize(yes('dark') > 0.55, 'too dark to read');
    penalize(yes('text') > 0.5, 'contains text');
    if (pose) penalize(yes('pose') < 0.5, rec.view === 'side' ? 'not seen from the side in a neutral pose' : 'not seen from the front in a neutral standing pose');
    if (lvl('match') < 4) problems.push('does not match the description');
    const f = a.facing;
    const facing = f?.type === 'choice' && (f.probabilities[f.choice] ?? 0) > 0.7 ? (f.choice as Review['facing']) : undefined;
    return { score: Math.max(0, Math.min(10, score)), problems, facing };
  } catch (e) {
    console.warn('[images] quality check failed:', (e as Error).message);
    return null;
  }
}

// ------------------------------------------------------------------------------------ orchestration

/** One attempt at an asset, as judged (for tools that show the work). */
export interface Attempt {
  painting: Buffer;
  png: Buffer;
  key: KeyColour;
  cut: Pick<Cutout, 'judgeable' | 'leftover' | 'missing' | 'bgPieces'>;
  score: number;
  problems: string[];
}

interface Candidate {
  img: FinishedImage;
  cut: Pick<Cutout, 'judgeable' | 'leftover' | 'missing' | 'bgPieces'>;
  key: KeyColour;
  /** The painting on its backdrop (for the content check). */
  painting: Buffer;
  /** The key colours clashed with the subject: the next attempt uses another. */
  clash: boolean;
  problems: string[];
}

/** Paint one attempt and cut it out. */
async function paintCandidate(rec: ImageRecord, style: string, worldSeed: string, attempt: number, key: KeyColour): Promise<Candidate> {
  const seed = hashOf(worldSeed, rec.key, attempt + (rec.roll ?? 0) * 1000) % 2147483647;
  const painting = await genai().image(KIND_PURPOSE[rec.kind], { prompt: buildPrompt(rec, style, key), seed, ...canvasOf(rec) });
  const cut = await cutout(painting);
  const img = await finishCutout(cut, MAX_SIDE[rec.kind]);
  return { img, key, painting, cut: { judgeable: cut.judgeable, leftover: cut.leftover, missing: cut.missing, bgPieces: cut.bgPieces }, clash: !cut.judgeable, problems: [...cutoutProblems(cut), ...img.problems] };
}

/**
 * Produce many assets in rounds: paint every pending asset (image model resident), then check every candidate
 * (checker resident), then paint only the rejects again. This keeps GPU model swaps to two per round.
 */
export async function produceAssets(recs: ImageRecord[], style: string, outDir: string, worldSeed: string, onDone: (rec: ImageRecord) => void, shouldStop?: () => boolean, onAttempt?: (rec: ImageRecord, attempt: Attempt) => void): Promise<void> {
  const g = genai();
  const purposeOf = (r: ImageRecord) => KIND_PURPOSE[r.kind];
  const limit = (r: ImageRecord) => g.purpose(purposeOf(r)).maxAttempts ?? 3;
  const active = recs.filter((r) => g.configured(purposeOf(r)));
  for (const r of recs) if (!g.configured(purposeOf(r))) onDone({ ...r, status: 'skipped' });
  const best = new Map<string, { c: Candidate; score: number; problems: string[] }>();
  const attempts = new Map<string, number>();
  const errors = new Map<string, string>();
  /** Key colours each asset still has to try (the writer's pick first). */
  const keys = new Map(active.map((r) => [r.key, [r.backdrop ?? 'green', ...KEY_NAMES.filter((k) => k !== (r.backdrop ?? 'green'))] as KeyColour[]]));
  const finished = new Set<string>();
  const minScore = g.config.purposes['image.check']?.minScore ?? 6;
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  const finish = (rec: ImageRecord) => {
    if (finished.has(rec.key)) return;
    finished.add(rec.key);
    const b = best.get(rec.key);
    if (!b) return onDone({ ...rec, status: 'failed', error: errors.get(rec.key), attempts: attempts.get(rec.key) });
    // The best attempt is always kept. A weak one carries its problems in `error`, and the art job repairs it with a
    // rewritten prompt.
    fs.mkdirSync(outDir, { recursive: true });
    const file = fileFor(rec.key);
    fs.writeFileSync(path.join(outDir, file), b.c.img.png);
    onDone({ ...rec, status: 'ok', file, backdrop: b.c.key, score: b.score, attempts: attempts.get(rec.key), width: b.c.img.width, height: b.c.img.height, anchorY: b.c.img.anchorY, error: b.score < minScore || b.problems.length ? b.problems.join('; ') || undefined : undefined });
  };
  let pending = active;
  for (let round = 0; pending.length; round++) {
    // Phase 1: paint every pending asset while the image model is resident.
    const fresh: { rec: ImageRecord; c: Candidate }[] = [];
    for (const rec of pending) {
      if (shouldStop?.()) return;
      attempts.set(rec.key, (attempts.get(rec.key) ?? 0) + 1);
      try {
        const c = await paintCandidate(rec, style, worldSeed, round, keys.get(rec.key)![0]!);
        // Colours that clash are not tried again (a clash is the subject's colours, not bad luck).
        if (c.clash && keys.get(rec.key)!.length > 1) keys.get(rec.key)!.shift();
        fresh.push({ rec, c });
      } catch (e) {
        errors.set(rec.key, (e as Error).message);
      }
    }
    // Phase 2: check every candidate's content (also when stopping: they are paid for).
    for (const { rec, c } of fresh) {
      const review = await qualityCheck(c.painting, rec, c.key);
      // The game draws side views facing left (mirrored to go right).
      if (review?.facing === 'right') c.img = { ...c.img, png: await sharp(c.img.png).flop().png().toBuffer() };
      const problems = [...c.problems, ...(review?.problems ?? []), ...c.img.notes];
      let score = review ? review.score : 7;
      if (c.problems.length) score = Math.min(score, 4);
      score -= c.img.notes.length;
      const prev = best.get(rec.key);
      onAttempt?.(rec, { painting: c.painting, png: c.img.png, key: c.key, cut: c.cut, score, problems });
      if (!prev || score > prev.score) best.set(rec.key, { c, score, problems });
      if (score >= minScore && !c.problems.length) finish(rec);
    }
    // Out of attempts: keep the best try.
    for (const rec of pending) if (!finished.has(rec.key) && (attempts.get(rec.key) ?? 0) >= limit(rec)) finish(rec);
    pending = pending.filter((r) => !finished.has(r.key));
    // Stopping: approved images are saved; the rest are painted again next time.
    if (shouldStop?.()) return;
  }
}

/** Generate (or regenerate) one asset; writes the PNG and returns the updated record. */
export async function produceAsset(rec: ImageRecord, style: string, outDir: string, worldSeed: string): Promise<ImageRecord> {
  let out: ImageRecord = { ...rec, status: 'failed' };
  await produceAssets([rec], style, outDir, worldSeed, (r) => (out = r));
  return out;
}
