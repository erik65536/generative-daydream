/** World generation job: runs every step (LLM or procedural), assembles, generates art, saves. */
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  AFFIXES, ITEM_BASES, ORIGINS, PLAYER_SKILL_IDS, RECIPES, Rng, SIZE_PROFILES,
  type WorldDefinition, type WorldInput,
} from '@gd/shared';
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
    terminology: {} as WorldDefinition['terminology'], systems: {} as WorldDefinition['systems'], maxLevel: 1, origins: [], skills: {}, itemNames: {}, affixNames: {}, recipeNames: {}, trapNames: {}, uniqueItems: {}, families: [], bosses: [], tilesets: {}, zones: [], npcs: [], quests: [], arcs: [], finalQuestId: '', ending: '', lore: [], assets: {}, startZoneId: '', worldFacts: [], factions: [],
  };
}

/** Run one structured step, falling back to procedural content on any failure. */
async function step<T extends z.ZodType>(job: WorldGenJob, purpose: Purpose, label: string, opts: { prompt: string; schema: T; name: string; maxTokens?: number }, fallback: () => z.infer<T>): Promise<z.infer<T>> {
  const g = genai();
  if (g.isProcedural(purpose)) return fallback();
  const t0 = Date.now();
  try {
    const out = await g.structured(purpose, { system: P.SYSTEM, prompt: opts.prompt, schema: opts.schema, name: opts.name, maxTokens: opts.maxTokens });
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

  setStep('Charting regions and places', 0.1);
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

  setStep('Breeding monsters and naming skills, gear and enchantments', 0.18);
  const famCount = SIZE_PROFILES[input.size].monsterFamilies;
  const [families, skills, items, affixes] = await Promise.all([
    step(job, 'world.design', 'Monster families', { prompt: P.familiesPrompt(input, concept, famCount), schema: S.FamiliesSchema, name: 'monster_families', maxTokens: 5000 }, () => F.fallbackFamilies(genre, famCount, rng.fork('fam'))),
    step(job, 'world.content', 'Skills & origins', { prompt: P.skillsPrompt(concept), schema: S.skillsSchema(PLAYER_SKILL_IDS, ORIGINS.map((o) => o.id)), name: 'skills', maxTokens: 5000 }, () => F.fallbackSkills(genre, { traps: concept.systems?.traps !== false, lockpicking: concept.systems?.lockpicking !== false })),
    step(job, 'world.content', 'Item names', { prompt: P.itemsPrompt(concept), schema: S.itemsSchema(ITEM_BASES.map((b) => b.id)), name: 'items', maxTokens: 5000 }, () => F.fallbackItems(genre)),
    step(job, 'world.content', 'Enchantments, traps & recipes', { prompt: P.affixPrompt(concept), schema: S.affixSchema(AFFIXES.map((a) => a.id), RECIPES.map((r) => r.id)), name: 'affixes', maxTokens: 3000 }, () => F.fallbackAffixes()),
  ]);
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
  const draft: Draft = { id: job.worldId, input, seed, genre, skeleton: sk, concept, atlas, story, skills, items, affixes, families, towns, areas, log: [] };
  const world = assembleWorld(draft, job.owner);
  world.generationLog = job.log.map((l) => l.msg);
  job.push(`Assembled ${world.zones.length} zones (${world.zones.filter((z) => z.kind === 'interior').length} interiors), ${world.npcs.length} NPCs, ${world.quests.length} quests (${world.quests.filter((q) => q.main).length} main), ${world.bosses.length} bosses, ${world.zones.reduce((s, z) => s + z.spawns.length, 0)} monsters.`);
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
  job.progress = 1;
  job.step = 'Ready';
  job.status = 'done';
  job.push('The world is ready.', 'step');
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
    job.status = 'done';
    job.progress = 1;
    job.step = 'Ready';
  })().catch((e) => {
    job.status = 'failed';
    job.error = (e as Error).message;
  });
  return job;
}
