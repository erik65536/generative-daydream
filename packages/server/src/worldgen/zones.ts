/**
 * A place, from design to game data: Luna plans it, Krea paints it, the reader finds where people can walk, Luna
 * checks that and decides where everything goes, and the painting is resampled to game scale and turned into ground
 * metres (the navigation grid, every door, exit, person, chest, trap and monster pack).
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  BitSet, NAV_CELL, Nav, PX_PER_METRE_UP, Rng, groundToPicture, pictureToGround,
  type FeatureDef, type NavDef, type Vec2, type WorldDefinition, type ZoneDef, type ZoneKind,
} from '@gd/shared';
import { buildPack } from '../rules/encounters';
import { worldAssetDir, worldDir, writeJsonAtomic } from '../storage';
import { genai } from '../genai/service';
import { upscale } from './comfy';
import type { GpuQueue } from './gpu';
import { paintPlace, planPlace, type PaintPlan, type PlaceBrief } from './outpaint';
import { normColor } from './schemas';
import { analyse, applyCheck, candidates, checkChanges, checkReading, colouring, place, readPainting, type Candidate, type PlaceNeeds, type Reading } from './reading';

/** Parts (columns × rows of painting windows) per kind of place. */
export const PARTS: Record<ZoneKind, [number, number]> = { town: [3, 2], wilderness: [4, 2], dungeon: [3, 2], interior: [1, 1] };
/** Repaint (new seed) a place whose painting cannot work, at most this many times. */
const PAINT_TRIES = 3;
/**
 * Walkable ground (m²) a painting must have to work: built-up towns have less open floor than wilds, and a dungeon
 * or a room is painted much closer (so one painting holds far less ground; rooms read 14–34 m², dungeons 46–80).
 */
export const MIN_AREA: Record<ZoneKind, number> = { town: 350, wilderness: 600, dungeon: 30, interior: 10 };
/** Monster packs keep their distance so fighting one never drags in the next (aggro reaches about 6.5 m). */
const PACK_SPACING = 13;

const THING_KINDS = new Set(['chest', 'sign', 'lore', 'waypoint', 'craft_station', 'bed', 'object']);

/** A place as far as painting and reading it go: what it is, its buildings and its ways out (ids are the world's). */
export interface PlaceSketch extends Pick<PlaceNeeds, 'name' | 'description' | 'buildings' | 'exits'> {
  id: string;
  kind: ZoneKind;
  indoor: boolean;
  lore?: string;
}

/** The world as every place's design sees it. */
export interface WorldLook {
  id: string;
  /** Title and pitch. */
  story: string;
  artStyle: string;
}

export const worldLook = (w: WorldDefinition): WorldLook => ({ id: w.id, story: `${w.concept.title}. ${w.concept.pitch}`, artStyle: w.concept.artStyle });

export function sketchOf(w: WorldDefinition, z: ZoneDef): PlaceSketch {
  const target = (f: FeatureDef) => w.zones.find((x) => x.id === f.targetZoneId);
  const inside = (f: FeatureDef) => f.kind === 'door' && target(f)?.parentZoneId === z.id;
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    indoor: !!z.indoor,
    description: z.description,
    lore: z.lore,
    buildings: z.features.filter(inside).map((f) => ({ id: f.id, name: f.name ?? 'a building', purpose: target(f)?.buildingPurpose ?? 'house' })),
    exits: z.features.filter((f) => f.kind === 'exit' || (f.kind === 'door' && !inside(f))).map((f) => ({ id: f.id, to: target(f)?.name ?? 'elsewhere', into: z.kind === 'interior' || (target(f)?.kind === 'dungeon' && z.kind !== 'dungeon') })),
  };
}

/** What the place must hold: its entrances, ways out, people and things (by world id). */
export function placeNeeds(w: WorldDefinition, z: ZoneDef): PlaceNeeds {
  return {
    ...sketchOf(w, z),
    people: w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role })),
    things: z.features.filter((f) => THING_KINDS.has(f.kind)).map((f) => ({ id: f.id, what: thingText(f) })),
  };
}

function thingText(f: FeatureDef): string {
  switch (f.kind) {
    case 'chest': return `a treasure chest${f.items?.length ? ' holding something important' : ''}`;
    case 'sign': return 'a signpost greeting travellers';
    case 'lore': return `a note or inscription: "${f.name}"`;
    case 'waypoint': return 'the waypoint travellers use (central, easy to find)';
    case 'craft_station': return 'a workbench for crafting';
    case 'bed': return 'a bed to rest in';
    default: return f.name ?? 'something to look at';
  }
}

function placeBrief(w: WorldLook, s: PlaceSketch): PlaceBrief {
  const [cols, rows] = PARTS[s.kind];
  return {
    world: w.story,
    artStyle: w.artStyle,
    name: s.name,
    kind: s.kind === 'wilderness' ? 'wilds' : s.kind,
    indoor: s.indoor,
    description: s.description,
    lore: s.lore,
    buildings: s.buildings.map((b) => ({ name: b.name, purpose: b.purpose })),
    exits: s.exits.map((e) => `${s.kind === 'interior' ? 'the door out' : e.into ? 'a way down or in' : 'a way'} to ${e.to}`),
    cols,
    rows,
  };
}

/** Saved steps of one place's painting, so a resumed build picks up where it stopped. */
class PlaceDraft {
  readonly dir: string;
  constructor(worldId: string, zoneId: string) {
    this.dir = path.join(worldDir(worldId), 'draft', 'places', zoneId);
  }
  json<T>(name: string): T | undefined {
    const f = path.join(this.dir, `${name}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : undefined;
  }
  saveJson(name: string, v: unknown) {
    writeJsonAtomic(path.join(this.dir, `${name}.json`), v);
  }
  png(name: string): Buffer | undefined {
    const f = path.join(this.dir, `${name}.png`);
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }
  savePng(name: string, b: Buffer) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${name}.png`), b);
  }
}

export interface PlaceContext {
  gpu: GpuQueue;
  /** Lower paints first (the starting town before anything else). */
  priority: number;
  seed: number;
  report: (msg: string) => void;
  /** Painting parts done / total, for progress. */
  onPart?: (done: number, total: number) => void;
}

/** A place painted and read, before anything is put in it. */
export interface Painted {
  plan: PaintPlan;
  /** Which of the place's paintings (its seed): what is placed in it is saved per painting. */
  seed: number;
  canvas: Buffer;
  reading: Reading;
}

/** Why a read painting cannot work as the place (in words a model can act on), or null when it can. */
export function shortfall(read: Reading['read'], reading: Reading, outward: number, minArea: number): string | null {
  const why: string[] = [];
  if (!read.usable) why.push(`the picture does not work as this place (${read.problems.join('; ') || 'no reason given'})`);
  if (reading.area < minArea) why.push(`only ${Math.round(reading.area)} m² is green walkable ground, it needs at least ${minArea}`);
  if (reading.edges.length < outward) why.push(`the green ground reaches the picture's edge in ${reading.edges.length} places, it needs ${outward} ways out`);
  return why.length ? why.join('; ') : null;
}

/** How well a read painting works as the place: higher is better, 5 is everything it needs. */
export const readScore = (read: Reading['read'], reading: Reading, outward: number, minArea: number) =>
  (read.usable ? 2 : 0) + Math.min(1, reading.edges.length / Math.max(1, outward)) * 2 + Math.min(1, reading.area / minArea);

/** Design, paint and read a place: all it needs is what the place is, so it can start before the world is assembled. */
export async function paintAndRead(w: WorldLook, s: PlaceSketch, ctx: PlaceContext): Promise<Painted> {
  const draft = new PlaceDraft(w.id, s.id);
  const plan = draft.json<PaintPlan>('plan') ?? (await planPlace(placeBrief(w, s)));
  draft.saveJson('plan', plan);
  const outward = s.exits.filter((e) => !e.into).length;

  // Paint and read; a painting that cannot work as the place (no usable ground, too few ways out) is painted again.
  let best: { seed: number; canvas: Buffer; reading: Reading; score: number } | undefined;
  for (let attempt = 0; attempt < PAINT_TRIES; attempt++) {
    const seed = ctx.seed + attempt * 1000;
    const canvas = draft.png(`canvas_${seed}`) ?? (await ctx.gpu.run('krea', ctx.priority, () => paintPlace(plan, seed, ctx.onPart)));
    draft.savePng(`canvas_${seed}`, canvas);
    let read = draft.json<Reading['read']>(`read_${seed}`) ?? (await readPainting(canvas, s));
    let reading = await ctx.gpu.run('reader', ctx.priority, () => analyse(canvas, read, s.kind));
    const minArea = MIN_AREA[s.kind];
    if (!draft.json(`read_${seed}`)) {
      const check = await checkReading(canvas, await colouring(canvas, reading), read);
      if (!check.correct && checkChanges(check)) {
        ctx.report(`${s.name}: ${check.mistakes.join('; ').slice(0, 300)}`);
        read = applyCheck(read, check);
        reading = await ctx.gpu.run('reader', ctx.priority, () => analyse(canvas, read, s.kind));
      }
      // Still short after Luna's check: a stronger model checks once more, told what falls short, before the
      // place is repainted (a repaint costs minutes of GPU; the check a few cents). Kept only if it reads better.
      const failure = shortfall(read, reading, outward, minArea);
      const strong = failure && read.usable ? genai().strongModel('world.design') : undefined;
      if (strong) {
        const second = await checkReading(canvas, await colouring(canvas, reading), read, { model: strong, failure: failure! }).catch((e) => {
          ctx.report(`${s.name}: ${strong} check failed (${(e as Error).message.slice(0, 120)})`);
          return undefined;
        });
        if (second && !second.correct && checkChanges(second)) {
          const read2 = applyCheck(read, second);
          const reading2 = await ctx.gpu.run('reader', ctx.priority, () => analyse(canvas, read2, s.kind));
          const better = readScore(read2, reading2, outward, minArea) > readScore(read, reading, outward, minArea);
          ctx.report(`${s.name}: ${strong}: ${second.mistakes.join('; ').slice(0, 300)} — ${Math.round(reading2.area)} m², ${reading2.edges.length} ways out${better ? '' : ' (no better, kept the earlier read)'}`);
          if (better) [read, reading] = [read2, reading2];
        }
      }
      draft.saveJson(`read_${seed}`, read);
    }
    const ok = !shortfall(read, reading, outward, minArea);
    const score = readScore(read, reading, outward, minArea);
    if (!best || score > best.score) best = { seed, canvas, reading, score };
    ctx.report(`${s.name}: ${Math.round(reading.area)} m² to walk, ${reading.edges.length} ways out at the edges, ${reading.doors.length} entrances${ok ? '' : ` — not enough, painting it again (${read.problems.join('; ').slice(0, 160)})`}`);
    if (ok) break;
  }
  return { plan, seed: best!.seed, canvas: best!.canvas, reading: best!.reading };
}

/** Design, paint and read a place, and turn it into game data. */
export async function buildPlace(w: WorldDefinition, z: ZoneDef, ctx: PlaceContext): Promise<void> {
  await settlePlace(w, z, await paintAndRead(worldLook(w), sketchOf(w, z), ctx), ctx);
}

/**
 * Put everything in a painted place (Luna decides where), bring the painting to game scale and turn it into game
 * data: mutates the zone, the world's NPCs (and drops interiors whose building has no entrance) and its assets.
 */
export async function settlePlace(w: WorldDefinition, z: ZoneDef, { plan, seed, canvas, reading }: Painted, ctx: PlaceContext): Promise<void> {
  const draft = new PlaceDraft(w.id, z.id);
  const needs = placeNeeds(w, z);
  z.design = { style: plan.style, layout: plan.layout };
  z.look = { ambient: plan.look.ambient, lightColor: normColor(plan.look.lightColor) ?? '#ffe8c0', fogColor: normColor(plan.look.fogColor) ?? '#101418', outdoor: plan.look.outdoor && !z.indoor, weather: z.indoor ? 'none' : plan.look.weather };
  const cands = candidates(reading);
  // Spots are picture positions, so a saved placement belongs to one painting (a resumed build may pick another).
  const placed = draft.json<[string, Candidate][]>(`placement_${seed}`);
  const spots = placed ? new Map(placed) : (await place(canvas, needs, cands)).spots;
  draft.saveJson(`placement_${seed}`, [...spots.entries()]);

  // SeedVR2 adds the detail an enlarged painting needs (painted at 2×, then resampled down to the exact size).
  const k = gameScale(reading);
  const FW = Math.round(reading.width * k), FH = Math.round(reading.height * k);
  const source = k > 1.02 ? await ctx.gpu.run('seedvr2', ctx.priority, () => upscale(canvas, 2, ctx.seed)) : canvas;
  const image = await sharp(source).resize(FW, FH, { kernel: 'lanczos3' }).webp({ quality: 90 }).toBuffer();
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  const key = `place_${z.id}`, file = `${key}_${Date.now().toString(36)}.webp`;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${key}_`)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, file), image);
  w.assets[key] = { key, kind: 'painting', file, prompt: `painting of ${z.name}`, status: 'ok', width: FW, height: FH };

  furnish(w, z, reading, spots, { k, width: FW, height: FH, image: key });
}

/**
 * Game scale: people are drawn PX_PER_METRE_UP pixels per metre of height, so the painting is resized by this. Rooms
 * are painted closest (about 120 px/m), so they shrink to about 0.4.
 */
export const gameScale = (r: Reading) => Math.max(0.25, Math.min(2.5, PX_PER_METRE_UP / r.pxPerMetre));

/** The painting laid on the ground at game scale `k`: where its origin sits and its navigation grid. */
export function groundOf(r: Reading, k: number): { width: number; height: number; ox: number; oy: number; nav: NavDef } {
  const width = Math.round(r.width * k), height = Math.round(r.height * k);
  // The ground origin sits above the picture's top centre, so all of the picture has positive ground coordinates.
  const ox = width / 2, oy = -width / 4;
  const cols = Math.ceil((width / (2 * 32) + height / (2 * 16)) / NAV_CELL), rows = cols;
  const walk = new BitSet(cols * rows), sight = new BitSet(cols * rows);
  const raw = (x: number, y: number) => {
    const p = groundToPicture(x, y, ox, oy);
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return -1;
    return Math.min(r.ah - 1, Math.floor((p.y / k) * (r.ah / r.height))) * r.aw + Math.min(r.aw - 1, Math.floor((p.x / k) * (r.aw / r.width)));
  };
  // A cell is walkable when any part of it is (its centre and eight points 0.2 m out): the walk mask already keeps a
  // character's centre 0.35 m from obstacles, more than the 0.28 m this adds at most, and the pathfinder never cuts
  // corners, so a passage running up the picture (diagonal on the grid) sampled at cell centres alone would break
  // into corner-touching cells.
  const Q = NAV_CELL / 2.5, AROUND = [-Q, 0, Q].flatMap((dx) => [-Q, 0, Q].map((dy) => [dx, dy] as const));
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL, y = (cy + 0.5) * NAV_CELL, i = raw(x, y);
      if (i >= 0 && r.sight[i]) sight.set(cy * cols + cx);
      if (AROUND.some(([dx, dy]) => {
        const j = raw(x + dx, y + dy);
        return j >= 0 && r.walk[j];
      })) walk.set(cy * cols + cx);
    }
  return { width, height, ox, oy, nav: { cols, rows, walk: walk.encode(), sight: sight.encode() } };
}

/**
 * Lay the painting on the ground: the navigation grid, and positions in ground metres for everything placed. What
 * Luna could not place is set down by rule (people and things at open spots, monster packs and traps by depth).
 */
function furnish(w: WorldDefinition, z: ZoneDef, r: Reading, spots: Map<string, Candidate>, pic: { k: number; width: number; height: number; image: string }) {
  const rng = new Rng(`${w.seed}:${z.id}:furnish`);
  const { ox, oy, nav: grid } = groundOf(r, pic.k);
  z.painting = { image: pic.image, width: pic.width, height: pic.height, ox, oy };
  z.nav = grid;
  z.width = grid.cols * NAV_CELL;
  z.height = grid.rows * NAV_CELL;
  const nav = new Nav(z.nav);

  const taken: Vec2[] = [];
  const free = (cx: number, cy: number) => {
    if (!nav.walkableCell(cx, cy)) return false;
    const c = nav.centre(cx, cy);
    return taken.every((t) => Math.hypot(t.x - c.x, t.y - c.y) >= 0.9);
  };
  const at = (c: Candidate) => pictureToGround(c.x * pic.k, c.y * pic.k, ox, oy);
  /** A free walkable point near a spot (people and things never share a point). */
  const settle = (p: Vec2): Vec2 => {
    const q = nav.nearestWalkable(p, 8, free) ?? nav.nearestWalkable(p, 400) ?? p;
    taken.push(q);
    return q;
  };
  const openSpots = [...new Set([...spots.values()].filter((c) => c.id[0] === 'P' || c.id[0] === 'L'))];
  const allOpen = candidates(r).filter((c) => c.id[0] === 'P' || c.id[0] === 'L');
  const fallbackSpot = () => at(rng.pick(allOpen.length ? allOpen : openSpots.length ? openSpots : candidates(r)));

  // Doors and ways out stand exactly where the painting has them (on the walkable ground at the door's foot).
  const unplacedDoors: FeatureDef[] = [];
  for (const f of z.features) {
    if (f.kind !== 'door' && f.kind !== 'exit') continue;
    const c = spots.get(f.id);
    if (!c) {
      unplacedDoors.push(f);
      continue;
    }
    // (A spot the reading left off the walkable ground still gets the nearest point people can reach.)
    const p = nav.nearestWalkable(at(c), 6) ?? nav.nearestWalkable(at(c), 400) ?? at(c);
    f.x = p.x;
    f.y = p.y;
    taken.push(p);
  }
  // A building the painting has no entrance for is left out: its people move outdoors, its interior goes.
  for (const f of unplacedDoors) {
    const inner = w.zones.find((x) => x.id === f.targetZoneId);
    if (inner?.parentZoneId === z.id) {
      for (const n of w.npcs) if (n.zoneId === inner.id) n.zoneId = z.id;
      w.zones = w.zones.filter((x) => x.id !== inner.id);
      z.features = z.features.filter((x) => x !== f);
    } else {
      // A way out must exist (placement insists on every one; this only guards a resumed draft).
      const p = settle(fallbackSpot());
      f.x = p.x;
      f.y = p.y;
    }
  }
  for (const n of w.npcs.filter((x) => x.zoneId === z.id)) {
    const c = spots.get(n.id);
    const p = settle(c ? at(c) : fallbackSpot());
    n.x = p.x;
    n.y = p.y;
  }
  for (const f of z.features.filter((x) => THING_KINDS.has(x.kind))) {
    const c = spots.get(f.id);
    const p = settle(c ? at(c) : fallbackSpot());
    f.x = p.x;
    f.y = p.y;
  }

  // Arrival: the main way in (the first exit, or the waypoint in towns).
  const entryFeature = z.features.find((f) => f.kind === 'waypoint') ?? z.features.find((f) => f.kind === 'exit' || f.kind === 'door');
  z.entry = entryFeature ? { x: entryFeature.x, y: entryFeature.y } : settle(fallbackSpot());

  if (z.kind === 'wilderness' || z.kind === 'dungeon') populate(w, z, nav, rng, r.area, taken);
}

/** Monster packs, the boss and traps, spread by walking distance from the way in (deeper = harder). */
export function populate(w: WorldDefinition, z: ZoneDef, nav: Nav, rng: Rng, area: number, taken: Vec2[]) {
  const r = w.ruleset;
  const costs = nav.reach(z.entry, 1e6);
  if (!costs.size) return;
  const far = Math.max(...costs.values());
  const cells = [...costs.keys()].map((i) => ({ i, p: nav.centre(i % nav.cols, Math.floor(i / nav.cols)), depth: costs.get(i)! / far }));
  rng.shuffle(cells);
  const doors = z.features.filter((f) => f.kind === 'exit' || f.kind === 'door');
  const nearDoor = (p: Vec2, d: number) => doors.some((f) => Math.hypot(f.x - p.x, f.y - p.y) < d) || Math.hypot(p.x - z.entry.x, p.y - z.entry.y) < d;
  const families = z.familyIds.map((id) => w.families.find((f) => f.id === id)!).filter(Boolean);
  const around = (centre: Vec2, radius: number, n: number): Vec2[] => {
    const out: Vec2[] = [];
    for (const i of rng.shuffle(nav.cellsWithin(centre, radius))) {
      if (out.length >= n) break;
      const c = nav.centre(i % nav.cols, Math.floor(i / nav.cols));
      if ([...out, ...taken].every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= 0.9)) out.push(c);
    }
    return out;
  };
  const spawnAt = (groupId: string, members: { role: string; level: number; elite?: boolean; boss?: boolean }[], centre: Vec2, familyId: string, bossId?: string) => {
    const pts = around(centre, members.length > 3 ? 3.2 : 2.6, members.length);
    members.forEach((m, i) => {
      const p = pts[i] ?? centre;
      taken.push(p);
      z.spawns.push({ id: `${groupId}_${i}`, kind: 'monster', familyId, archetype: m.role as never, level: m.level, x: p.x, y: p.y, groupId, ...(m.elite ? { elite: true } : {}), ...(m.boss && bossId ? { bossId } : {}) });
    });
  };

  // The boss waits deepest in.
  const bosses = w.bosses.filter((b) => b.zoneId === z.id);
  const lair = cells.reduce((a, b) => (b.depth > a.depth ? b : a)).p;
  for (const b of bosses) {
    const fam = w.families.find((f) => f.id === b.familyId) ?? families[0];
    if (!fam) continue;
    const adds = buildPack(r, rng.fork(`boss:${b.id}`), { mode: w.input.combatMode, level: b.level, kind: 'boss', roles: fam.members.map((m) => m.archetype) }).filter((m) => !m.boss);
    spawnAt(`${z.id}_boss`, [{ role: b.archetype, level: b.level, boss: true }, ...adds.map((m) => ({ ...m, level: Math.max(1, b.level - 1) }))], lair, fam.id, b.id);
  }

  // Packs: about one per 160 m² of walkable ground, spaced apart, away from the ways in and out.
  if (families.length) {
    const want = Math.max(3, Math.min(12, Math.round(area / (z.kind === 'dungeon' ? 130 : 160))));
    const packs: Vec2[] = [lair];
    let n = 0;
    for (const c of cells) {
      if (n >= want) break;
      if (nearDoor(c.p, 9) || packs.some((p) => Math.hypot(p.x - c.p.x, p.y - c.p.y) < PACK_SPACING)) continue;
      packs.push(c.p);
      const fam = rng.pick(families);
      const level = Math.max(1, Math.round(z.levelRange[0] + (z.levelRange[1] - z.levelRange[0]) * c.depth));
      const kind = rng.chance(0.15 + c.depth * 0.1) ? 'elite' : 'normal';
      spawnAt(`${z.id}_g${n++}`, buildPack(r, rng.fork(`pack:${n}`), { mode: w.input.combatMode, level, kind, roles: fam.members.map((m) => m.archetype), depth: c.depth }), c.p, fam.id);
    }
  }

  // Traps on the way through, away from doors and each other.
  if (r.systems.traps && r.traps.length) {
    const want = Math.round(area / (z.kind === 'dungeon' ? 350 : 600));
    const traps: Vec2[] = [];
    for (const c of cells) {
      if (traps.length >= want) break;
      if (c.depth < 0.2 || c.depth > 0.9 || nearDoor(c.p, 5) || traps.some((t) => Math.hypot(t.x - c.p.x, t.y - c.p.y) < 6) || taken.some((t) => Math.hypot(t.x - c.p.x, t.y - c.p.y) < 2)) continue;
      traps.push(c.p);
      const trap = rng.pick(r.traps);
      z.features.push({ id: `${z.id}_trap${traps.length}`, kind: 'trap', x: c.p.x, y: c.p.y, trapKind: trap.id, trapLevel: z.levelRange[1], name: trap.name });
    }
  }
}
