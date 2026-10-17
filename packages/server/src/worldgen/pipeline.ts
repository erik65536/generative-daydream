/** World generation job: runs every step (LLM or procedural), assembles, generates art, saves. */
import crypto from 'node:crypto';
import { z } from 'zod';
import { LENGTH_PROFILES, Rng, SIZE_PROFILES, type Ruleset, type WorldDefinition, type WorldInput } from '@gd/shared';
import { genai } from '../genai/service';
import type { Purpose } from '../genai/types';
import { saveWorld } from '../storage';
import { BANKS, detectGenre, fallbackTileset } from './genres';
import { buildSkeleton, type ZoneSlot } from './structure';
import * as S from './schemas';
import * as P from './prompts';
import * as F from './fallbacks';
import { assembleWorld, type Draft } from './assemble';
import { generateArt, linkAssets } from './art';
import { compileRuleset } from '../rules/compile';
import { designRules, reviewRules, type StepRunner } from '../rules/generate';
import { balanceRuleset } from '../rules/balance';
import { bindWorld } from '../rules/bind';
import type { RulesetIntent } from '../rules/intent';

export interface GenLogEntry {
  t: number;
  msg: string;
  kind: 'step' | 'info' | 'warn' | 'error' | 'preview';
}

export class WorldGenJob {
  progress = 0;
  step = 'Queued';
  log: GenLogEntry[] = [];
  status: 'running' | 'done' | 'failed' = 'running';
  error?: string;
  preview: { title?: string; pitch?: string; zones?: string[]; npcs?: string[]; arcs?: string[] } = {};
  cancelled = false;
  constructor(public readonly worldId: string, public readonly input: WorldInput, public readonly owner: { id: string; name: string }) {}
  push(msg: string, kind: GenLogEntry['kind'] = 'info') {
    this.log.push({ t: Date.now(), msg, kind });
    if (this.log.length > 400) this.log.shift();
    if (kind !== 'preview') console.log(`[worldgen ${this.worldId}] ${msg}`);
  }
}

const jobs = new Map<string, WorldGenJob>();
export const getJob = (worldId: string) => jobs.get(worldId);

export function startWorldGeneration(input: WorldInput, owner: { id: string; name: string }): WorldGenJob {
  const id = `w_${crypto.randomBytes(5).toString('hex')}`;
  const job = new WorldGenJob(id, input, owner);
  jobs.set(id, job);
  // Placeholder so the world appears in the lobby while generating.
  saveWorld(placeholderWorld(id, input, owner));
  void runGeneration(job).catch((e) => {
    job.status = 'failed';
    job.error = (e as Error).message;
    job.push(`Generation failed: ${(e as Error).stack ?? e}`, 'error');
    const w = placeholderWorld(id, input, owner);
    w.status = 'failed';
    saveWorld(w);
  });
  return job;
}

function placeholderWorld(id: string, input: WorldInput, owner: { id: string; name: string }): WorldDefinition {
  return {
    id, formatVersion: 1, ownerId: owner.id, ownerName: owner.name, public: true, createdAt: Date.now(), updatedAt: Date.now(), status: 'generating', seed: '', input,
    concept: { title: 'A world is being dreamed…', pitch: input.setting.slice(0, 200), genre: '', tone: '', artStyle: '', intro: '', secret: '', playerRole: '', palette: { primary: '#c8a24a', secondary: '#3a4a6a', accent: '#e0603a', ui: '#1a1a22' } },
    ruleset: undefined as unknown as Ruleset, maxLevel: 1, origins: [], uniqueItems: {}, families: [], bosses: [], tilesets: {}, zones: [], npcs: [], quests: [], arcs: [], finalQuestId: '', ending: '', lore: [], assets: {}, startZoneId: '', worldFacts: [], factions: [],
  };
}

/** Run one structured step, falling back to procedural content on any failure. */
async function step<T extends z.ZodType>(job: WorldGenJob, purpose: Purpose, label: string, opts: { prompt: string; schema: T; name: string; maxTokens?: number; system?: string }, fallback: () => z.infer<T>): Promise<z.infer<T>> {
  const g = genai();
  if (g.isProcedural(purpose)) return fallback();
  const t0 = Date.now();
  try {
    const out = await g.structured(purpose, { system: opts.system ?? P.SYSTEM, prompt: opts.prompt, schema: opts.schema, name: opts.name, maxTokens: opts.maxTokens });
    job.push(`${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return out;
  } catch (e) {
    job.push(`${label}: model output unusable (${(e as Error).message.slice(0, 200)}); using procedural content`, 'warn');
    return fallback();
  }
}

export async function runGeneration(job: WorldGenJob) {
  const input = job.input;
  const seed = input.seed?.trim() || crypto.randomBytes(6).toString('hex');
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

  setStep('Imagining the world concept', 0.03);
  const concept = await step(job, 'world.design', 'Concept', { prompt: P.conceptPrompt(input), schema: S.ConceptSchema, name: 'world_concept', maxTokens: 4000 }, () => F.fallbackConcept(genre, input.setting, rng.fork('concept')));
  job.preview.title = concept.title;
  job.preview.pitch = concept.pitch;
  job.push(`"${concept.title}" — ${concept.pitch}`, 'preview');
  if (job.cancelled) throw new Error('cancelled');

  // ---------------------------------------------------------------- rules
  setStep('Designing the rules: resources, classes, skills and gear', 0.07);
  const runner = makeRunner(job);
  const rulesWorld = P.conceptSummary(concept) + '\n\n' + P.userBrief(input);
  const rulesIntent = await designRules(runner, rulesWorld, input, genre, (i, n) => (job.progress = 0.08 + 0.06 * (i / n)));
  let ruleset = compileRuleset(rulesIntent, { genre, maxLevel: sk.maxLevel, overrides: input.rules, id: `rules_${job.worldId}` });
  (concept as P.ConceptWithRules)._rules = P.rulesContext(ruleset);
  job.push(`Rules "${ruleset.name}": ${ruleset.classes.map((c) => c.name).join(', ')} · ${ruleset.health.name}${ruleset.pools.length ? `, ${ruleset.pools.map((x) => x.name).join(', ')}` : ''}`, 'preview');
  if (job.cancelled) throw new Error('cancelled');

  setStep('Charting regions and places', 0.15);
  const slotIds = sk.slots.map((s) => s.slotId);
  const biomeFor = (s: ZoneSlot) => rng.fork(s.slotId).pick(bank.styles[s.kind]);
  const atlasFallback = () => F.fallbackAtlas(genre, sk, rng.fork('atlas'), biomeFor);
  let atlas = await step(job, 'world.design', 'Atlas', { prompt: P.atlasPrompt(input, concept, sk), schema: S.atlasSchema(slotIds), name: 'world_atlas', maxTokens: 5000 }, atlasFallback);
  // Backfill zones the model skipped and de-duplicate names.
  const fbAtlas = atlasFallback();
  const seen = new Set<string>();
  atlas = {
    regions: sk.regions.map((r) => atlas.regions.find((x) => x.index === r.index) ?? fbAtlas.regions[r.index]!),
    zones: sk.slots.map((s) => {
      const z = atlas.zones.find((x) => x.slotId === s.slotId) ?? fbAtlas.zones.find((x) => x.slotId === s.slotId)!;
      let name = z.name;
      while (seen.has(name.toLowerCase())) name = `${name} ${['East', 'Deep', 'Upper', 'Lower', 'Far'][seen.size % 5]}`;
      seen.add(name.toLowerCase());
      return { ...z, name };
    }),
  };
  job.preview.zones = atlas.zones.map((z) => z.name);
  job.push(`Places: ${atlas.zones.map((z) => z.name).join(', ')}`, 'preview');

  setStep('Breeding monsters', 0.2);
  const famCount = SIZE_PROFILES[input.size].monsterFamilies;
  const damageKinds = [...ruleset.subtypes.map((x) => x.name), ...ruleset.damageTypes.map((x) => x.name)];
  const families = await step(job, 'world.design', 'Monster families', { prompt: P.familiesPrompt(input, concept, famCount, damageKinds), schema: S.FamiliesSchema, name: 'monster_families', maxTokens: 5000 }, () => F.fallbackFamilies(genre, famCount, rng.fork('fam')));
  if (families.families.length < 2) families.families.push(...F.fallbackFamilies(genre, 2, rng.fork('fam2')).families);
  job.push(`Creatures: ${families.families.map((f) => f.name).join(', ')}`, 'preview');

  setStep('Writing the main story', 0.3);
  const townSlots = sk.slots.filter((s) => s.kind === 'town').map((s) => s.slotId);
  const dungeonSlots = sk.slots.filter((s) => s.kind === 'dungeon').map((s) => s.slotId);
  const storyFallback = () => F.fallbackStory(genre, sk, atlas, concept, rng.fork('story'));
  let story = await step(job, 'world.design', 'Main story', { prompt: P.storyPrompt(input, concept, atlas, sk, families.families.map((f) => f.name)), schema: S.storySchema(townSlots, dungeonSlots, slotIds), name: 'main_story', maxTokens: 8000 }, storyFallback);
  if (story.arcs.length < sk.arcs) {
    const fb = storyFallback();
    job.push(`Story had ${story.arcs.length}/${sk.arcs} arcs; extending with procedural arcs`, 'warn');
    story = { ...story, arcs: [...story.arcs, ...fb.arcs.slice(story.arcs.length)], keyNpcs: [...story.keyNpcs, ...fb.keyNpcs.filter((k) => !story.keyNpcs.some((x) => x.key === k.key))], bosses: [...story.bosses, ...fb.bosses.slice(story.bosses.length)], keyItems: [...story.keyItems, ...fb.keyItems.filter((k) => !story.keyItems.some((x) => x.key === k.key))] };
  }
  job.preview.arcs = story.arcs.map((a) => a.title);
  job.preview.npcs = story.keyNpcs.map((n) => `${n.name}, ${n.title}`);
  job.push(`Arcs: ${story.arcs.map((a) => a.title).join(' → ')}`, 'preview');

  setStep('Populating towns, wilds and dungeons', 0.42);
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
      const npcCount = Math.max(3, zr.int(size.npcsPerTown[0], size.npcsPerTown[1]) - keyHere.length);
      const sideQuests = zr.int(size.sideQuestsPerTown[0], size.sideQuestsPerTown[1]);
      const nearbyZones = s.links.map((l) => zoneInfo(l).name);
      const fbTs = fallbackTileset(`ts_${s.slotId}`, zi.name, zi.biome, 'town', genre);
      const fbIn = fallbackTileset(`ts_${s.slotId}_in`, zi.name, bank.styles.interior[0]!, 'interior', genre);
      const fb = () => F.fallbackTownContent(genre, zr, zi.name, npcCount, fbTs, fbIn, { families: familyNamesNear(s), zones: nearbyZones }, sideQuests);
      tasks.push(async () => {
        const out = await step(
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
          },
          fb,
        );
        towns[s.slotId] = out;
        job.progress = 0.42 + 0.33 * (++doneZones / totalZones);
        job.push(`${zi.name}: ${out.npcs.map((n) => n.name).slice(0, 8).join(', ')}${out.npcs.length > 8 ? '…' : ''}`, 'preview');
      });
    } else {
      const fbTs = fallbackTileset(`ts_${s.slotId}`, zi.name, zi.biome, s.kind, genre);
      const loreCount = s.kind === 'dungeon' ? 2 : 1;
      tasks.push(async () => {
        const out = await step(job, 'world.content', `${s.kind === 'dungeon' ? 'Dungeon' : 'Wilds'}: ${zi.name}`, { prompt: P.areaPrompt(input, concept, { name: zi.name, kind: s.kind, description: zi.description, lore: zi.lore, level: s.levelRange, families: families.families.slice(0, 4).map((f) => f.name) }, loreCount), schema: S.AreaContentSchema, name: 'area_content', maxTokens: 5000 }, () => F.fallbackAreaContent(fbTs, zi.name, zr, genre));
        areas[s.slotId] = out;
        job.progress = 0.42 + 0.33 * (++doneZones / totalZones);
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

  setStep('Shaping the land and placing everything', 0.78);
  const draft: Draft = { id: job.worldId, input, seed, genre, skeleton: sk, concept, atlas, story, ruleset, rulesIntent, families, towns, areas, log: [] };
  const world = assembleWorld(draft, job.owner);
  job.push(`Assembled ${world.zones.length} zones (${world.zones.filter((z) => z.kind === 'interior').length} interiors), ${world.npcs.length} NPCs, ${world.quests.length} quests (${world.quests.filter((q) => q.main).length} main), ${world.bosses.length} bosses, ${world.zones.reduce((s, z) => s + z.spawns.length, 0)} monsters.`);

  // ---------------------------------------------------------------- balance
  ruleset = await balanceWorldRules(job, world, rulesIntent, genre, runner, rulesWorld, 0.8, 0.86);
  world.generationLog = job.log.map((l) => l.msg);
  world.status = 'ready';
  saveWorld(world);

  if (input.art !== 'none' && !genai().isProcedural('image.texture')) {
    setStep('Painting textures and characters', 0.82);
    let lastSave = Date.now();
    await generateArt(world, input.art, (msg, frac) => {
      job.progress = 0.82 + 0.17 * frac;
      job.push(msg);
    }, () => {
      if (Date.now() - lastSave > 5000) {
        saveWorld(world);
        lastSave = Date.now();
      }
    }, () => job.cancelled);
    linkAssets(world);
    saveWorld(world);
  }
  await genai().releaseGpu();
  job.progress = 1;
  job.step = 'Ready';
  job.status = 'done';
  job.push('The world is ready.', 'step');
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
export function startRulesJob(world: WorldDefinition, mode: 'regenerate' | 'rebalance', owner: { id: string; name: string }): WorldGenJob {
  const job = new WorldGenJob(world.id, world.input, owner);
  jobs.set(world.id, job);
  job.step = mode === 'regenerate' ? 'Designing new rules' : 'Rebalancing the rules';
  void (async () => {
    const genre = detectGenre(`${world.input.setting} ${world.input.story ?? ''} ${world.input.notes ?? ''}`);
    const maxLevel = LENGTH_PROFILES[world.input.length].maxLevel;
    const runner = makeRunner(job);
    const conceptText = [`WORLD: "${world.concept.title}" — ${world.concept.pitch}`, `Genre: ${world.concept.genre}. Tone: ${world.concept.tone}. The player is ${world.concept.playerRole}.`].join('\n') + '\n\n' + P.userBrief(world.input);
    let intent: RulesetIntent;
    if (mode === 'rebalance' && world.rulesIntent) intent = world.rulesIntent as RulesetIntent;
    else {
      job.push('Designing new rules for this world…', 'step');
      intent = await designRules(runner, conceptText, world.input, genre, (i, n) => (job.progress = 0.05 + 0.3 * (i / n)));
    }
    const r = compileRuleset(intent, { genre, maxLevel, overrides: world.input.rules, id: `rules_${world.id}` });
    bindWorld(world, r, intent.classes);
    world.rulesIntent = intent;
    job.progress = 0.4;
    await balanceWorldRules(job, world, intent, genre, runner, conceptText, 0.4, 0.98);
    saveWorld(world);
    job.status = 'done';
    job.progress = 1;
    job.step = 'Ready';
    job.push('The rules are ready.', 'step');
  })().catch((e) => {
    job.status = 'failed';
    job.error = (e as Error).message;
    console.error('[rules job]', e);
  });
  return job;
}

/** Regenerate missing or failed art for an existing world (e.g. after configuring an image model). */
export function startArtJob(world: WorldDefinition, level: 'essential' | 'full', owner: { id: string; name: string }): WorldGenJob {
  const job = new WorldGenJob(world.id, world.input, owner);
  jobs.set(world.id, job);
  job.step = 'Painting textures and characters';
  void (async () => {
    let lastSave = Date.now();
    await generateArt(world, level, (msg, frac) => {
      job.progress = frac;
      job.push(msg);
    }, () => {
      if (Date.now() - lastSave > 5000) {
        saveWorld(world);
        lastSave = Date.now();
      }
    }, () => job.cancelled);
    linkAssets(world);
    saveWorld(world);
    await genai().releaseGpu();
    job.status = 'done';
    job.progress = 1;
    job.step = 'Ready';
  })().catch((e) => {
    job.status = 'failed';
    job.error = (e as Error).message;
  });
  return job;
}
