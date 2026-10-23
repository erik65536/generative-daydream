/**
 * World art besides the painted places: every character (heroes, people, creatures, bosses) in one neutral base
 * view (front for people, side for animals: what the 3D animation step builds from), the few objects the game draws
 * over the paintings (a chest, a sign, the waypoint), and item icons. Each image's brief comes from the world; Luna
 * writes the image prompts and picks their backdrops, and checks the results.
 */
import { kinPresentation, type Presentation, type WorldDefinition } from '@gd/shared';
import { BudgetExceeded } from '../genai/spend';
import { z } from 'zod';
import { assetBrief, imagePromptSystem, produceAssets, promptEntry, type ImageRecord as AssetRecord } from '../genai/images';
import { genai } from '../genai/service';
import fs from 'node:fs';
import path from 'node:path';
import { worldAssetDir } from '../storage';

/** Bump when the pipeline improves enough that existing art should be repainted. */
export const ART_VERSION = 4;

const PRESENTATIONS = ['feminine', 'masculine', 'androgynous'] as const;
/** Player heroes come in each presentation a kin can have (each kin of a world is one); the class look itself stays gender-neutral. */
const PRESENTATION_SUBJECT: Record<(typeof PRESENTATIONS)[number], string> = {
  feminine: 'a woman (clearly female if not human)',
  masculine: 'a man (clearly male if not human)',
  androgynous: 'an androgynous person, neither clearly male nor female',
};

/** The presentations this world's heroes come in: those of its kins (all three before its rules exist). */
const heroPresentations = (w: WorldDefinition): readonly Presentation[] => {
  const kins = w.ruleset?.kins ?? [];
  return kins.length ? PRESENTATIONS.filter((p) => kins.some((k) => kinPresentation(kins, k.id) === p)) : PRESENTATIONS;
};

/** The presentation must read at a glance from the front, at game size, whatever the class description says. */
const PRESENTATION_LOOK: Record<(typeof PRESENTATIONS)[number], string> = {
  feminine: 'Her face, build and hair read as unmistakably feminine at a glance from the front (hair visible around the face or shoulders), and her outfit is cut for her, keeping its colours and pieces.',
  masculine: 'His face, build and hair read as unmistakably masculine at a glance from the front, and his outfit is cut for him, keeping its colours and pieces.',
  androgynous: 'Their face, build and hair are deliberately ambiguous, neither clearly male nor female, and their outfit keeps its colours and pieces.',
};

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
  /** Would be repainted by the next art job. */
  stale: boolean;
}

/**
 * Every asset the world uses. Repainted when missing or failed, when the brief or the owner's image prompt
 * changed, when re-rolled, or when made by an older pipeline.
 */
function collectAssets(w: WorldDefinition, level: 'essential' | 'full'): { rec: AssetRecord; entry: ArtEntry }[] {
  const out: { rec: AssetRecord; entry: ArtEntry }[] = [];
  const add = (key: string, kind: AssetRecord['kind'], derived: string, extra: Partial<AssetRecord> = {}) => {
    const prev = w.assets[key];
    const ov = w.artOverrides?.[key];
    const prompt = ov?.brief?.trim() || derived;
    const roll = ov?.roll ?? 0;
    const custom = ov?.imagePrompt?.trim() || undefined;
    const stale = !prev || prev.status !== 'ok' || prev.prompt !== prompt || (prev.gen ?? 1) < ART_VERSION || (prev.roll ?? 0) !== roll || (!!custom && prev.imagePrompt !== custom);
    // A written prompt is kept while its brief stands, with the backdrop and view chosen with it.
    const reuse = prev?.prompt === prompt && (prev.gen ?? 1) >= ART_VERSION && prev.imagePrompt && prev.backdrop ? { imagePrompt: prev.imagePrompt, backdrop: prev.backdrop, view: prev.view } : {};
    out.push({
      rec: { key, kind, prompt, status: 'pending', gen: ART_VERSION, roll: roll || undefined, ...reuse, ...(custom ? { imagePrompt: custom } : {}), ...extra },
      entry: { key, kind, brief: prompt, defaultBrief: derived, stale },
    });
  };
  // People are seen from the front; the prompt writer picks a creature's view by its body plan. Heroes are painted
  // in the presentations this world's kins have (each kin is one), not all three.
  for (const o of w.origins) for (const pres of heroPresentations(w)) add(`spr_origin_${o.id}_${pres}`, 'sprite', `The player's hero, ${PRESENTATION_SUBJECT[pres]}, a ${o.name}: ${o.appearance}. ${PRESENTATION_LOOK[pres]}`, { view: 'front' });
  for (const n of w.npcs) add(`spr_npc_${n.id}`, 'sprite', `${n.appearance}, ${n.title}`, { view: 'front' });
  for (const f of w.families) for (const m of f.members) add(`spr_mon_${f.id}_${m.archetype}`, 'sprite', `${m.appearance || m.name}, ${m.name}, hostile creature`);
  for (const b of w.bosses) add(`spr_boss_${b.id}`, 'sprite', `${b.appearance}, ${b.name} ${b.title}, imposing boss`);
  const used = new Set(w.zones.flatMap((z) => z.features.map((f) => `obj_${f.kind}`)));
  for (const [key, what] of Object.entries(OBJECTS)) if (used.has(key)) add(key, 'object', `${what}, as found in ${w.concept.title}`);
  if (level === 'full') for (const b of w.ruleset.items) if (b.category !== 'quest' && b.category !== 'key') add(`icon_${b.id}`, 'icon', `${b.name}${b.description ? `, ${b.description}` : ''}`);
  return out;
}

/** The assets an art job would paint (only = limit to these keys). */
export function planAssets(w: WorldDefinition, level: 'essential' | 'full', only?: Set<string>): AssetRecord[] {
  return collectAssets(w, level)
    .filter((x) => x.entry.stale && (!only || only.has(x.rec.key)))
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
    o.assets = Object.fromEntries(heroPresentations(w).map((p) => [p, ok(`spr_origin_${o.id}_${p}`)]).filter(([, v]) => v));
  }
  for (const n of w.npcs) n.asset = ok(`spr_npc_${n.id}`);
  for (const f of w.families) for (const m of f.members) m.asset = ok(`spr_mon_${f.id}_${m.archetype}`);
  for (const b of w.bosses) b.asset = ok(`spr_boss_${b.id}`);
}

// ------------------------------------------------------------------------------------ prompts

export const PromptBatch = z.object({ prompts: z.array(promptEntry(['key'])) });

/**
 * Turn short asset briefs into full descriptive prompts, each with its chroma-key backdrop and (for creatures) the
 * view, in batches written side by side. An owner's own image prompt is kept; the writer then only picks its
 * backdrop and view. Assets the writer leaves out fall back to a template.
 */
export async function writeImagePrompts(w: WorldDefinition, plan: AssetRecord[], report: (msg: string) => void, shouldStop?: () => boolean, onCount?: (done: number, total: number) => void, notes?: Map<string, string>): Promise<void> {
  if (genai().isProcedural('image.prompt')) return;
  const todo = plan.filter((r) => !r.imagePrompt || !r.backdrop);
  const system = imagePromptSystem();
  const BATCH = 6;
  let written = 0, finished = 0;
  const batches: AssetRecord[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  // Batches run side by side (a hosted model answers several at once); each is kept as soon as it is written.
  await pool(batches, Math.max(1, genai().config.worldGenParallelism), async (batch) => {
    if (shouldStop?.()) return;
    const briefs = batch
      .map((r) => `[${r.key}] ${assetBrief(r, w.concept.artStyle)}${r.imagePrompt ? `\nTHE PROMPT IS GIVEN (return it unchanged; choose only its backdrop and view): ${r.imagePrompt}` : ''}${notes?.get(r.key) ? `\nEARLIER ATTEMPTS WERE REJECTED: ${notes.get(r.key)}. Write the prompt so the image avoids this.` : ''}`)
      .join('\n\n');
    // Exactly one prompt per brief, keyed by the briefs' own keys (enforced by strict structured output).
    const schema = z.object({ prompts: z.array(promptEntry(batch.map((r) => r.key) as [string, ...string[]])).min(batch.length).max(batch.length) });
    try {
      const out = await tries('Image prompts', report, () => genai().structured('image.prompt', {
        system,
        prompt: `World: ${w.concept.title}: ${w.concept.pitch}\nPalette: ${Object.values(w.concept.palette).join(', ')}.\nWrite one prompt per brief below. Return each with the key shown in brackets.\n\n${briefs}`,
        schema,
        name: 'image_prompts',
        maxTokens: 400 * batch.length + 200,
      }));
      for (const p of out.prompts) {
        const rec = batch.find((r) => r.key === p.key);
        if (!rec) continue;
        rec.imagePrompt ??= p.prompt.trim();
        rec.backdrop = p.backdrop;
        // People keep the front view their brief asks for.
        rec.view = rec.kind === 'sprite' ? (rec.view ?? p.view) : undefined;
        w.assets[rec.key] = { ...(w.assets[rec.key] ?? rec), prompt: rec.prompt, imagePrompt: rec.imagePrompt, backdrop: rec.backdrop, view: rec.view };
        written++;
      }
    } finally {
      onCount?.(Math.min(todo.length, ++finished * BATCH), todo.length);
    }
    report(`Wrote ${written}/${todo.length} image prompts`);
  });
}

// ------------------------------------------------------------------------------------ production

export interface ArtOptions {
  report: (msg: string) => void;
  /** Only these keys. */
  only?: Set<string>;
  /** Only the assets this picks. */
  pick?: (r: AssetRecord) => boolean;
  /** After each image is kept (to save the world). */
  onAsset?: () => void;
  onCount?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
  /** Image production runs through this (a build's GPU queue). */
  gpu?: (work: () => Promise<void>) => Promise<void>;
}

export async function generateArt(w: WorldDefinition, level: 'essential' | 'full', o: ArtOptions): Promise<void> {
  const pick = o.pick ?? (() => true);
  const plan = planAssets(w, level, o.only).filter(pick);
  if (!plan.length) return;
  const gpu = o.gpu ?? ((work) => work());
  await writeImagePrompts(w, plan, o.report, o.shouldStop);
  const outDir = worldAssetDir(w.id);
  let done = 0;
  // One image per GPU turn, so a place waiting on the GPU gets it soon.
  for (const rec of plan) {
    if (o.shouldStop?.()) return;
    await gpu(() => produceAssets([rec], w.concept.artStyle, outDir, w.seed, (res) => {
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
 * Images that never passed are painted again from a rewritten prompt: the prompt writer sees what was wrong (text
 * on a sign, the wrong pose, a backdrop colour that clashed) and avoids it. A repair replaces the image only when it
 * scores better, so nothing gets worse; after the last pass the best attempt stays.
 */
async function repairWeak(w: WorldDefinition, plan: AssetRecord[], o: ArtOptions, gpu: (work: () => Promise<void>) => Promise<void>) {
  const minScore = genai().purpose('image.check').minScore ?? 6;
  const outDir = worldAssetDir(w.id);
  const tmp = path.join(outDir, '.repair');
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  for (let pass = 1; pass <= 2; pass++) {
    if (o.shouldStop?.()) return;
    const weak = plan.filter((r) => {
      const a = w.assets[r.key];
      return !a || a.status === 'failed' || (a.status === 'ok' && ((a.score ?? 10) < minScore || !!a.error));
    });
    if (!weak.length) return;
    o.report(`Repairing ${weak.length} weak image${weak.length === 1 ? '' : 's'} (pass ${pass})`);
    const custom = (k: string) => w.artOverrides?.[k]?.imagePrompt?.trim() || undefined;
    const notes = new Map(weak.map((r) => [r.key, w.assets[r.key]?.error || 'it scored poorly with the art checker']));
    const kept = new Map(weak.map((r) => [r.key, w.assets[r.key]]));
    const recs: AssetRecord[] = weak.map((r) => ({ ...r, status: 'pending', roll: (r.roll ?? 0) + 100 * pass, imagePrompt: custom(r.key), backdrop: undefined, view: r.key.startsWith('spr_origin_') || r.key.startsWith('spr_npc_') ? 'front' : undefined }));
    await writeImagePrompts(w, recs, o.report, o.shouldStop, undefined, notes);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const better = new Set<string>();
    await gpu(() => produceAssets(recs, w.concept.artStyle, tmp, w.seed, (res) => {
      const old = kept.get(res.key);
      const improves = res.status === 'ok' && (!old || old.status !== 'ok' || (res.score ?? 0) > (old.score ?? 0));
      if (!improves) return;
      better.add(res.key);
      fs.copyFileSync(path.join(tmp, res.file!), path.join(outDir, fileFor(res.key)));
      w.assets[res.key] = { ...res, file: fileFor(res.key) };
      o.report(`Repaired ${res.key} (score ${(old?.score ?? 0).toFixed(1)} → ${(res.score ?? 0).toFixed(1)})`);
      linkAssets(w);
      o.onAsset?.();
    }, o.shouldStop));
    fs.rmSync(tmp, { recursive: true, force: true });
    // Where the old image stays, so do the prompt, backdrop and view that made it.
    for (const [k, old] of kept) if (!better.has(k) && old) w.assets[k] = old;
  }
}
