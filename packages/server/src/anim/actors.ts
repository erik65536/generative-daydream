/**
 * Which of a world's sprites are actors to animate, and their body plans. Until the art plan records a body plan
 * per actor, it is read from the actor's brief: people are humanoid; creatures that hover or drift are floaters;
 * animals that walk on four or more legs (dogs, crabs, spiders) are "quadrupeds"; anything else is tried as a
 * humanoid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ANIM_VERSION, type AssetRecord, type BodyPlan, type WorldDefinition } from '@gd/shared';
import { worldAssetDir } from '../storage';
import { animateActor, animationConfig, saveAnimation, type AnimateOptions } from './animator';

const FLOATER = /\b(float(s|ing)?|hover(s|ing)?|drift(s|ing)?|levitat\w*|jelly ?fish|tentacle[sd]?|wisp|wraith|ghost(ly)?|disembodied|airborne)\b/i;
/** Said outright: many legs, or a body plan that walks on them. */
const LEGGED = /\b((four|six|eight|many)[- ]legged|quadruped|on all fours|paws|hooves|crab\w*|crustacean|lobster|spider|arachnid|insect\w*|beetle|scorpion|centipede|millipede|mantis|pincers|carapace)\b/i;
/** Animal words: only when nothing in the brief says person (a "Ledger Hound" in a hood and gloves walks upright). */
const ANIMAL = /\b(wolf|wolves|hound|dog|jackal|fox|boar|hog|pig|bear|cat|lynx|panther|lion|tiger|stag|deer|elk|horse|pony|mule|goat|ram|ox|bull|rat|weasel|badger|otter|lizard|salamander|crocodile|hyena)\b/i;
const PERSON = /\b(man|woman|person|humanoid|knight|soldier|priest|mage|warrior|clerk|hands?|fingers|gloves?|gauntlets?|hood(ed)?|cloak|robes?|coat|tunic|boots|armou?r|helmet|torso|biped|two legs|upright)\b/i;
const FEET = /\b(boots|soles|legs|feet)\b/i;

export function bodyPlan(rec: AssetRecord): BodyPlan {
  if (/^spr_(origin|npc)_/.test(rec.key)) return 'humanoid';
  const text = `${rec.prompt ?? ''} ${rec.imagePrompt ?? ''}`;
  if (FLOATER.test(text) && !FEET.test(rec.prompt ?? '')) return 'floater';
  if (LEGGED.test(text) || (ANIMAL.test(text) && !PERSON.test(text))) return 'quadruped';
  return 'humanoid';
}

/** The base sprites of characters and creatures (not item icons, objects or pose variants). */
export function actorSprites(w: WorldDefinition): AssetRecord[] {
  return Object.values(w.assets).filter((a) => a.kind === 'sprite' && a.status === 'ok' && !a.ref && !a.variant && !!a.file && a.key.startsWith('spr_'));
}

/** Whether an actor's sheets are missing or out of date (an older format, or made from an earlier painting). */
export const needsAnimation = (rec: AssetRecord) => !rec.anim || rec.anim.v !== ANIM_VERSION || rec.anim.from !== rec.file;

export interface WorldAnimateOptions extends AnimateOptions {
  only?: (key: string) => boolean;
  bodies?: Record<string, BodyPlan>;
  /** Called after each actor (to save the world). */
  onActor?: (key: string, ok: boolean, msg: string) => void;
  /** Animate actors that already have current sheets too. */
  all?: boolean;
}

/** Animate a world's actors one by one. Failures are reported and skipped: that actor keeps its still image. */
export async function animateWorld(w: WorldDefinition, opts: WorldAnimateOptions = {}): Promise<{ done: number; failed: number }> {
  const cfg = animationConfig();
  if (!cfg) throw new Error('animation is not configured (genai config "animation")');
  let done = 0, failed = 0;
  for (const rec of actorSprites(w)) {
    if (opts.only && !opts.only(rec.key)) continue;
    if (!opts.all && !opts.redoFrom && !needsAnimation(rec)) continue;
    const body = opts.bodies?.[rec.key] ?? bodyPlan(rec);
    if (body !== 'humanoid' && !cfg.skintokens) continue;
    try {
      const image = fs.readFileSync(path.join(worldAssetDir(w.id), rec.file!));
      const r = await animateActor({ worldId: w.id, key: rec.key, image, body }, opts);
      saveAnimation(w, rec.key, r, cfg.scale ?? 2);
      done++;
      opts.onActor?.(rec.key, true, `${body}, ${Object.keys(r.clips).length} clips`);
    } catch (e) {
      failed++;
      opts.onActor?.(rec.key, false, (e as Error).message);
    }
  }
  return { done, failed };
}
