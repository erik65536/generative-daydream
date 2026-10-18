/** World generation job: runs every step (LLM or procedural), assembles, generates art, saves. */
import crypto from 'node:crypto';
import { z } from 'zod';
import { LENGTH_PROFILES, Rng, SIZE_PROFILES, type Ruleset, type WorldDefinition, type WorldInput } from '@gd/shared';
import { genai } from '../genai/service';
import type { Purpose } from '../genai/types';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorld, saveWorld, worldDir, writeJsonAtomic } from '../storage';
import { enqueue, latestJob } from '../jobs/queue';
import { BANKS, detectGenre, fallbackTileset } from './genres';
import { buildSkeleton, type ZoneSlot } from './structure';
import * as S from './schemas';
import * as P from './prompts';
import * as F from './fallbacks';
import { assembleWorld, type Draft } from './assemble';
import { designBlueprint } from './blueprint';
import { applyDesign, buildingNames, zoneSize } from './rezone';
import { generateArt, linkAssets } from './art';
import { compileRuleset } from '../rules/compile';
import { designRules, reviewRules, type StepRunner } from '../rules/generate';
import { balanceRuleset } from '../rules/balance';
import { bindWorld } from '../rules/bind';
import type { RulesetIntent } from '../rules/intent';

import { Job as WorldGenJob, JobYield, workerState, type JobPhase } from '../jobs/job';
import { BudgetExceeded } from '../genai/spend';
export { WorldGenJob };
export type { JobPhase, GenLogEntry } from '../jobs/job';

/** Queue a new world: a placeholder appears in the lobby at once, a worker builds it. */
export function startWorldGeneration(input: WorldInput, owner: { id: string; name: string }, opts: { maxPerOwner?: number } = {}): { worldId: string } {
  const id = `w_${crypto.randomBytes(5).toString('hex')}`;
  // The seed is fixed now, so a build that resumes after a restart makes the same world.
  const seed = input.seed?.trim() || crypto.randomBytes(6).toString('hex');
  enqueue('world', id, owner, { input, seed }, { priority: 5, maxPerOwner: opts.maxPerOwner });
  saveWorld(placeholderWorld(id, input, owner));
  return { worldId: id };
}

/**
 * Start a failed build again from where it stopped: same input and seed, and every step that finished is kept
 * (its checkpoint). For when a model or service was down and is back.
 */
export function resumeWorldGeneration(w: WorldDefinition): void {
  const last = latestJob(w.id);
  const params = last?.kind === 'world' ? (last.params as { input: WorldInput; seed: string }) : { input: w.input, seed: w.seed || crypto.randomBytes(6).toString('hex') };
  enqueue('world', w.id, { id: w.ownerId, name: w.ownerName }, params, { priority: 5 });
  w.status = 'generating';
  saveWorld(w);
}

/** Saved output of each finished step of a build, so a resumed build skips it. */
class Checkpoints {
  private dir: string;
  constructor(worldId: string) {
    this.dir = path.join(worldDir(worldId), 'draft');
  }
  has(name: string) {
    return fs.existsSync(path.join(this.dir, `${name}.json`));
  }
  async get<T>(name: string, make: () => Promise<T> | T, onResume?: (v: T) => void): Promise<T> {
    const file = path.join(this.dir, `${name}.json`);
    if (fs.existsSync(file)) {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      onResume?.(v);
      return v;
    }
    const v = await make();
    writeJsonAtomic(file, v);
    return v;
  }
  mark(name: string) {
    writeJsonAtomic(path.join(this.dir, `${name}.json`), { at: Date.now() });
  }
}

export function placeholderWorld(id: string, input: WorldInput, owner: { id: string; name: string }): WorldDefinition {
  return {
    id, formatVersion: 1, ownerId: owner.id, ownerName: owner.name, public: true, createdAt: Date.now(), updatedAt: Date.now(), status: 'generating', seed: '', input,
    concept: { title: 'A world is being dreamed…', pitch: input.setting.slice(0, 200), genre: '', tone: '', artStyle: '', intro: '', secret: '', playerRole: '', palette: { primary: '#c8a24a', secondary: '#3a4a6a', accent: '#e0603a', ui: '#1a1a22' } },
    ruleset: undefined as unknown as Ruleset, maxLevel: 1, origins: [], uniqueItems: {}, families: [], bosses: [], tilesets: {}, zones: [], npcs: [], quests: [], arcs: [], finalQuestId: '', ending: '', lore: [], assets: {}, startZoneId: '', worldFacts: [], factions: [],
  };
}

/** Tests shorten the waits between tries (GD_RETRY_WAIT_SCALE=0). */
export const RETRY_WAIT_SCALE = Number(process.env.GD_RETRY_WAIT_SCALE ?? 1);

/** Tries per step before the build stops (it can be resumed later from its checkpoints), and the waits between. */
const STEP_TRIES = 4;
const STEP_BACKOFF_MS = [5_000, 30_000, 120_000].map((ms) => ms * RETRY_WAIT_SCALE);

/** A build step the models could not do after every try. The build stops here and can be resumed. */
export class StepFailed extends Error {}

/**
 * Run one structured step. There is no made-up stand-in when a model fails: the step is tried again (told what
 * was wrong with the last answer, when `check` found something), and after the last try the build stops.
 * `procedural` is only for a purpose explicitly configured without a model (tests, offline development).
 */
async function step<T extends z.ZodType>(job: WorldGenJob, purpose: Purpose, label: string, opts: StepOpts<T>, procedural: () => z.infer<T>): Promise<z.infer<T>> {
  const g = genai();
  if (g.isProcedural(purpose)) return procedural();
  let problem = '';
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      const prompt = problem ? `${opts.prompt}\n\nAN EARLIER ANSWER TO THIS WAS REJECTED: ${problem}\nAnswer again in full, fixing that.` : opts.prompt;
      const out = await g.structured(purpose, { system: opts.system ?? P.SYSTEM, prompt, schema: opts.schema, name: opts.name, maxTokens: opts.maxTokens });
      const bad = opts.check?.(out);
      if (bad) throw new Error(bad);
      job.push(`${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      if (job.cancelled) throw new Error('cancelled');
      if (e instanceof JobYield) throw e;
      // Out of AI budget: retrying will not help today. Stop now; resume once the budget resets.
      if (e instanceof BudgetExceeded) throw new StepFailed(`${label}: ${msg} Resume the build then.`);
      if (attempt >= STEP_TRIES) throw new StepFailed(`${label} failed ${STEP_TRIES} times (last: ${msg.slice(0, 200)}). Resume the build once the model service is working.`);
      problem = msg.slice(0, 600);
      const wait = STEP_BACKOFF_MS[attempt - 1] ?? 120_000;
      job.push(`${label}: try ${attempt} failed (${msg.slice(0, 200)}); trying again in ${Math.round(wait / 1000)}s`, 'warn');
      await new Promise((r) => setTimeout(r, wait));
      job.yieldPoint();
    }
  }
}

type StepOpts<T extends z.ZodType> = { prompt: string; schema: T; name: string; maxTokens?: number; system?: string; check?: (out: z.infer<T>) => string | null };

/** Town content must staff the town: the services the game relies on (and a companion when the party recruits). */
function missingTownRoles(npcs: { role: string; merchantKind?: string | null }[], companions: boolean): string | null {
  const has = (role: string, kinds?: string[]) => npcs.some((n) => n.role === role && (!kinds || kinds.includes(n.merchantKind ?? '')));
  const missing = [
    !has('innkeeper') && 'an innkeeper',
    !has('merchant') && 'a merchant',
    !has('merchant', ['weapons', 'armor']) && 'a weapons or armor merchant',
    !has('trainer') && 'a trainer',
    !has('guard') && 'a guard',
    companions && !has('companion') && 'a companion who can join the party',
  ].filter(Boolean);
  return missing.length ? `the town has no ${missing.join(', ')}; every town needs these among its people` : null;
}

export async function runGeneration(job: WorldGenJob, fixedSeed?: string) {
  const input = job.input;
  const seed = fixedSeed || input.seed?.trim() || crypto.randomBytes(6).toString('hex');
  const cp = new Checkpoints(job.worldId);
  const resumed = (what: string) => job.push(`${what}: kept from before the restart`);
  const rng = new Rng(seed);
  const genre = detectGenre(`${input.setting} ${input.story ?? ''} ${input.notes ?? ''}`);
  const bank = BANKS[genre];
  const sk = buildSkeleton(input, rng.fork('skeleton'));
  const setStep = (name: string, progress: number) => {
    job.step = name;
    job.progress = progress;
    job.push(name, 'step');
  };
  job.push(`Seed ${seed}. Closest procedural genre: ${genre}. ${sk.slots.length} zones in ${sk.regions.length} regions, max level ${sk.maxLevel}.`);
  const painting = input.art !== 'none' && !genai().isProcedural('image.texture');
  job.plan([
    { id: 'concept', label: 'World concept', detail: 'Title, tone, art style and who you are' },
    { id: 'rules', label: 'Rules', detail: 'Resources, classes, skill trees and gear, one step per class' },
    { id: 'atlas', label: 'Places', detail: 'Regions, towns, wilds and dungeons' },
    { id: 'families', label: 'Creatures', detail: 'Monster families and their roles' },
    { id: 'story', label: 'Main story', detail: `${sk.arcs} story arcs, key characters and bosses` },
    { id: 'zones', label: 'Towns, wilds and dungeons', detail: 'People, quests and lore for every place', total: sk.slots.length, done: 0 },
    { id: 'assemble', label: 'Building the maps', detail: 'Layouts, buildings, monsters and treasure' },
    { id: 'plans', label: 'Floor plans', detail: 'Every place planned room by room and furnished', total: sk.slots.length, done: 0 },
    { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number' },
    ...(painting ? artPhases() : []),
  ]);

  setStep('Imagining the world concept', 0.03);
  job.phase('concept');
  const concept = await cp.get('concept', () => step(job, 'world.design', 'Concept', { prompt: P.conceptPrompt(input), schema: S.ConceptSchema, name: 'world_concept', maxTokens: 4000 }, () => F.fallbackConcept(genre, input.setting, rng.fork('concept'))), () => resumed('Concept'));
  job.preview.title = concept.title;
  job.preview.pitch = concept.pitch;
  job.push(`"${concept.title}" — ${concept.pitch}`, 'preview');
  if (job.cancelled) throw new Error('cancelled');

  // ---------------------------------------------------------------- rules
  setStep('Designing the rules: resources, classes, skills and gear', 0.07);
  job.phase('rules');
  const runner = makeRunner(job);
  const rulesWorld = P.conceptSummary(concept) + '\n\n' + P.userBrief(input);
  const rulesIntent = await cp.get('rules', () => designRules(runner, rulesWorld, input, genre, (i, n) => {
    job.progress = 0.08 + 0.06 * (i / n);
    job.count('rules', i, n);
  }), () => resumed('Rules'));
  let ruleset = compileRuleset(rulesIntent, { genre, maxLevel: sk.maxLevel, overrides: input.rules, id: `rules_${job.worldId}` });
  (concept as P.ConceptWithRules)._rules = P.rulesContext(ruleset);
  job.push(`Rules "${ruleset.name}": ${ruleset.classes.map((c) => c.name).join(', ')} · ${ruleset.health.name}${ruleset.pools.length ? `, ${ruleset.pools.map((x) => x.name).join(', ')}` : ''}`, 'preview');
  if (job.cancelled) throw new Error('cancelled');

  setStep('Charting regions and places', 0.15);
  job.phase('atlas');
  const slotIds = sk.slots.map((s) => s.slotId);
  const biomeFor = (s: ZoneSlot) => rng.fork(s.slotId).pick(bank.styles[s.kind]);
  const atlasFallback = () => F.fallbackAtlas(genre, sk, rng.fork('atlas'), biomeFor);
  const atlasCheck = (a: { regions: { index: number }[]; zones: { slotId: string }[] }) => {
    const missing = sk.slots.filter((s) => !a.zones.some((z) => z.slotId === s.slotId)).map((s) => s.slotId);
    const regions = sk.regions.filter((r) => !a.regions.some((x) => x.index === r.index)).map((r) => r.index);
    return missing.length || regions.length ? `missing ${[missing.length ? `places for slots ${missing.join(', ')}` : '', regions.length ? `regions ${regions.join(', ')}` : ''].filter(Boolean).join(' and ')}; every slot and region needs an entry` : null;
  };
  let atlas = await cp.get('atlas', () => step(job, 'world.design', 'Atlas', { prompt: P.atlasPrompt(input, concept, sk), schema: S.atlasSchema(slotIds, sk.regions.length), name: 'world_atlas', maxTokens: 5000, check: atlasCheck }, atlasFallback), () => resumed('Places'));
  // De-duplicate names.
  const seen = new Set<string>();
  atlas = {
    regions: sk.regions.map((r) => atlas.regions.find((x) => x.index === r.index)!),
    zones: sk.slots.map((s) => {
      const z = atlas.zones.find((x) => x.slotId === s.slotId)!;
      let name = z.name;
      while (seen.has(name.toLowerCase())) name = `${name} ${['East', 'Deep', 'Upper', 'Lower', 'Far'][seen.size % 5]}`;
      seen.add(name.toLowerCase());
      return { ...z, name };
    }),
  };
  job.preview.zones = atlas.zones.map((z) => z.name);
  job.push(`Places: ${atlas.zones.map((z) => z.name).join(', ')}`, 'preview');

  setStep('Breeding monsters', 0.2);
  job.phase('families');
  const famCount = SIZE_PROFILES[input.size].monsterFamilies;
  const damageKinds = [...ruleset.subtypes.map((x) => x.name), ...ruleset.damageTypes.map((x) => x.name)];
  const families = await cp.get('families', () => step(job, 'world.design', 'Monster families', { prompt: P.familiesPrompt(input, concept, famCount, damageKinds), schema: S.FamiliesSchema, name: 'monster_families', maxTokens: 5000, check: (f) => (f.families.length < Math.min(2, famCount) ? `only ${f.families.length} families; ${famCount} are needed` : null) }, () => F.fallbackFamilies(genre, famCount, rng.fork('fam'))), () => resumed('Creatures'));
  job.push(`Creatures: ${families.families.map((f) => f.name).join(', ')}`, 'preview');

  setStep('Writing the main story', 0.3);
  job.phase('story');
  const townSlots = sk.slots.filter((s) => s.kind === 'town').map((s) => s.slotId);
  const dungeonSlots = sk.slots.filter((s) => s.kind === 'dungeon').map((s) => s.slotId);
  const storyFallback = () => F.fallbackStory(genre, sk, atlas, concept, rng.fork('story'));
  const story = await cp.get('story', () => step(job, 'world.design', 'Main story', { prompt: P.storyPrompt(input, concept, atlas, sk, families.families.map((f) => f.name)), schema: S.storySchema(townSlots, dungeonSlots, slotIds), name: 'main_story', maxTokens: 8000, check: (st) => (st.arcs.length < sk.arcs ? `the story has ${st.arcs.length} arcs; it needs ${sk.arcs}` : null) }, storyFallback), () => resumed('Main story'));
  job.preview.arcs = story.arcs.map((a) => a.title);
  job.preview.npcs = story.keyNpcs.map((n) => `${n.name}, ${n.title}`);
  job.push(`Arcs: ${story.arcs.map((a) => a.title).join(' → ')}`, 'preview');

  setStep('Populating towns, wilds and dungeons', 0.42);
  job.phase('zones');
  const zoneInfo = (slot: string) => atlas.zones.find((z) => z.slotId === slot)!;
  const towns: Draft['towns'] = {};
  const areas: Draft['areas'] = {};
  const size = SIZE_PROFILES[input.size];
  const familyNamesNear = (s: ZoneSlot) => s.links.flatMap((l) => (sk.slots.find((x) => x.slotId === l)?.kind !== 'town' ? [l] : [])).length ? families.families.slice(0, 3).map((f) => f.name) : [];
  const tasks: (() => Promise<void>)[] = [];
  let doneZones = 0;
  const totalZones = sk.slots.length;
  for (const s of sk.slots) {
    const zi = zoneInfo(s.slotId);
    const zr = rng.fork(`content:${s.slotId}`);
    if (s.kind === 'town') {
      const keyHere = story.keyNpcs.filter((k) => k.townSlot === s.slotId);
      // Room for every service the town needs (and a companion) plus a few ordinary people.
      const npcCount = Math.max(input.combatMode === 'party_npc' ? 8 : 7, zr.int(size.npcsPerTown[0], size.npcsPerTown[1]) - keyHere.length);
      const sideQuests = zr.int(size.sideQuestsPerTown[0], size.sideQuestsPerTown[1]);
      const nearbyZones = s.links.map((l) => zoneInfo(l).name);
      const fbTs = fallbackTileset(`ts_${s.slotId}`, zi.name, zi.biome, 'town', genre);
      const fbIn = fallbackTileset(`ts_${s.slotId}_in`, zi.name, bank.styles.interior[0]!, 'interior', genre);
      const fb = () => F.fallbackTownContent(genre, zr, zi.name, npcCount, fbTs, fbIn, { families: familyNamesNear(s), zones: nearbyZones }, sideQuests);
      tasks.push(async () => {
        job.yieldPoint();
        const out = await cp.get(`zone_${s.slotId}`, () => step(
          job,
          'world.content',
          `Town: ${zi.name}`,
          {
            prompt: P.townPrompt(input, concept, { name: zi.name, description: zi.description, lore: zi.lore, level: s.levelRange[0], region: atlas.regions[s.regionIndex]?.name ?? String(s.regionIndex) }, {
              npcCount, sideQuests, keyNpcs: keyHere.map((k) => `${k.name} (${k.title})`), nearbyZones, families: familyNamesNear(s), companions: input.combatMode === 'party_npc',
              requiredRoles: ['innkeeper', 'merchant (general)', 'merchant (weapons or armor)', 'trainer', 'guard'],
            }),
            schema: S.TownContentSchema,
            name: 'town_content',
            maxTokens: 9000,
            check: (t) => missingTownRoles(t.npcs, input.combatMode === 'party_npc'),
          },
          fb,
        ));
        towns[s.slotId] = out;
        job.progress = 0.42 + 0.33 * (++doneZones / totalZones);
        job.count('zones', doneZones);
        job.push(`${zi.name}: ${out.npcs.map((n) => n.name).slice(0, 8).join(', ')}${out.npcs.length > 8 ? '…' : ''}`, 'preview');
      });
    } else {
      const fbTs = fallbackTileset(`ts_${s.slotId}`, zi.name, zi.biome, s.kind, genre);
      const loreCount = s.kind === 'dungeon' ? 2 : 1;
      tasks.push(async () => {
        job.yieldPoint();
        const out = await cp.get(`zone_${s.slotId}`, () => step(job, 'world.content', `${s.kind === 'dungeon' ? 'Dungeon' : 'Wilds'}: ${zi.name}`, { prompt: P.areaPrompt(input, concept, { name: zi.name, kind: s.kind, description: zi.description, lore: zi.lore, level: s.levelRange, families: families.families.slice(0, 4).map((f) => f.name) }, loreCount), schema: S.AreaContentSchema, name: 'area_content', maxTokens: 5000 }, () => F.fallbackAreaContent(fbTs, zi.name, zr, genre)));
        areas[s.slotId] = out;
        job.progress = 0.42 + 0.33 * (++doneZones / totalZones);
        job.count('zones', doneZones);
      });
    }
  }
  const par = Math.max(1, genai().config.worldGenParallelism);
  await Promise.all(Array.from({ length: par }, async () => {
    for (;;) {
      if (job.cancelled) return;
      const t = tasks.shift();
      if (!t) return;
      await t();
    }
  }));

  if (job.cancelled) throw new Error('cancelled');
  let world: WorldDefinition;
  const built = cp.has('built') ? loadWorld(job.worldId) : null;
  if (built && built.status === 'ready') {
    // Built and balanced before a restart: only the painting is left.
    world = built;
    ruleset = world.ruleset;
    job.push('Maps and rules: kept from before the restart');
  } else {
    setStep('Shaping the land and placing everything', 0.78);
    job.phase('assemble');
    const draft: Draft = { id: job.worldId, input, seed, genre, skeleton: sk, concept, atlas, story, ruleset, rulesIntent, families, towns, areas, log: [] };
    world = assembleWorld(draft, job.owner);
    await floorPlans(job, world, cp);
    job.push(`Assembled ${world.zones.length} zones (${world.zones.filter((z) => z.kind === 'interior').length} interiors), ${world.npcs.length} NPCs, ${world.quests.length} quests (${world.quests.filter((q) => q.main).length} main), ${world.bosses.length} bosses, ${world.zones.reduce((s, z) => s + z.spawns.length, 0)} monsters.`);

    // ---------------------------------------------------------------- balance
    job.phase('balance');
    ruleset = await balanceWorldRules(job, world, rulesIntent, genre, runner, rulesWorld, 0.8, 0.86);
    world.generationLog = job.log.map((l) => l.msg);
    world.status = 'ready';
    saveWorld(world);
    cp.mark('built');
  }

  if (painting) {
    setStep('Painting the world', 0.82);
    await paint(job, world, input.art === 'essential' ? 'essential' : 'full', (frac) => 0.82 + 0.17 * frac);
  }
  job.finishPhases();
  job.push('The world is ready.', 'step');
}

/**
 * Each outer place gets a floor plan from the level designer (in parallel), and its map is rebuilt from it.
 * Plans are checkpointed, so a resumed build makes the same maps.
 */
async function floorPlans(job: WorldGenJob, world: WorldDefinition, cp: Checkpoints) {
  if (genai().isProcedural('world.design')) return;
  job.phase('plans');
  setStepText(job, 'Planning every place room by room', 0.79);
  const outer = world.zones.filter((z) => z.kind !== 'interior');
  let done = 0;
  const tasks = outer.map((z) => async () => {
    job.yieldPoint();
    const design = await cp.get(`plan_${z.id}`, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await designBlueprint(world, z, { size: zoneSize(world, z.kind as 'town'), buildings: z.kind === 'town' ? buildingNames(world, z) : [] });
        } catch (e) {
          if (job.cancelled) throw new Error('cancelled');
          if (e instanceof BudgetExceeded) throw new StepFailed(`Floor plan for ${z.name}: ${(e as Error).message} Resume the build then.`);
          if (attempt >= STEP_TRIES) throw new StepFailed(`Floor plan for ${z.name} failed ${STEP_TRIES} times (last: ${(e as Error).message.slice(0, 200)}). Resume the build once the model service is working.`);
          job.push(`Floor plan for ${z.name}: try ${attempt} failed (${(e as Error).message.slice(0, 160)})`, 'warn');
          await new Promise((r) => setTimeout(r, STEP_BACKOFF_MS[attempt - 1] ?? 120_000));
        }
      }
    });
    try {
      applyDesign(world, z.id, design, `${world.seed}:plan`);
      job.push(`${z.name}: ${design.blueprint.areas.map((a) => a.name).join(', ')}`, 'preview');
    } catch (e) {
      // The plan could not be built (it keeps its generic map); the build goes on.
      z.blueprint = undefined;
      job.push(`${z.name}: its floor plan could not be built (${(e as Error).message.slice(0, 160)}); keeping its first map`, 'warn');
    }
    job.count('plans', ++done);
  });
  const par = Math.max(1, genai().config.worldGenParallelism);
  await Promise.all(Array.from({ length: par }, async () => {
    for (;;) {
      if (job.cancelled) return;
      const t = tasks.shift();
      if (!t) return;
      await t();
    }
  }));
  if (job.cancelled) throw new Error('cancelled');
}

const setStepText = (job: WorldGenJob, name: string, progress: number) => {
  job.step = name;
  job.progress = progress;
  job.push(name, 'step');
};

/** Paint a world's art, saving as images arrive (and on the way out, when stopped or restarted). */
export async function paint(job: WorldGenJob, world: WorldDefinition, level: 'essential' | 'full', scale: (frac: number) => number = (f) => f, only?: Set<string>) {
  let lastSave = Date.now();
  try {
    await generateArt(world, level, (msg, frac) => {
      job.progress = scale(frac);
      job.push(msg);
    }, job, () => {
      if (Date.now() - lastSave > 5000) {
        saveWorld(world);
        lastSave = Date.now();
      }
    }, () => job.cancelled || workerState.yieldRequested, only);
    job.yieldPoint();
  } finally {
    linkAssets(world);
    saveWorld(world);
  }
}

/** The painting stages (generateArt enters each one). */
export function artPhases(): Omit<JobPhase, 'status'>[] {
  return [
    { id: 'art_prompts', label: 'Art direction', detail: 'Writing a detailed description for every image' },
    { id: 'art_textures', label: 'Ground and walls', detail: 'Surfaces for every place' },
    { id: 'art_props', label: 'Props and landmarks', detail: 'Furniture, signs, shrines, trees and the things that make each place itself' },
    { id: 'art_characters', label: 'Characters', detail: 'Heroes, people, creatures and bosses' },
    { id: 'art_items', label: 'Item icons', detail: 'Weapons, armor, potions and treasures' },
  ];
}

function makeRunner(job: WorldGenJob): StepRunner {
  return (purpose, label, opts, fallback) => step(job, purpose, label, opts, fallback);
}

/** Simulated fights take a few ms each; the budget scales with the world's length. */
function balanceBudget(input: WorldInput): number {
  if (process.env.GD_BALANCE === 'quick') return 20_000;
  return { short: 6, medium: 9, long: 12, epic: 15 }[input.length] * 60_000;
}

/**
 * Balance the world's ruleset by simulation, let the AI review flavour/structure, and rebalance if it changed
 * anything. Leaves `world.ruleset` / `world.rulesIntent` final; returns the final ruleset.
 */
async function balanceWorldRules(job: WorldGenJob, world: WorldDefinition, intent: RulesetIntent, genre: import('./genres').Genre, runner: StepRunner, worldText: string, from: number, to: number): Promise<Ruleset> {
  const quick = process.env.GD_BALANCE === 'quick';
  const families = world.families.map((f) => ({ roles: f.members.map((m) => m.archetype), subtypeId: f.element }));
  const budget = balanceBudget(world.input);
  const run = (r: Ruleset, share: number, label: string) => {
    job.step = label;
    return balanceRuleset(r, {
      mode: world.input.combatMode, seed: world.seed, families, quick, budgetMs: budget * share,
      onProgress: (m, f) => {
        job.progress = from + (to - from) * (share === 1 || label.startsWith('Re') ? f : f * 0.75);
        if (f === 1 || /Fitting|Tuning|Evening|Searching|Calibrating/.test(m)) job.push(m);
      },
    });
  };
  job.push(`Balancing the rules by simulation (up to ${Math.round(budget / 60000)} min)…`, 'step');
  let r = world.ruleset;
  let rep = run(r, 0.7, 'Balancing the rules');
  job.push(`Balance: ${rep.notes.join(' ')}${rep.outliers.length ? ` Outliers fixed: ${rep.outliers.length}.` : ''}`);
  await yieldLoop();
  if (!genai().isProcedural('world.design')) {
    const revised = await reviewRules(runner, worldText, intent, r);
    if (revised) {
      job.push('The designer revised some rules after seeing the simulation; rebalancing.');
      r = compileRuleset(revised, { genre, maxLevel: r.progression.maxLevel, overrides: world.input.rules, id: r.id });
      bindWorld(world, r, revised.classes);
      world.rulesIntent = revised;
      rep = run(r, 0.45, 'Rebalancing after review');
      job.push(`Balance: ${rep.notes.join(' ')}`);
    }
  }
  world.ruleset = r;
  return r;
}

const yieldLoop = () => new Promise((res) => setImmediate(res));

/**
 * Regenerate (new AI-designed rules) or rebalance (same intent, current engine) an existing world's rules.
 * Lore, maps and art stay; saves made under different classes become incompatible.
 */
export async function runRulesJob(job: WorldGenJob, world: WorldDefinition, mode: 'regenerate' | 'rebalance') {
  job.step = mode === 'regenerate' ? 'Designing new rules' : 'Rebalancing the rules';
  job.plan([
    ...(mode === 'regenerate' ? [{ id: 'rules', label: 'Rules', detail: 'Resources, classes, skill trees and gear, one step per class' }] : []),
    { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number, then a designer review' },
  ]);
  const genre = detectGenre(`${world.input.setting} ${world.input.story ?? ''} ${world.input.notes ?? ''}`);
  const maxLevel = LENGTH_PROFILES[world.input.length].maxLevel;
  const runner = makeRunner(job);
  const conceptText = [`WORLD: "${world.concept.title}" — ${world.concept.pitch}`, `Genre: ${world.concept.genre}. Tone: ${world.concept.tone}. The player is ${world.concept.playerRole}.`].join('\n') + '\n\n' + P.userBrief(world.input);
  let intent: RulesetIntent;
  if (mode === 'rebalance' && world.rulesIntent) intent = world.rulesIntent as RulesetIntent;
  else {
    job.push('Designing new rules for this world…', 'step');
    job.phase('rules');
    intent = await designRules(runner, conceptText, world.input, genre, (i, n) => {
      job.progress = 0.05 + 0.3 * (i / n);
      job.count('rules', i, n);
    });
  }
  const r = compileRuleset(intent, { genre, maxLevel, overrides: world.input.rules, id: `rules_${world.id}` });
  bindWorld(world, r, intent.classes);
  world.rulesIntent = intent;
  job.progress = 0.4;
  job.phase('balance');
  await balanceWorldRules(job, world, intent, genre, runner, conceptText, 0.4, 0.98);
  saveWorld(world);
  job.finishPhases();
  job.push('The rules are ready.', 'step');
}

/** Paint missing, failed or changed art for an existing world (e.g. after configuring an image model). */
export async function runArtJob(job: WorldGenJob, world: WorldDefinition, level: 'essential' | 'full') {
  job.step = 'Painting the world';
  job.plan(artPhases());
  await paint(job, world, level);
  job.finishPhases();
}
