/**
 * Building a world. Luna writes and decides (many calls side by side); the local GPU paints and reads places and
 * draws characters (one task at a time). Each piece starts as soon as what it needs exists, so the GPU starts on
 * the wild places while the story is still being written:
 *
 *   concept ─┬─ rules ── creatures ──┬─ story ── towns' people ──┬─ assemble ─┬─ balance ── heroes, item icons
 *            └─ atlas ───────────────┴─ wilds' and dungeons' lore ┘            ├─ towns painted, settled ── interiors
 *                 └─ wilds and dungeons painted and read ─────────────────────┴─ settled (Luna places everything)
 *                                                                              └─ people, creatures, objects drawn
 *
 * Every finished piece is checkpointed, so a build that stops resumes where it was.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LENGTH_PROFILES, Rng, SIZE_PROFILES, type Ruleset, type WorldDefinition, type WorldInput, type ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import type { Purpose } from '../genai/types';
import { BudgetExceeded } from '../genai/spend';
import { loadWorld, saveWorld, worldDir, writeJsonAtomic } from '../storage';
import { enqueue, latestJob } from '../jobs/queue';
import { Job as WorldGenJob, JobYield, workerState, type JobPhase } from '../jobs/job';
import { compileRuleset } from '../rules/compile';
import { designRules, reviewRules, type StepRunner } from '../rules/generate';
import { balanceOffThread } from '../rules/balanceThread';
import { bindWorld } from '../rules/bind';
import { detectGenre, type Genre } from '../rules/genre';
import type { RulesetIntent } from '../rules/intent';
import { buildSkeleton, type WorldSkeleton, type ZoneSlot } from './structure';
import * as S from './schemas';
import * as P from './prompts';
import { assembleWorld, missingRoles, townRoles, type Draft } from './assemble';
import { generateArt, linkAssets } from './art';
import { GpuQueue } from './gpu';
import { PARTS, paintAndRead, settlePlace, sketchOf, type Painted, type PlaceContext, type PlaceSketch } from './zones';
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

export function placeholderWorld(id: string, input: WorldInput, owner: { id: string; name: string }): WorldDefinition {
  return {
    id, formatVersion: 2, ownerId: owner.id, ownerName: owner.name, public: true, createdAt: Date.now(), updatedAt: Date.now(), status: 'generating', seed: '', input,
    concept: { title: 'A world is being dreamed…', pitch: input.setting.slice(0, 200), genre: '', tone: '', artStyle: '', intro: '', secret: '', playerRole: '', palette: { primary: '#c8a24a', secondary: '#3a4a6a', accent: '#e0603a', ui: '#1a1a22' } },
    ruleset: undefined as unknown as Ruleset, maxLevel: 1, origins: [], uniqueItems: {}, families: [], bosses: [], zones: [], npcs: [], quests: [], arcs: [], finalQuestId: '', ending: '', lore: [], assets: {}, startZoneId: '', worldFacts: [], factions: [],
  };
}

// ------------------------------------------------------------------------------------ steps

/** Saved output of each finished step of a build, so a resumed build skips it. */
class Checkpoints {
  private dir: string;
  constructor(worldId: string) {
    this.dir = path.join(worldDir(worldId), 'draft');
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
}

/** Tests shorten the waits between tries (GD_RETRY_WAIT_SCALE=0). */
export const RETRY_WAIT_SCALE = Number(process.env.GD_RETRY_WAIT_SCALE ?? 1);

/** Tries per step before the build stops (it can be resumed later from its checkpoints), and the waits between. */
const STEP_TRIES = 4;
const STEP_BACKOFF_MS = [5_000, 30_000, 120_000].map((ms) => ms * RETRY_WAIT_SCALE);

/** A build step that failed after every try. The build stops here and can be resumed. */
export class StepFailed extends Error {}

/**
 * Do a piece of work that must succeed: tried again after a wait when it fails (`fn` hears what was wrong last
 * time), and after the last try the build stops. Running out of AI budget stops it at once.
 */
async function attempt<T>(job: WorldGenJob, label: string, fn: (problem: string) => Promise<T>): Promise<T> {
  let problem = '';
  for (let n = 1; ; n++) {
    const t0 = Date.now();
    try {
      const out = await fn(problem);
      job.push(`${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      if (job.cancelled) throw new Error('cancelled');
      if (e instanceof JobYield || e instanceof StepFailed) throw e;
      if (e instanceof BudgetExceeded) throw new StepFailed(`${label}: ${msg} Resume the build then.`);
      if (n >= STEP_TRIES) throw new StepFailed(`${label} failed ${STEP_TRIES} times (last: ${msg.slice(0, 200)}). Resume the build once the service is working.`);
      problem = msg.slice(0, 600);
      const wait = STEP_BACKOFF_MS[n - 1] ?? 120_000;
      job.push(`${label}: try ${n} failed (${msg.slice(0, 200)}); trying again in ${Math.round(wait / 1000)}s`, 'warn');
      await new Promise((r) => setTimeout(r, wait));
      job.yieldPoint();
    }
  }
}

type StepOpts<T extends z.ZodType> = { prompt: string; schema: T; name: string; maxTokens?: number; system?: string; check?: (out: z.infer<T>) => string | null };

/** One structured Luna step; an answer `check` rejects is asked for again, saying what was wrong. */
function step<T extends z.ZodType>(job: WorldGenJob, purpose: Purpose, label: string, opts: StepOpts<T>): Promise<z.infer<T>> {
  return attempt(job, label, async (problem) => {
    const prompt = problem ? `${opts.prompt}\n\nAN EARLIER ANSWER TO THIS WAS REJECTED: ${problem}\nAnswer again in full, fixing that.` : opts.prompt;
    const out = await genai().structured(purpose, { system: opts.system ?? P.SYSTEM, prompt, schema: opts.schema, name: opts.name, maxTokens: opts.maxTokens });
    const bad = opts.check?.(out);
    if (bad) throw new Error(bad);
    return out;
  });
}

const runner = (job: WorldGenJob): StepRunner => (purpose, label, opts) => step(job, purpose, label, opts);

/**
 * How far the build is: every piece of work has a weight (about the seconds it takes on the busiest resource, the
 * GPU) and adds it as it finishes, paintings part by part. Never moves backwards when new work is found.
 */
class Progress {
  private units = new Map<string, { weight: number; done: number }>();
  constructor(private job: WorldGenJob) {}
  add(key: string, weight: number) {
    if (!this.units.has(key)) this.units.set(key, { weight, done: 0 });
  }
  set(key: string, frac: number) {
    const u = this.units.get(key);
    if (!u) return;
    u.done = Math.max(u.done, Math.min(1, frac));
    let total = 0, done = 0;
    for (const x of this.units.values()) {
      total += x.weight;
      done += x.weight * x.done;
    }
    this.job.progress = Math.max(this.job.progress, Math.min(0.99, done / Math.max(1, total)));
  }
  /** Work that will not happen after all (an interior whose building has no entrance). */
  drop(key: string) {
    const u = this.units.get(key);
    if (u) u.weight = 0;
  }
}

/** About how long each kind of work takes, in seconds. */
const COST = { concept: 20, rules: 60, atlas: 30, families: 20, story: 60, content: 15, balance: 60, image: 12, part: 25, read: 45, settle: 40 };
const placeCost = (kind: ZoneDef['kind']) => PARTS[kind][0] * PARTS[kind][1] * COST.part + COST.read + COST.settle;

/** How places are painted and furnished (tests swap in plain ground, to build worlds without an image model). */
export const places = { paint: paintAndRead, settle: settlePlace };

const zid = (slot: string) => `z_${slot}`;
const hash = (s: string) => crypto.createHash('sha1').update(s).digest().readUInt32LE(0) % 1_000_000;

/** A wild place or dungeon as the atlas describes it: enough to paint it before the world is assembled. */
function slotSketch(sk: WorldSkeleton, atlas: S.AtlasOut, s: ZoneSlot): PlaceSketch {
  const info = (slot: string) => atlas.zones.find((z) => z.slotId === slot)!;
  const kindOf = (slot: string) => sk.slots.find((x) => x.slotId === slot)?.kind;
  return {
    id: zid(s.slotId),
    name: info(s.slotId).name,
    kind: s.kind,
    indoor: info(s.slotId).indoor,
    description: info(s.slotId).description,
    lore: info(s.slotId).lore,
    buildings: [],
    exits: s.links.map((l) => ({ id: `${zid(s.slotId)}_exit_${l}`, to: info(l).name, into: kindOf(l) === 'dungeon' && s.kind !== 'dungeon' })),
  };
}

function phases(sk: WorldSkeleton): Omit<JobPhase, 'status'>[] {
  return [
    { id: 'concept', label: 'World concept', detail: 'Title, tone, art style and who you are' },
    { id: 'rules', label: 'Rules', detail: 'Resources, classes, skill trees and gear' },
    { id: 'atlas', label: 'Map', detail: 'Regions, towns, wilds and dungeons' },
    { id: 'families', label: 'Creatures', detail: 'Monster families and their roles' },
    { id: 'story', label: 'Main story', detail: `${sk.arcs} story arcs, key characters and bosses` },
    { id: 'content', label: 'People and lore', detail: 'Who lives in every town, their side quests, what the wilds remember', total: sk.slots.length, done: 0 },
    { id: 'places', label: 'Painting places', detail: 'Every place designed, painted, read for where people can walk, and furnished', total: sk.slots.length, done: 0 },
    { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number' },
    { id: 'art', label: 'Characters and items', detail: 'Heroes, people, creatures, bosses and item icons' },
  ];
}

// ------------------------------------------------------------------------------------ the build

export async function runGeneration(job: WorldGenJob, fixedSeed?: string) {
  const input = job.input;
  const seed = fixedSeed || input.seed?.trim() || crypto.randomBytes(6).toString('hex');
  const cp = new Checkpoints(job.worldId);
  const resumed = (what: string) => () => job.push(`${what}: kept from before the restart`);
  const rng = new Rng(seed);
  const genre = detectGenre(`${input.setting} ${input.story ?? ''} ${input.notes ?? ''}`);
  const sk = buildSkeleton(input, rng.fork('skeleton'));
  const companions = input.combatMode === 'party_npc';
  const progress = new Progress(job);
  let failed = false;
  const gpu = new GpuQueue(() => failed || job.cancelled || workerState.yieldRequested);
  /** Every piece of work runs under this: a failure stops the GPU queue and the build. */
  const track = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => (failed = true));
    return p;
  };
  const stage = async <T>(id: string, step: string, fn: () => Promise<T>): Promise<T> => {
    job.begin(id);
    job.yieldPoint();
    job.push(step, 'step');
    const out = await fn();
    job.end(id);
    return out;
  };

  job.push(`Seed ${seed}. ${sk.slots.length} places in ${sk.regions.length} regions, max level ${sk.maxLevel}.`);
  job.plan(phases(sk));
  for (const [k, w] of Object.entries({ concept: COST.concept, rules: COST.rules, atlas: COST.atlas, families: COST.families, story: COST.story, balance: COST.balance })) progress.add(k, w);
  for (const s of sk.slots) {
    progress.add(`content:${s.slotId}`, COST.content);
    progress.add(`place:${zid(s.slotId)}`, placeCost(s.kind));
  }

  try {
    // ---------------------------------------------------------------- the world in words
    const concept = await stage('concept', 'Imagining the world', () =>
      cp.get('concept', () => step(job, 'world.design', 'Concept', { prompt: P.conceptPrompt(input), schema: S.ConceptSchema, name: 'world_concept', maxTokens: 4000 }), resumed('Concept')),
    );
    progress.set('concept', 1);
    job.preview.title = concept.title;
    job.preview.pitch = concept.pitch;
    job.push(`"${concept.title}" — ${concept.pitch}`, 'preview');
    const look = { id: job.worldId, story: `${concept.title}. ${concept.pitch}`, artStyle: concept.artStyle };

    const rules = track(stage('rules', 'Designing the rules', async () => {
      const world = `${P.conceptSummary(concept)}\n\n${P.userBrief(input)}`;
      const intent = await cp.get('rules', () => designRules(runner(job), world, input, (done, total) => {
        job.count('rules', done, total);
        progress.set('rules', done / total);
      }), resumed('Rules'));
      const ruleset = compileRuleset(intent, { genre, maxLevel: sk.maxLevel, overrides: input.rules, id: `rules_${job.worldId}` });
      progress.set('rules', 1);
      job.push(`Rules "${ruleset.name}": ${ruleset.classes.map((c) => c.name).join(', ')} · ${ruleset.health.name}${ruleset.pools.length ? `, ${ruleset.pools.map((x) => x.name).join(', ')}` : ''}`, 'preview');
      return { intent, ruleset, world };
    }));

    const atlas = track(stage('atlas', 'Charting regions and places', async () => {
      const slotIds = sk.slots.map((s) => s.slotId);
      const check = (a: { regions: { index: number }[]; zones: { slotId: string }[] }) => {
        const missing = sk.slots.filter((s) => !a.zones.some((z) => z.slotId === s.slotId)).map((s) => s.slotId);
        const regions = sk.regions.filter((r) => !a.regions.some((x) => x.index === r.index)).map((r) => r.index);
        return missing.length || regions.length ? `missing ${[missing.length ? `places for slots ${missing.join(', ')}` : '', regions.length ? `regions ${regions.join(', ')}` : ''].filter(Boolean).join(' and ')}; every slot and region needs an entry` : null;
      };
      const raw = await cp.get('atlas', () => step(job, 'world.design', 'Atlas', { prompt: P.atlasPrompt(input, concept, sk), schema: S.atlasSchema(slotIds, sk.regions.length), name: 'world_atlas', maxTokens: 5000, check }), resumed('Places'));
      // Every place gets a name of its own.
      const seen = new Set<string>();
      const out: S.AtlasOut = {
        regions: sk.regions.map((r) => raw.regions.find((x) => x.index === r.index)!),
        zones: sk.slots.map((s) => {
          const z = raw.zones.find((x) => x.slotId === s.slotId)!;
          let name = z.name;
          while (seen.has(name.toLowerCase())) name = `${name} ${['East', 'Deep', 'Upper', 'Lower', 'Far'][seen.size % 5]}`;
          seen.add(name.toLowerCase());
          return { ...z, name };
        }),
      };
      progress.set('atlas', 1);
      job.preview.zones = out.zones.map((z) => z.name);
      job.push(`Places: ${out.zones.map((z) => z.name).join(', ')}`, 'preview');
      return out;
    }));

    // Wild places and dungeons are painted as soon as they have a name: the GPU starts while the story is written.
    const placeCtx = (z: { id: string; kind: ZoneDef['kind']; name: string; regionIndex: number }, priority: number): PlaceContext => ({
      gpu,
      priority,
      seed: hash(`${seed}:${z.id}`),
      report: (m) => job.push(m),
      onPart: (done, total) => progress.set(`place:${z.id}`, (done / total) * ((placeCost(z.kind) - COST.read - COST.settle) / placeCost(z.kind))),
    });
    // Painting and settling a place are retried like any step (a model may fail now and then); their saved steps are kept.
    const paint = (sketch: PlaceSketch, ctx: PlaceContext) => attempt(job, `Painting ${sketch.name}`, () => places.paint(look, sketch, ctx));
    let placesDone = 0;
    /** GPU order: the starting place first, then region by region, each place finished before the next. */
    const placePriority = (id: string) => (id === zid(sk.startSlot) ? 0 : 1 + (sk.slots.find((s) => zid(s.slotId) === id)?.regionIndex ?? 0) + sk.slots.findIndex((s) => zid(s.slotId) === id) / 100);
    const placeDone = (id: string, name: string) => {
      progress.set(`place:${id}`, 1);
      job.count('places', ++placesDone);
      job.push(`${name} is ready`, 'preview');
    };
    const painted = track(atlas.then((a) => {
      job.begin('places');
      return new Map(sk.slots.filter((s) => s.kind !== 'town').map((s) => {
        const sketch = slotSketch(sk, a, s);
        return [sketch.id, track(paint(sketch, placeCtx({ ...sketch, regionIndex: s.regionIndex }, placePriority(sketch.id))))] as const;
      }));
    }));

    const families = track(rules.then(({ ruleset }) => stage('families', 'Breeding monsters', async () => {
      const count = SIZE_PROFILES[input.size].monsterFamilies;
      const damageKinds = [...ruleset.subtypes.map((x) => x.name), ...ruleset.damageTypes.map((x) => x.name)];
      const out = await cp.get('families', () => step(job, 'world.design', 'Monster families', { prompt: P.familiesPrompt(input, concept, count, damageKinds), schema: S.FamiliesSchema, name: 'monster_families', maxTokens: 5000, check: (f) => (f.families.length < Math.min(2, count) ? `only ${f.families.length} families; ${count} are needed` : null) }), resumed('Creatures'));
      progress.set('families', 1);
      job.push(`Creatures: ${out.families.map((f) => f.name).join(', ')}`, 'preview');
      return out;
    })));

    const story = track(Promise.all([atlas, families]).then(([a, f]) => stage('story', 'Writing the main story', async () => {
      const slots = (kind: string) => sk.slots.filter((s) => s.kind === kind).map((s) => s.slotId);
      const out = await cp.get('story', () => step(job, 'world.design', 'Main story', { prompt: P.storyPrompt(input, concept, a, sk, f.families.map((x) => x.name)), schema: S.storySchema(slots('town'), slots('dungeon'), sk.slots.map((s) => s.slotId)), name: 'main_story', maxTokens: 8000, check: (st) => (st.arcs.length < sk.arcs ? `the story has ${st.arcs.length} arcs; it needs ${sk.arcs}` : null) }), resumed('Main story'));
      progress.set('story', 1);
      job.preview.arcs = out.arcs.map((x) => x.title);
      job.preview.npcs = out.keyNpcs.map((n) => `${n.name}, ${n.title}`);
      job.push(`Arcs: ${out.arcs.map((x) => x.title).join(' → ')}`, 'preview');
      return out;
    })));

    // ---------------------------------------------------------------- what every place holds
    let contentDone = 0;
    const contentFinished = (slot: string) => {
      progress.set(`content:${slot}`, 1);
      job.count('content', ++contentDone);
      if (contentDone === sk.slots.length) job.end('content');
    };
    const size = SIZE_PROFILES[input.size];
    const towns = Promise.all(sk.slots.filter((s) => s.kind === 'town').map((s) => track(Promise.all([atlas, families, story]).then(async ([a, f, st]) => {
      job.begin('content');
      const zi = a.zones.find((z) => z.slotId === s.slotId)!;
      const zr = rng.fork(`content:${s.slotId}`);
      const keyHere = st.keyNpcs.filter((k) => k.townSlot === s.slotId);
      // Room for every service the town needs (and a companion) plus a few ordinary people.
      const npcCount = Math.max(companions ? 8 : 7, zr.int(size.npcsPerTown[0], size.npcsPerTown[1]) - keyHere.length);
      const sideQuests = zr.int(size.sideQuestsPerTown[0], size.sideQuestsPerTown[1]);
      const out = await cp.get(`zone_${s.slotId}`, () => step(job, 'world.content', `Town: ${zi.name}`, {
        prompt: P.townPrompt(input, concept, { name: zi.name, description: zi.description, lore: zi.lore, level: s.levelRange[0], region: a.regions[s.regionIndex]?.name ?? String(s.regionIndex) }, {
          npcCount, sideQuests, keyNpcs: keyHere.map((k) => `${k.name} (${k.title})`), nearbyZones: s.links.map((l) => a.zones.find((z) => z.slotId === l)!.name), families: f.families.slice(0, 3).map((x) => x.name), companions,
          requiredRoles: townRoles(false).map((r) => r.label),
        }),
        schema: S.TownContentSchema,
        name: 'town_content',
        maxTokens: 9000,
        check: (t) => {
          const missing = missingRoles([...t.npcs, ...keyHere], companions);
          return missing.length ? `the town has no ${missing.join(', ')}; every town needs these among its people, one person per role` : null;
        },
      }));
      contentFinished(s.slotId);
      job.push(`${zi.name}: ${out.npcs.map((n) => n.name).slice(0, 8).join(', ')}${out.npcs.length > 8 ? '…' : ''}`, 'preview');
      return [s.slotId, out] as const;
    }))));
    const areas = Promise.all(sk.slots.filter((s) => s.kind !== 'town').map((s) => track(Promise.all([atlas, families]).then(async ([a, f]) => {
      job.begin('content');
      const zi = a.zones.find((z) => z.slotId === s.slotId)!;
      const out = await cp.get(`zone_${s.slotId}`, () => step(job, 'world.content', `${s.kind === 'dungeon' ? 'Dungeon' : 'Wilds'}: ${zi.name}`, { prompt: P.areaPrompt(input, concept, { name: zi.name, kind: s.kind, description: zi.description, lore: zi.lore, level: s.levelRange, families: f.families.slice(0, 4).map((x) => x.name) }, s.kind === 'dungeon' ? 2 : 1), schema: S.AreaContentSchema, name: 'area_content', maxTokens: 5000 }));
      contentFinished(s.slotId);
      return [s.slotId, out] as const;
    }))));

    // ---------------------------------------------------------------- assembly
    const [r, a, f, st, townList, areaList] = await Promise.all([rules, atlas, families, story, towns, areas]);
    job.yieldPoint();
    const draft: Draft = { id: job.worldId, input, seed, genre, skeleton: sk, concept, atlas: a, story: st, ruleset: r.ruleset, rulesIntent: r.intent, families: f, towns: Object.fromEntries(townList), areas: Object.fromEntries(areaList), log: [] };
    const world = assembleWorld(draft, job.owner);
    // Art painted before a restart is kept (its files are still there).
    world.assets = loadWorld(job.worldId)?.assets ?? {};
    world.status = 'generating';
    linkAssets(world);
    let lastSave = 0;
    const save = (force = false) => {
      if (!force && Date.now() - lastSave < 5000) return;
      lastSave = Date.now();
      world.updatedAt = Date.now();
      saveWorld(world);
    };
    save(true);
    const interiors = world.zones.filter((z) => z.kind === 'interior');
    for (const z of interiors) progress.add(`place:${z.id}`, placeCost('interior'));
    job.count('places', placesDone, world.zones.length);
    job.push(`Assembled ${world.zones.length} places (${interiors.length} interiors), ${world.npcs.length} people, ${world.quests.length} quests (${world.quests.filter((q) => q.main).length} main), ${world.bosses.length} bosses.`);

    const balance = track(stage('balance', 'Balancing the rules by simulation', () => cp.get('balance', () => balanceWorldRules(job, world, r.intent, genre, r.world, (frac) => progress.set('balance', frac)), resumed('Balance'))).then((b) => {
      bindWorld(world, b.ruleset, b.intent.classes);
      world.rulesIntent = b.intent;
      progress.set('balance', 1);
    }));

    // Places: wild places and dungeons as their paintings come in, towns and then their interiors.
    const settle = (z: ZoneDef, p: Painted, priority: number) => attempt(job, `Settling ${z.name}`, () => places.settle(world, z, p, placeCtx(z, priority))).then(() => {
      placeDone(z.id, z.name);
      save();
    });
    const paintings = await painted;
    const settled = world.zones.filter((z) => z.kind !== 'interior').map((z) => track((async () => {
      const priority = placePriority(z.id);
      if (z.kind !== 'town') return settle(z, await paintings.get(z.id)!, priority);
      await settle(z, await paint(sketchOf(world, z), placeCtx(z, priority)), priority);
      // Interiors whose building has no entrance in the painting are gone now.
      for (const i of interiors) if (i.parentZoneId === z.id && !world.zones.includes(i)) progress.drop(`place:${i.id}`);
      job.count('places', placesDone, world.zones.length);
      await Promise.all(world.zones.filter((i) => i.parentZoneId === z.id).map((i, n) => {
        const p = priority + 0.005 + n / 10000;
        return track(paint(sketchOf(world, i), placeCtx(i, p)).then((painted) => settle(i, painted, p)));
      }));
    })()));

    // Characters and the objects drawn over paintings, while places are painted; heroes and icons once rules are final.
    const art = (pick: Parameters<typeof generateArt>[2]['pick'], priority: number) =>
      track(generateArt(world, 'full', {
        pick,
        report: (m) => job.push(m),
        onAsset: () => save(),
        onCount: (done, total) => {
          progress.add(`art:${priority}`, total * COST.image);
          progress.set(`art:${priority}`, done / total);
        },
        shouldStop: () => failed || job.cancelled || workerState.yieldRequested,
        gpu: (work) => gpu.run('qwen', priority, work),
      }));
    job.begin('art');
    const people = art((x) => !x.key.startsWith('spr_origin_') && x.kind !== 'icon', 10);
    const heroes = balance.then(() => art((x) => x.key.startsWith('spr_origin_') || x.kind === 'icon', 20));

    await Promise.all([...settled, balance, people, heroes]);
    job.end('places');
    job.end('art');

    // Experience is solved from every monster now placed.
    bindWorld(world, world.ruleset, (world.rulesIntent as RulesetIntent | undefined)?.classes);
    linkAssets(world);
    world.generationLog = job.log.map((l) => l.msg);
    world.status = 'ready';
    save(true);
    job.finishPhases();
    job.push('The world is ready.', 'step');
  } catch (e) {
    failed = true;
    if (workerState.yieldRequested && job.id) throw new JobYield();
    throw e;
  }
}

/** Simulated fights take a few ms each; the budget scales with the world's length. */
function balanceBudget(input: WorldInput): number {
  if (process.env.GD_BALANCE === 'quick') return 20_000;
  return { short: 6, medium: 9, long: 12, epic: 15 }[input.length] * 60_000;
}

/**
 * Balance a ruleset by simulation (on its own thread), let Luna review flavour and structure, and rebalance if she
 * changed anything. Returns the final ruleset and the intent it was compiled from.
 */
async function balanceWorldRules(job: WorldGenJob, world: WorldDefinition, intent: RulesetIntent, genre: Genre, worldText: string, onProgress: (frac: number) => void): Promise<{ ruleset: Ruleset; intent: RulesetIntent }> {
  const families = world.families.map((f) => ({ roles: f.members.map((m) => m.archetype), subtypeId: f.element }));
  const budget = balanceBudget(world.input);
  const run = async (r: Ruleset, share: number, from: number, to: number) => {
    const out = await balanceOffThread(r, {
      mode: world.input.combatMode, seed: world.seed, families, quick: process.env.GD_BALANCE === 'quick', budgetMs: budget * share,
      onProgress: (m, frac) => {
        onProgress(from + (to - from) * frac);
        if (frac === 1 || /Fitting|Tuning|Evening|Searching|Calibrating/.test(m)) job.push(m);
      },
    });
    job.push(`Balance: ${out.report.notes.join(' ')}${out.report.outliers.length ? ` Outliers fixed: ${out.report.outliers.length}.` : ''}`);
    return out.ruleset;
  };
  job.push(`Balancing the rules by simulation (up to ${Math.round(budget / 60000)} min)…`);
  let ruleset = await run(world.ruleset, 0.7, 0, 0.7);
  const revised = await reviewRules(runner(job), worldText, intent, ruleset);
  if (!revised) return { ruleset, intent };
  job.push('The designer revised some rules after seeing the simulation; rebalancing.');
  ruleset = compileRuleset(revised, { genre, maxLevel: ruleset.progression.maxLevel, overrides: world.input.rules, id: ruleset.id });
  ruleset = await run(ruleset, 0.45, 0.7, 1);
  return { ruleset, intent: revised };
}

/**
 * Regenerate (new AI-designed rules) or rebalance (same intent, current engine) an existing world's rules.
 * Lore, places and art stay; saves made under different classes become incompatible.
 */
export async function runRulesJob(job: WorldGenJob, world: WorldDefinition, mode: 'regenerate' | 'rebalance') {
  job.step = mode === 'regenerate' ? 'Designing new rules' : 'Rebalancing the rules';
  job.plan([
    ...(mode === 'regenerate' ? [{ id: 'rules', label: 'Rules', detail: 'Resources, classes, skill trees and gear' }] : []),
    { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number, then a designer review' },
  ]);
  const genre = detectGenre(`${world.input.setting} ${world.input.story ?? ''} ${world.input.notes ?? ''}`);
  const maxLevel = LENGTH_PROFILES[world.input.length].maxLevel;
  const conceptText = [`WORLD: "${world.concept.title}" — ${world.concept.pitch}`, `Genre: ${world.concept.genre}. Tone: ${world.concept.tone}. The player is ${world.concept.playerRole}.`].join('\n') + '\n\n' + P.userBrief(world.input);
  let intent: RulesetIntent;
  if (mode === 'rebalance' && world.rulesIntent) intent = world.rulesIntent as RulesetIntent;
  else {
    job.push('Designing new rules for this world…', 'step');
    job.phase('rules');
    intent = await designRules(runner(job), conceptText, world.input, (done, total) => {
      job.progress = 0.4 * (done / total);
      job.count('rules', done, total);
    });
  }
  bindWorld(world, compileRuleset(intent, { genre, maxLevel, overrides: world.input.rules, id: `rules_${world.id}` }), intent.classes);
  job.phase('balance');
  const out = await balanceWorldRules(job, world, intent, genre, conceptText, (frac) => (job.progress = 0.4 + 0.58 * frac));
  bindWorld(world, out.ruleset, out.intent.classes);
  world.rulesIntent = out.intent;
  saveWorld(world);
  job.finishPhases();
  job.push('The rules are ready.', 'step');
}

/** Paint a world's missing, failed or changed art (or only the assets named), saving as images arrive. */
export async function paintArt(job: WorldGenJob, world: WorldDefinition, only?: Set<string>) {
  job.step = 'Painting the world';
  let lastSave = Date.now();
  try {
    await generateArt(world, 'full', {
      only,
      report: (m) => job.push(m),
      onAsset: () => {
        if (Date.now() - lastSave > 5000) {
          saveWorld(world);
          lastSave = Date.now();
        }
      },
      onCount: (done, total) => {
        job.progress = done / total;
        job.count('art', done, total);
      },
      shouldStop: () => job.cancelled || workerState.yieldRequested,
    });
    job.yieldPoint();
  } finally {
    linkAssets(world);
    saveWorld(world);
  }
}

/** The art job's one stage. */
export const ART_PHASE: Omit<JobPhase, 'status'> = { id: 'art', label: 'Characters and items', detail: 'Heroes, people, creatures, bosses and item icons' };

export async function runArtJob(job: WorldGenJob, world: WorldDefinition) {
  job.plan([ART_PHASE]);
  job.phase('art');
  await paintArt(job, world);
  job.finishPhases();
}
