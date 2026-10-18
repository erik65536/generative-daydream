/**
 * World art: an art-direction pass that makes every place's elements specific to it, then the plan of every
 * image the world needs (surfaces, props and landmarks, characters with pose frames, item icons) and its
 * production through the image pipeline, stage by stage.
 */
import type { AssetRecord, TileRole, TileRoleDef, TilesetDef, WorldDefinition } from '@gd/shared';
import { BudgetExceeded } from '../genai/spend';
import { OBJ, base64ToBytes } from '@gd/shared';
import { z } from 'zod';
import { VARIANTS, assetBrief, imagePromptSystem, produceAssets, supportsVariants, variantKey, wantsDescriptivePrompts, writerProfile } from '../genai/images';
import { genai } from '../genai/service';
import fs from 'node:fs';
import path from 'node:path';
import { worldAssetDir } from '../storage';
import { RoleDefSchema, normColors } from './schemas';
import { conceptSummary } from './prompts';

/** Bump when the pipeline improves enough that existing art should be repainted. */
export const ART_VERSION = 2;

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

const TEXTURE_ROLES: TileRole[] = ['floor', 'floorAlt', 'path', 'wall', 'water'];
const OBJ_ROLE: Record<number, TileRole> = { [OBJ.tree]: 'tree', [OBJ.rock]: 'rock', [OBJ.plant]: 'plant', [OBJ.light]: 'light', [OBJ.furniture]: 'furniture', [OBJ.rubble]: 'rubble', [OBJ.pillar]: 'pillar' };
const FEATURE_ROLE: Record<string, TileRole> = { chest: 'chest', shrine: 'shrine', sign: 'sign', lever: 'lever', bed: 'bed' };
const POSES = ['walk_a', 'walk_b', 'attack'] as const;
/** Humanoids walk and attack with pose-guided frames (8 and 4); other bodies keep two painted strides and one strike. */
const HUMANOID_POSES = ['walk', 'strike'] as const;

/** What a job reports while painting (a WorldGenJob fits). */
export interface ArtProgress {
  phase(id: string, counts?: { done?: number; total?: number }): void;
  count(id: string, done: number, total?: number): void;
}

// ------------------------------------------------------------------------------------ art direction

/** Roles that are drawn from art (doors and exits stay procedural). */
const DIRECTED_ROLES: TileRole[] = ['floor', 'floorAlt', 'path', 'water', 'wall', 'tree', 'rock', 'plant', 'light', 'furniture', 'rubble', 'pillar', 'chest', 'shrine', 'sign', 'lever', 'bed'];

export const DirectionSchema = z.object({
  roles: z.object(Object.fromEntries(DIRECTED_ROLES.map((r) => [r, RoleDefSchema])) as Record<TileRole, typeof RoleDefSchema>),
  roof: RoleDefSchema.optional(),
  craft: RoleDefSchema.optional(),
});

const DIRECTION_SYSTEM = `You are the art director of a game. For one place, you decide what each of its fixed visual elements looks like so the place is unmistakably itself.

Each element is a fixed game function. Reinterpret every one for this specific place instead of using a generic fantasy default. For example, in a parking garage: floor is oil-stained concrete with faded painted bay lines, tree is a massive concrete support column, rock is an abandoned shopping cart, plant is a cluster of orange traffic cones, furniture is a parked dusty sedan, light is a caged fluorescent lamp on a pole, chest is a dented steel parts locker, shrine is a wall-mounted first-aid station, bed is a sleeping bag on flattened cardboard, sign is a level marker sign.

Every object element stands on the floor of the map and is seen from above at an angle, so choose a free-standing version: a floor lamp or lamp post rather than a ceiling fixture, a standing sign rather than a wall plaque. Surfaces are materials the engine tiles across whole areas of the map and draws the edges of itself:
- floor is the main walkable ground; floorAlt is a second, related ground that breaks it up in patches (a worn, stained, older or different finish of the same kind of place); path is the ground of lanes, roads or corridors.
- water is what fills the impassable expanses (a liquid, a drop, a void): describe that substance itself as it would look across a large area, never the container, basin, rim, hole or the floor around it.
- Describe every surface as one continuous material seen from above, with no shapes on it: never a pool, puddle, patch, stain, hole or object lying on another surface, and nothing in the middle.
- Give every surface visible detail and mid-tone colours so it reads on the map: a dark substance or a void still shows its sheen, ripples, grain or drifting specks in a deep colour rather than flat black.

For every element give a short name, 1-3 hex colours, and a prompt of 12-30 words describing only the physical thing: its shape, materials, colours, wear and details. Prompts never mention lighting, weather, fog, mist, smoke, glows, auras, surroundings or art style. Surfaces (floor, floorAlt, path, wall, water, roof) describe only their own material.`;

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

/** The zone's layout in words, so each element is chosen for the job it does on this map. */
function describePlan(z: WorldDefinition['zones'][number]): string {
  const p = z.layout;
  if (!p) return z.indoor ? 'enclosed' : 'under the open sky';
  const parts = [
    p.enclosed ? 'enclosed (under a roof or ceiling)' : 'under the open sky',
    { open: 'free-form ground', grid: 'blocks between straight lanes', hub: 'a centre with enterable structures around it', rooms: 'chambers joined by corridors', caves: 'irregular connected hollows' }[p.structure],
    `the "tree" element is the ${p.blockers.amount} large impassable thing, arranged ${{ scattered: 'scattered about', clusters: 'in clusters', rows: 'in regular rows', edges: 'along the edges' }[p.blockers.arrangement]}`,
    p.hazard === 'none' ? 'little or no "water" element' : `the "water" element forms ${p.hazard} (impassable liquid, chasm or void)`,
    z.kind === 'town' ? `enterable places are ${p.structures === 'roofed' ? 'roofed buildings' : 'walled rooms or enclosures seen from above'} whose outer walls use the "wall" element` : '',
  ];
  return parts.filter(Boolean).join('; ');
}

/** Rewrite each tileset's elements so they fit the place (once per tileset). */
export async function directTilesets(w: WorldDefinition, report: (msg: string) => void, shouldStop?: () => boolean, onCount?: (done: number, total: number) => void, opts?: { only?: string[]; guidance?: string }): Promise<void> {
  const g = genai();
  if (g.isProcedural('world.design')) return;
  const todo = opts?.only ? opts.only.map((id) => w.tilesets[id]).filter((t): t is TilesetDef => !!t) : Object.values(w.tilesets).filter((t) => !t.directed);
  let n = 0;
  await pool(todo, Math.max(1, g.config.worldGenParallelism), async (ts) => {
    if (shouldStop?.()) return;
    const zones = w.zones.filter((z) => z.tilesetId === ts.id);
    const z = zones.find((x) => x.kind !== 'interior') ?? zones[0];
    if (!z) return;
    const outer = z.kind === 'interior' ? w.zones.find((x) => x.id === z.parentZoneId) : undefined;
    const place = z.kind === 'interior' ? `inside the buildings of ${outer?.name ?? 'a town'} (${outer?.description ?? ''})` : `${z.name}, a ${z.kind}: ${z.description}\nLEVEL DESIGN: ${describePlan(z)}`;
    // Surfaces are listed by name only: their old descriptions often draw shapes (pools, patches) that do not tile.
    const current = DIRECTED_ROLES.map((r) => (TEXTURE_ROLES.includes(r) ? `${r}: ${ts.roles[r].name}` : `${r}: ${ts.roles[r].name} (${ts.roles[r].prompt})`)).join('\n');
    try {
      const out = await tries(`Art direction for ${z.name}`, report, () => g.structured('world.design', {
        system: DIRECTION_SYSTEM,
        prompt: `${conceptSummary(w.concept as never)}\n\nPLACE: ${place}\n\nCurrent elements (keep what already fits and follows the rules above, replace anything generic, remove atmosphere words):\n${current}\n\nGive all elements${z.kind === 'town' && !z.indoor && z.layout?.structures !== 'walled' ? ', plus "roof" (the roofing of its buildings, seen from above)' : ''}, plus "craft" (the workbench or station where people make things here).${opts?.guidance ? `

THE OWNER'S DIRECTION FOR THIS PLACE (follow it, within the rules above): ${opts.guidance}` : ''}`,
        schema: DirectionSchema,
        name: 'art_direction',
        maxTokens: 3000,
      }));
      const role = (v: { name: string; colors: string[]; prompt: string }, prev?: TileRoleDef): TileRoleDef => ({ name: v.name, colors: normColors(v.colors).length ? normColors(v.colors) : prev?.colors ?? ['#808080'], prompt: v.prompt, asset: prev?.asset });
      for (const r of DIRECTED_ROLES) if (out.roles[r]) ts.roles[r] = role(out.roles[r], ts.roles[r]);
      ts.extras = { ...(ts.extras ?? {}), ...(out.roof ? { roof: role(out.roof, ts.extras?.roof) } : {}), ...(out.craft ? { craft: role(out.craft, ts.extras?.craft) } : {}) };
      ts.directed = true;
      report(`Art direction for ${z.kind === 'interior' ? `${outer?.name ?? z.name} interiors` : z.name}: ${DIRECTED_ROLES.slice(5, 11).map((r) => ts.roles[r].name).join(', ')}`);
    } finally {
      onCount?.(++n, todo.length);
    }
  });
}

// ------------------------------------------------------------------------------------ plan

/** Which object roles, features and surfaces each tileset's zones actually use. */
function usage(w: WorldDefinition, ts: TilesetDef) {
  const roles = new Set<TileRole>(TEXTURE_ROLES);
  let craft = false, roof = false;
  for (const z of w.zones.filter((x) => x.tilesetId === ts.id)) {
    const objs = base64ToBytes(z.objects);
    const seen = new Set<number>();
    for (let i = 0; i < objs.length; i++) seen.add(objs[i]!);
    for (const code of seen) if (OBJ_ROLE[code]) roles.add(OBJ_ROLE[code]!);
    for (const f of z.features) {
      if (FEATURE_ROLE[f.kind]) roles.add(FEATURE_ROLE[f.kind]!);
      if (f.kind === 'craft_station') craft = true;
    }
    if (z.kind === 'town' && !z.indoor && z.layout?.structures !== 'walled') roof = true;
  }
  return { roles, craft, roof };
}

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
  for (const ts of Object.values(w.tilesets)) {
    const use = usage(w, ts);
    for (const r of TEXTURE_ROLES) add(`tex_${ts.id}_${r}`, 'texture', `${ts.roles[r].prompt || ts.roles[r].name}`);
    if (use.roof && ts.extras?.roof) add(`tex_${ts.id}_roof`, 'texture', ts.extras.roof.prompt);
    for (const r of DIRECTED_ROLES) {
      if (TEXTURE_ROLES.includes(r) || !use.roles.has(r)) continue;
      // Every object stands on the map's floor; a light in particular must be a free-standing version.
      const stand = r === 'light' ? ', shown as a free-standing light source on its own stand or base' : r === 'sign' ? ', its face left blank: plain panels with no letters, numbers, symbols or logos' : '';
      const prompt = `${ts.roles[r].name}: ${ts.roles[r].prompt || ts.roles[r].name}${stand} (found in ${ts.name})`;
      add(`obj_${ts.id}_${r}`, 'object', prompt);
      if (r === 'chest') variants(`obj_${ts.id}_${r}`, 'object', prompt, ['open']);
    }
    if (use.craft) add(`obj_${ts.id}_craft`, 'object', ts.extras?.craft ? `${ts.extras.craft.name}: ${ts.extras.craft.prompt} (found in ${ts.name})` : `a workbench where people make and mend things in ${ts.name}`);
  }
  const sprite = (key: string, prompt: string, humanoid = false) => {
    add(key, 'sprite', prompt);
    if (poses) variants(key, 'sprite', prompt, humanoid ? HUMANOID_POSES : POSES);
  };
  for (const o of w.origins) for (const pres of PRESENTATIONS) sprite(`spr_origin_${o.id}_${pres}`, `The player's hero, ${PRESENTATION_SUBJECT[pres]}, a ${o.name}: ${o.appearance}. ${PRESENTATION_LOOK[pres]}`, true);
  for (const n of w.npcs) sprite(`spr_npc_${n.id}`, `${n.appearance}, ${n.title}`, true);
  for (const f of w.families) for (const m of f.members) sprite(`spr_mon_${f.id}_${m.archetype}`, `${m.appearance || m.name}, ${m.name}, hostile creature`);
  for (const b of w.bosses) sprite(`spr_boss_${b.id}`, `${b.appearance}, ${b.name} ${b.title}, imposing boss`);
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
  for (const ts of Object.values(w.tilesets)) {
    for (const r of Object.keys(ts.roles) as TileRole[]) ts.roles[r].asset = ok(`tex_${ts.id}_${r}`) ?? ok(`obj_${ts.id}_${r}`);
    if (ts.extras?.roof) ts.extras.roof.asset = ok(`tex_${ts.id}_roof`);
    if (ts.extras?.craft) ts.extras.craft.asset = ok(`obj_${ts.id}_craft`);
  }
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
 * Turn short asset briefs into full descriptive prompts, in batches, while the text model is still resident
 * (so a local GPU swaps to the image model once). Assets without a written prompt fall back to a template.
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

const STAGES: { id: string; pick: (r: AssetRecord) => boolean }[] = [
  { id: 'art_textures', pick: (r) => r.kind === 'texture' },
  { id: 'art_props', pick: (r) => r.kind === 'object' },
  { id: 'art_characters', pick: (r) => r.kind === 'sprite' },
  { id: 'art_items', pick: (r) => r.kind === 'icon' },
];

export async function generateArt(w: WorldDefinition, level: 'essential' | 'full', report: (msg: string, frac: number) => void, progress?: ArtProgress, onAsset?: () => void, shouldStop?: () => boolean, only?: Set<string>): Promise<void> {
  const outDir = worldAssetDir(w.id);
  progress?.phase('art_prompts');
  await directTilesets(w, (m) => report(m, 0), shouldStop, (d, t) => progress?.count('art_prompts', d, t));
  const plan = planAssets(w, level, only);
  await writeImagePrompts(w, plan, (m) => report(m, 0), shouldStop, (d, t) => progress?.count('art_prompts', d, t));
  report(`Painting ${plan.length} images…`, 0);
  let done = 0;
  for (const stage of STAGES) {
    const recs = plan.filter(stage.pick);
    if (!recs.length) continue;
    progress?.phase(stage.id, { done: 0, total: recs.length });
    let stageDone = 0;
    // Chunks keep results flowing in while limiting model swaps (generate chunk → score chunk → retry rejects).
    // Variants ride along with their bases (painted once the base is approved); variants of bases painted
    // earlier go in the first chunk.
    const bases = recs.filter((r) => !r.ref);
    const CHUNK = 40;
    for (let i = 0; i < Math.max(1, bases.length); i += CHUNK) {
      if (shouldStop?.()) return;
      const chunkBases = bases.slice(i, i + CHUNK);
      const keys = new Set(chunkBases.map((r) => r.key));
      const chunk = [...chunkBases, ...recs.filter((r) => r.ref && (keys.has(r.ref) || (i === 0 && !bases.some((b) => b.key === r.ref))))];
      if (!chunk.length) continue;
      await produceAssets(chunk, w.concept.artStyle, outDir, w.seed, (res) => {
        w.assets[res.key] = res;
        done++;
        progress?.count(stage.id, ++stageDone);
        report(`${res.status === 'ok' ? 'Painted' : res.status === 'skipped' ? 'Skipped' : 'Failed'} ${res.key}${res.score !== undefined ? ` (score ${res.score.toFixed(1)}, ${res.attempts} tries)` : ''}${res.error ? ` (${res.error.slice(0, 120)})` : ''}`, done / Math.max(1, plan.length));
        linkAssets(w);
        onAsset?.();
      }, shouldStop);
    }
  }
  await repairWeak(w, plan, report, onAsset, shouldStop);
}

/**
 * Images that never passed the checker are painted again from a rewritten prompt: the prompt writer sees what
 * was wrong (text on a sign, a puddle instead of a surface, a haze) and avoids it. A repair replaces the image
 * only when it scores better, so nothing gets worse; after the last pass the best attempt stays.
 */
async function repairWeak(w: WorldDefinition, plan: AssetRecord[], report: (msg: string, frac: number) => void, onAsset?: () => void, shouldStop?: () => boolean) {
  const minScore = genai().purpose('image.check').minScore ?? 6;
  const outDir = worldAssetDir(w.id);
  const tmp = path.join(outDir, '.repair');
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  for (let pass = 1; pass <= 2; pass++) {
    if (shouldStop?.()) return;
    const weak = plan.filter((r) => !r.ref).filter((r) => {
      const a = w.assets[r.key];
      return !a || a.status === 'failed' || (a.status === 'ok' && (a.score ?? 10) < minScore);
    });
    if (!weak.length) return;
    report(`Repairing ${weak.length} weak image${weak.length === 1 ? '' : 's'} (pass ${pass})`, 1);
    const custom = (k: string) => !!w.artOverrides?.[k]?.imagePrompt;
    const notes = new Map(weak.map((r) => [r.key, w.assets[r.key]?.error || 'it scored poorly with the art checker']));
    const keptPrompts = new Map(weak.map((r) => [r.key, w.assets[r.key]?.imagePrompt]));
    const recs: AssetRecord[] = weak.map((r) => ({ ...r, status: 'pending', roll: (r.roll ?? 0) + 100 * pass, imagePrompt: custom(r.key) ? r.imagePrompt : undefined }));
    await writeImagePrompts(w, recs.filter((r) => !custom(r.key)), (m) => report(m, 1), shouldStop, undefined, notes);
    // Variants of repaired bases are repainted with them (in the scratch folder, from the new base).
    const keys = new Set(recs.map((r) => r.key));
    const variants = plan.filter((r) => r.ref && keys.has(r.ref)).map((r) => ({ ...r, status: 'pending' as const, roll: (r.roll ?? 0) + 100 * pass }));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const better = new Set<string>();
    for (const stage of STAGES) {
      const batch = [...recs, ...variants].filter((r) => stage.pick(r) && (!r.ref || keys.has(r.ref)));
      if (!batch.length) continue;
      await produceAssets(batch, w.concept.artStyle, tmp, w.seed, (res) => {
        const old = w.assets[res.key];
        const improves = res.status === 'ok' && (!old || old.status !== 'ok' || (res.score ?? 0) > (old.score ?? 0) || (!!res.ref && better.has(res.ref)));
        if (!improves) return;
        if (!res.ref) better.add(res.key);
        fs.copyFileSync(path.join(tmp, res.file!), path.join(outDir, fileFor(res.key)));
        w.assets[res.key] = { ...res, file: fileFor(res.key) };
        report(`Repaired ${res.key} (score ${(old?.score ?? 0).toFixed(1)} → ${(res.score ?? 0).toFixed(1)})`, 1);
        linkAssets(w);
        onAsset?.();
      }, shouldStop);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    // Where the old image stays, so does the prompt that made it.
    for (const [k, prompt] of keptPrompts) if (!better.has(k) && w.assets[k]) w.assets[k] = { ...w.assets[k]!, imagePrompt: prompt };
  }
}
