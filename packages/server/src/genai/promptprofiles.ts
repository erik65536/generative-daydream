/**
 * Prompt wording per image-model family. Models differ in what they understand (long captions or tag lists),
 * whether they paint transparency natively, and which phrasings help. A provider picks a profile with
 * `promptProfile` (or by its checkpoint name); `config/prompt-profiles/<id>.json` can override any field.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AssetRecord } from '@gd/shared';
import { ROOT_DIR } from '../paths';

export type AssetKind = Exclude<AssetRecord['kind'], 'painting' | 'texture'>;

export interface PromptProfile {
  id: string;
  /** 'descriptive': an LLM writes a long observer-style paragraph. 'tags': a comma-separated tag prompt. */
  style: 'descriptive' | 'tags';
  /** Extra guidance for the LLM that writes this model's prompts. */
  writerNotes: string;
  /** Wrapper for transparent assets when the model paints alpha natively ({prompt} = the paragraph). */
  alphaWrap: string;
  /** Appended to transparent assets when the background is removed afterwards. */
  cutoutSuffix: string;
  /** Negative prompt per kind (ignored by models without one). */
  negative: Partial<Record<AssetKind, string>>;
  /** Variant of an existing asset from a reference image: {variant} = what changes, {subject} = the original brief. */
  variantTemplate: string;
}

const NO_SCENE = 'background, scenery, ground, floor, shadow, fog, mist, smoke, haze, glow, light rays, particles, frame, border, vignette, text, letters, watermark';

const PROFILES: Record<string, PromptProfile> = {
  'qwen-image-2': {
    id: 'qwen-image-2',
    style: 'descriptive',
    writerNotes:
      'This model follows long, literal captions closely and renders exactly what is named, including anything mentioned as absent, so never mention fog, mist, smoke or glows at all, not even to exclude them. Describe light sources on the subject (a lantern flame, glowing runes) as small and contained within the subject.',
    alphaWrap: 'This is an RGBA format image with transparency. {prompt} The image has an alpha channel and a transparent background.',
    cutoutSuffix: ' The background is a single flat, even light grey with nothing else in it.',
    negative: {},
    variantTemplate:
      'This is an RGBA format image with transparency. The same {kindNoun} as in the reference image, identical design, colours, materials, proportions and art style, now {variant}. {framing} The image has an alpha channel and a transparent background.',
  },
  flux: {
    id: 'flux',
    style: 'descriptive',
    writerNotes: 'This model likes natural, flowing captions. Keep the subject description concrete and visual. Avoid mentioning anything that should not appear.',
    alphaWrap: '{prompt}',
    cutoutSuffix: ' The subject is isolated on a single flat, even light grey background with nothing else in it.',
    negative: {},
    variantTemplate: 'The same {kindNoun} as in the reference image, identical design, colours, materials and art style, now {variant}. {framing} Isolated on a flat light grey background.',
  },
  sdxl: {
    id: 'sdxl',
    style: 'tags',
    writerNotes: '',
    alphaWrap: '{prompt}',
    cutoutSuffix: ', isolated on a plain flat light gray background',
    negative: {
      sprite: `cropped, cut off, multiple characters, ${NO_SCENE}`,
      object: `cropped, multiple objects, people, ${NO_SCENE}`,
      icon: `hands, people, multiple items, ${NO_SCENE}`,
      portrait: 'text, watermark, multiple people',
    },
    variantTemplate: 'same {kindNoun}, {variant}, {framing}',
  },
};

/** Default profile for a provider (by explicit id, else its checkpoint or model name). */
export function profileFor(cfg: { promptProfile?: string; promptStyle?: string; checkpoint?: string; model?: string }): PromptProfile {
  const name = `${cfg.checkpoint ?? ''} ${cfg.model ?? ''}`.toLowerCase();
  const id = cfg.promptProfile ?? (/qwen/.test(name) ? 'qwen-image-2' : /flux|krea|kroma/.test(name) ? 'flux' : cfg.promptStyle === 'descriptive' ? 'flux' : 'sdxl');
  const base = PROFILES[id] ?? PROFILES.sdxl!;
  const file = path.join(ROOT_DIR, 'config', 'prompt-profiles', `${id}.json`);
  if (!fs.existsSync(file)) return base;
  try {
    const over = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PromptProfile>;
    return { ...base, ...over, negative: { ...base.negative, ...(over.negative ?? {}) } };
  } catch {
    return base;
  }
}
