/**
 * World art besides the painted places: every character (heroes with pose frames, people, creatures, bosses), the
 * few objects the game draws over the paintings (a chest, a sign, the waypoint), and item icons. Each image's
 * brief comes from the world; Luna writes the image prompts and checks the results.
 */
import type { WorldDefinition } from '@gd/shared';
import { BudgetExceeded } from '../genai/spend';
import { z } from 'zod';
import { VARIANTS, assetBrief, imagePromptSystem, produceAssets, supportsVariants, variantKey, wantsDescriptivePrompts, writerProfile, type ImageRecord as AssetRecord } from '../genai/images';
import { genai } from '../genai/service';
import fs from 'node:fs';
import path from 'node:path';
import { worldAssetDir } from '../storage';

/** Bump when the pipeline improves enough that existing art should be repainted. */
export const ART_VERSION = 3;

const PRESENTATIONS = ['feminine', 'masculine', 'androgynous'] as const;
/** Player heroes come in each presentation the player can choose; the class look itself stays gender-neutral. */
const PRESENTATION_SUBJECT: Record<(typeof PRESENTATIONS)[number], string> = {
  feminine: 'a woman (clearly female if not human)',
  masculine: 'a man (clearly male if not human)',
  androgynous: 'an androgynous person, neither clearly male nor female',
};

/** The presentation must read at a glance from the front, at game size, whatever the class description says. */
const PRESENTATION_LOOK: Record<(typeof PRESENTATIONS)[number], string> = {
  feminine: 'Her face, build and hair read as unmistakably feminine at a glance from the front (hair visible around the face or shoulders), and her outfit is cut for her, keeping its colours and pieces.',
  masculine: 'His face, build and hair read as unmistakably masculine at a glance from the front, and his outfit is cut for him, keeping its colours and pieces.',
  androgynous: 'Their face, build and hair are deliberately ambiguous, neither clearly male nor female, and their outfit keeps its colours and pieces.',
};

const POSES = ['walk_a', 'walk_b', 'attack'] as const;
/** Humanoids walk and attack with pose-guided frames (8 and 4); other bodies keep two painted strides and one strike. */
const HUMANOID_POSES = ['walk', 'strike'] as const;

/** The objects the game draws over every painting, one look per world. */
const OBJECTS: Record<string, string> = {
  obj_chest: 'a treasure chest or the container this world keeps valuables in',
  obj_sign: 'a free-standing signpost, its face left blank: plain panels with no letters, numbers, symbols or logos',
  obj_waypoint: 'the waypoint marker travellers use to journey between places: a free-standing landmark the size of a person',
};

/**
 * A model call that must succeed: tried again after a wait when it fails, and after the last try the job stops
 * (to be resumed once the model service works). There is no made-up stand-in.
 */
async function tries<T>(label: string, report: (msg: string) => void, fn: () => Promise<T>): Promise<T> {
  const waits = [5_000, 30_000, 120_000].map((ms) => ms * Number(process.env.GD_RETRY_WAIT_SCALE ?? 1));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160);
      if (e instanceof BudgetExceeded) throw e;
      if (attempt > waits.length) throw new Error(`${label} failed ${attempt} times (last: ${msg}). Resume once the model service is working.`);
      report(`${label}: try ${attempt} failed (${msg}); trying again in ${waits[attempt - 1]! / 1000}s`);
      await new Promise((r) => setTimeout(r, waits[attempt - 1]));
    }
  }
}

/** Run tasks with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

// ------------------------------------------------------------------------------------ plan

/** One asset the world uses, with its brief as derived from the world and as the owner customised it. */
export interface ArtEntry {
  key: string;
  kind: AssetRecord['kind'];
  /** The brief in use (the owner's, when customised). */
  brief: string;
  /** The brief the world itself gives. */
  defaultBrief: string;
  ref?: string;
  variant?: string;
  /** Would be repainted by the next art job. */
  stale: boolean;
}

/**
 * Every asset the world uses. Repainted when missing or failed, when the brief or the owner's image prompt
 * changed, when re-rolled, when made by an older pipeline, or when its base is repainted.
 */
function collectAssets(w: WorldDefinition, level: 'essential' | 'full'): { rec: AssetRecord; entry: ArtEntry }[] {
  const out: { rec: AssetRecord; entry: ArtEntry }[] = [];
  const poses = level === 'full' && supportsVariants();
  const redo = new Set<string>();
  const add = (key: string, kind: AssetRecord['kind'], derived: string, extra: Partial<AssetRecord> = {}) => {
    const prev = w.assets[key];
    const ov = w.artOverrides?.[extra.ref ?? key];
    const prompt = ov?.brief?.trim() || derived;
    const roll = ov?.roll ?? 0;
    const custom = !extra.ref ? ov?.imagePrompt?.trim() || undefined : undefined;
    const stale = !prev || prev.status !== 'ok' || prev.prompt !== prompt || (prev.gen ?? 1) < ART_VERSION || (prev.roll ?? 0) !== roll || (!!custom && prev.imagePrompt !== custom) || (!!extra.ref && redo.has(extra.ref));
    if (stale) redo.add(key);
    const reuse = prev?.prompt === prompt && (prev.gen ?? 1) >= ART_VERSION ? prev.imagePrompt : undefined;
    out.push({
      rec: { key, kind, prompt, status: 'pending', gen: ART_VERSION, roll: roll || undefined, imagePrompt: custom ?? reuse, ...extra },
      entry: { key, kind, brief: prompt, defaultBrief: derived, ref: extra.ref, variant: extra.variant, stale },
    });
  };
  const variants = (base: string, kind: AssetRecord['kind'], prompt: string, names: readonly string[]) => {
    for (const v of names) if (VARIANTS[v]?.kinds.includes(kind)) add(variantKey(base, v), kind, prompt, { ref: base, variant: v });
  };
  const sprite = (key: string, prompt: string, humanoid = false) => {
    add(key, 'sprite', prompt);
    if (poses) variants(key, 'sprite', prompt, humanoid ? HUMANOID_POSES : POSES);
  };
  for (const o of w.origins) for (const pres of PRESENTATIONS) sprite(`spr_origin_${o.id}_${pres}`, `The player's hero, ${PRESENTATION_SUBJECT[pres]}, a ${o.name}: ${o.appearance}. ${PRESENTATION_LOOK[pres]}`, true);
  for (const n of w.npcs) sprite(`spr_npc_${n.id}`, `${n.appearance}, ${n.title}`, true);
  for (const f of w.families) for (const m of f.members) sprite(`spr_mon_${f.id}_${m.archetype}`, `${m.appearance || m.name}, ${m.name}, hostile creature`);
  for (const b of w.bosses) sprite(`spr_boss_${b.id}`, `${b.appearance}, ${b.name} ${b.title}, imposing boss`);
  const used = new Set(w.zones.flatMap((z) => z.features.map((f) => `obj_${f.kind}`)));
  for (const [key, what] of Object.entries(OBJECTS)) {
    if (!used.has(key)) continue;
    add(key, 'object', `${what}, as found in ${w.concept.title}`);
    if (key === 'obj_chest') variants(key, 'object', OBJECTS[key]!, ['open']);
  }
  if (level === 'full') for (const b of w.ruleset.items) if (b.category !== 'quest' && b.category !== 'key') add(`icon_${b.id}`, 'icon', `${b.name}${b.description ? `, ${b.description}` : ''}`);
  return out;
}

/** The assets an art job would paint (only = limit to these keys and their variants). */
export function planAssets(w: WorldDefinition, level: 'essential' | 'full', only?: Set<string>): AssetRecord[] {
  return collectAssets(w, level)
    .filter((x) => x.entry.stale && (!only || only.has(x.rec.key) || (!!x.rec.ref && only.has(x.rec.ref))))
    .map((x) => x.rec);
}

/** Every asset of the world with its briefs (for the world studio). */
export function listArt(w: WorldDefinition): ArtEntry[] {
  return collectAssets(w, 'full').map((x) => x.entry);
}

/** Point world entities at generated assets. */
export function linkAssets(w: WorldDefinition) {
  const ok = (k: string) => (w.assets[k]?.status === 'ok' ? k : undefined);
  for (const o of w.origins) {
    o.asset = ok(`spr_origin_${o.id}`);
    o.assets = Object.fromEntries(PRESENTATIONS.map((p) => [p, ok(`spr_origin_${o.id}_${p}`)]).filter(([, v]) => v));
  }
  for (const n of w.npcs) n.asset = ok(`spr_npc_${n.id}`);
  for (const f of w.families) for (const m of f.members) m.asset = ok(`spr_mon_${f.id}_${m.archetype}`);
  for (const b of w.bosses) b.asset = ok(`spr_boss_${b.id}`);
}

// ------------------------------------------------------------------------------------ prompts

export const PromptBatch = z.object({ prompts: z.array(z.object({ key: z.string(), prompt: z.string().min(40).max(2400) })) });

/**
 * Turn short asset briefs into full descriptive prompts, in batches written side by side. Assets without a written
 * prompt fall back to a template.
 */
export async function writeImagePrompts(w: WorldDefinition, plan: AssetRecord[], report: (msg: string) => void, shouldStop?: () => boolean, onCount?: (done: number, total: number) => void, notes?: Map<string, string>): Promise<void> {
  if (!wantsDescriptivePrompts()) return;
  // Variants are written from a template around their base image; they need no prompt of their own.
  const todo = plan.filter((r) => !r.imagePrompt && !r.variant);
  const system = imagePromptSystem(writerProfile());
  const BATCH = 6;
  let written = 0, finished = 0;
  const batches: AssetRecord[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  // Batches run side by side (a hosted model answers several at once); each is kept as soon as it is written.
  await pool(batches, Math.max(1, genai().config.worldGenParallelism), async (batch) => {
    if (shouldStop?.()) return;
    const briefs = batch.map((r) => `[${r.key}] ${assetBrief(r, w.concept.artStyle)}${notes?.get(r.key) ? `\nEARLIER ATTEMPTS WERE REJECTED: ${notes.get(r.key)}. Write the prompt so the image avoids this.` : ''}`).join('\n\n');
    // Exactly one prompt per brief, keyed by the briefs' own keys (enforced by strict structured output).
    const keys = batch.map((r) => r.key) as [string, ...string[]];
    const schema = z.object({ prompts: z.array(z.object({ key: z.enum(keys), prompt: z.string().min(40).max(2400) })).min(batch.length).max(batch.length) });
    try {
      const out = await tries('Image prompts', report, () => genai().structured('image.prompt', {
        system,
        prompt: `World: ${w.concept.title}: ${w.concept.pitch}\nPalette: ${Object.values(w.concept.palette).join(', ')}.\nWrite one prompt per brief below. Return each with the key shown in brackets.\n\n${briefs}`,
        schema,
        name: 'image_prompts',
        maxTokens: 380 * batch.length + 200,
      }));
      for (const p of out.prompts) {
        const rec = batch.find((r) => r.key === p.key);
        if (!rec) continue;
        rec.imagePrompt = p.prompt.trim();
        w.assets[rec.key] = { ...(w.assets[rec.key] ?? rec), prompt: rec.prompt, imagePrompt: rec.imagePrompt };
        written++;
      }
    } finally {
      onCount?.(Math.min(todo.length, ++finished * BATCH), todo.length);
    }
    report(`Wrote ${written}/${todo.length} image prompts`);
  });
  for (const r of plan) if (r.imagePrompt) w.assets[r.key] = { ...(w.assets[r.key] ?? r), prompt: r.prompt, imagePrompt: r.imagePrompt };
}

// ------------------------------------------------------------------------------------ production

export interface ArtOptions {
  report: (msg: string) => void;
  /** Only these keys (and their variants). */
  only?: Set<string>;
  /** Only the assets this picks (variants go with their base). */
  pick?: (r: AssetRecord) => boolean;
  /** After each image is kept (to save the world). */
  onAsset?: () => void;
  onCount?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
  /** Image production runs through this (a build's GPU queue). */
  gpu?: (work: () => Promise<void>) => Promise<void>;
}

/** Subjects (an image with its pose frames) painted per GPU turn: one, so a place waiting on the GPU gets it soon. */
const CHUNK = 1;

export async function generateArt(w: WorldDefinition, level: 'essential' | 'full', o: ArtOptions): Promise<void> {
  const pick = o.pick ?? (() => true);
  const plan = planAssets(w, level, o.only).filter((r) => pick(r.ref ? { ...r, key: r.ref } : r));
  if (!plan.length) return;
  const gpu = o.gpu ?? ((work) => work());
  await writeImagePrompts(w, plan, o.report, o.shouldStop);
  const outDir = worldAssetDir(w.id);
  let done = 0;
  // One subject at a time: a base with its variants (painted once the base is approved), or only the variants when
  // the base was painted before.
  const subjects = new Map<string, AssetRecord[]>();
  for (const r of plan) subjects.set(r.ref ?? r.key, [...(subjects.get(r.ref ?? r.key) ?? []), r]);
  const groups = [...subjects.values()];
  for (let i = 0; i < groups.length; i += CHUNK) {
    if (o.shouldStop?.()) return;
    const chunk = groups.slice(i, i + CHUNK).flat();
    await gpu(() => produceAssets(chunk, w.concept.artStyle, outDir, w.seed, (res) => {
      w.assets[res.key] = res;
      o.onCount?.(++done, plan.length);
      o.report(`${res.status === 'ok' ? 'Painted' : res.status === 'skipped' ? 'Skipped' : 'Failed'} ${res.key}${res.score !== undefined ? ` (score ${res.score.toFixed(1)}, ${res.attempts} tries)` : ''}${res.error ? ` (${res.error.slice(0, 120)})` : ''}`);
      linkAssets(w);
      o.onAsset?.();
    }, o.shouldStop));
  }
  await repairWeak(w, plan, o, gpu);
}

/**
 * Images that never passed the checker are painted again from a rewritten prompt: the prompt writer sees what
 * was wrong (text on a sign, a haze, a background panel) and avoids it. A repair replaces the image only when it
 * scores better, so nothing gets worse; after the last pass the best attempt stays.
 */
async function repairWeak(w: WorldDefinition, plan: AssetRecord[], o: ArtOptions, gpu: (work: () => Promise<void>) => Promise<void>) {
  const minScore = genai().purpose('image.check').minScore ?? 6;
  const outDir = worldAssetDir(w.id);
  const tmp = path.join(outDir, '.repair');
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  for (let pass = 1; pass <= 2; pass++) {
    if (o.shouldStop?.()) return;
    const weak = plan.filter((r) => !r.ref).filter((r) => {
      const a = w.assets[r.key];
      return !a || a.status === 'failed' || (a.status === 'ok' && (a.score ?? 10) < minScore);
    });
    if (!weak.length) return;
    o.report(`Repairing ${weak.length} weak image${weak.length === 1 ? '' : 's'} (pass ${pass})`);
    const custom = (k: string) => !!w.artOverrides?.[k]?.imagePrompt;
    const notes = new Map(weak.map((r) => [r.key, w.assets[r.key]?.error || 'it scored poorly with the art checker']));
    const keptPrompts = new Map(weak.map((r) => [r.key, w.assets[r.key]?.imagePrompt]));
    const recs: AssetRecord[] = weak.map((r) => ({ ...r, status: 'pending', roll: (r.roll ?? 0) + 100 * pass, imagePrompt: custom(r.key) ? r.imagePrompt : undefined }));
    await writeImagePrompts(w, recs.filter((r) => !custom(r.key)), o.report, o.shouldStop, undefined, notes);
    // Variants of repaired bases are repainted with them (in the scratch folder, from the new base).
    const keys = new Set(recs.map((r) => r.key));
    const variants = plan.filter((r) => r.ref && keys.has(r.ref)).map((r) => ({ ...r, status: 'pending' as const, roll: (r.roll ?? 0) + 100 * pass }));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const better = new Set<string>();
    await gpu(() => produceAssets([...recs, ...variants], w.concept.artStyle, tmp, w.seed, (res) => {
      const old = w.assets[res.key];
      const improves = res.status === 'ok' && (!old || old.status !== 'ok' || (res.score ?? 0) > (old.score ?? 0) || (!!res.ref && better.has(res.ref)));
      if (!improves) return;
      if (!res.ref) better.add(res.key);
      fs.copyFileSync(path.join(tmp, res.file!), path.join(outDir, fileFor(res.key)));
      w.assets[res.key] = { ...res, file: fileFor(res.key) };
      o.report(`Repaired ${res.key} (score ${(old?.score ?? 0).toFixed(1)} → ${(res.score ?? 0).toFixed(1)})`);
      linkAssets(w);
      o.onAsset?.();
    }, o.shouldStop));
    fs.rmSync(tmp, { recursive: true, force: true });
    // Where the old image stays, so does the prompt that made it.
    for (const [k, prompt] of keptPrompts) if (!better.has(k) && w.assets[k]) w.assets[k] = { ...w.assets[k]!, imagePrompt: prompt };
  }
}
