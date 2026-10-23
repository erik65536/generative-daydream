/**
 * A place, from design to game data: Luna plans it, Krea paints it as a top-down map from a frame guide, two readers
 * and Luna find where people can walk, the map is checked and repaired (ways out, joined ground), Luna decides where
 * everything goes, and the map is resampled to game scale and turned into ground metres (the navigation grid, every
 * door, exit, person, chest, trap and monster pack). See docs/places.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  BitSet, NAV_CELL, Nav, PX_PER_METRE, Rng, pictureToGround,
  type AssetRecord, type FeatureDef, type NavDef, type Vec2, type WorldDefinition, type ZoneDef, type ZoneKind,
} from '@gd/shared';
import { buildPack } from '../rules/encounters';
import { worldAssetDir, worldDir, writeJsonAtomic } from '../storage';
import { upscale } from './comfy';
import type { GpuQueue } from './gpu';
import { checkView, frameGuide, mapPixels, mapPrompt, paintMap, planMap, type MapBrief, type MapPlan, type ViewCheck } from './mapdraw';
import { CELL, walkOf, type Grid, type Side } from './mapgrid';
import { arbitrate, checkNames, classView, detectAll, entrances, landmarks, nameThings, qwenCells, samCells, type MapRead } from './mapread';
import { repairMap } from './maprepair';
import { candidates, place, pxPerMetre, type Candidate, type MapReading, type PlaceNeeds } from './placement';
import { MIST_SIZE, measureLight, paintMist, type MistBrief } from './atmosphere';
import { normColor } from './schemas';

/** Paint a place again (new seed) when its map is not top-down or has too little ground, at most this many times. */
const PAINT_TRIES = 3;
/** Walkable ground (m²) a map must have to work (towns 44×36 m, wilds 52×40, dungeons 28×22, rooms 14×11). */
export const MIN_AREA: Record<ZoneKind, number> = { town: 350, wilderness: 600, dungeon: 120, interior: 25 };
/** Monster packs keep their distance so fighting one never drags in the next (aggro reaches about 6.5 m). */
const PACK_SPACING = 13;

const THING_KINDS = new Set(['chest', 'sign', 'lore', 'waypoint', 'craft_station', 'bed', 'object']);

/** A place as far as painting and reading it go: what it is, its buildings and its ways out (ids are the world's). */
export interface PlaceSketch extends Pick<PlaceNeeds, 'name' | 'description' | 'buildings'> {
  id: string;
  kind: ZoneKind;
  indoor: boolean;
  lore?: string;
  /** Ways out. Those across the edge (not `into`) leave on a side of the map, toward where they lead on the world map. */
  exits: { id: string; to: string; into?: boolean; side?: Side }[];
}

/** The world as every place's design sees it. */
export interface WorldLook {
  id: string;
  /** Title and pitch. */
  story: string;
  artStyle: string;
}

export const worldLook = (w: WorldDefinition): WorldLook => ({ id: w.id, story: `${w.concept.title}. ${w.concept.pitch}`, artStyle: w.concept.artStyle });

/** The side of a map facing another place on the world map (y runs down the map, as on the screen). */
export function sideToward(from: { x: number; y: number }, to: { x: number; y: number } | undefined): Side {
  if (!to) return 'bottom';
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy < 0 ? 'top' : 'bottom';
}

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
    buildings: (z.buildings ?? []).map((b) => ({ id: b.id, name: b.name, purpose: b.purpose })),
    exits: z.features.filter((f) => f.kind === 'exit' || (f.kind === 'door' && !inside(f))).map((f) => {
      const into = z.kind !== 'interior' && target(f)?.kind === 'dungeon' && z.kind !== 'dungeon';
      // A room's door out is at the bottom of its map; other ways out face where they lead.
      const side = into ? undefined : z.kind === 'interior' ? 'bottom' : sideToward(z.mapPos, target(f)?.mapPos);
      return { id: f.id, to: target(f)?.name ?? 'elsewhere', into, side };
    }),
  };
}

/** What the place must hold: its entrances, ways out, people and things (by world id). */
export function placeNeeds(w: WorldDefinition, z: ZoneDef): PlaceNeeds {
  return {
    ...sketchOf(w, z),
    people: w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role, works: z.buildings?.find((b) => b.npcId === n.id)?.name })),
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

/** The ways out across the edge, as sides of the map. */
export const edgeSides = (s: PlaceSketch): Side[] => s.exits.filter((e) => !e.into).map((e) => e.side ?? 'bottom');

function mapBrief(w: WorldLook, s: PlaceSketch): MapBrief {
  return {
    world: w.story,
    artStyle: w.artStyle,
    name: s.name,
    kind: s.kind,
    indoor: s.indoor,
    description: s.description,
    lore: s.lore,
    buildings: s.buildings.map((b) => ({ name: b.name, purpose: b.purpose })),
    sides: edgeSides(s),
    inner: s.exits.filter((e) => e.into).map((e) => `a way down or in to ${e.to}`),
  };
}

/** Saved steps of one place's making, so a resumed build picks up where it stopped. */
export class PlaceDraft {
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
  file(name: string): Buffer | undefined {
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }
  saveFile(name: string, b: Buffer) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), b);
  }
  png(name: string): Buffer | undefined {
    return this.file(`${name}.png`);
  }
  savePng(name: string, b: Buffer) {
    this.saveFile(`${name}.png`, b);
  }
  /** A per-cell mask, saved as a grey PNG one pixel per cell. */
  async cells(name: string, g: Grid): Promise<Uint8Array | undefined> {
    const f = this.png(name);
    if (!f) return undefined;
    const raw = await sharp(f).greyscale().resize(g.cols, g.rows, { kernel: 'nearest' }).raw().toBuffer();
    return Uint8Array.from(raw, (v) => (v > 127 ? 1 : 0));
  }
  async saveCells(name: string, m: Uint8Array, g: Grid) {
    this.savePng(name, await sharp(Buffer.from(m.map((v) => (v ? 255 : 0))), { raw: { width: g.cols, height: g.rows, channels: 1 } }).png().toBuffer());
  }
}

export interface PlaceContext {
  gpu: GpuQueue;
  /** Lower paints first (the starting town before anything else). */
  priority: number;
  seed: number;
  report: (msg: string) => void;
  /** Steps done / total, for progress. */
  onPart?: (done: number, total: number) => void;
}

/** A place painted and read, before anything is put in it. */
export interface Painted {
  plan: MapPlan;
  /** Which of the place's maps (its seed): what is placed in it is saved per map. */
  seed: number;
  /** The finished (repaired) map. */
  canvas: Buffer;
  reading: MapReading;
}

/** How well a made map works as the place: higher is better (top-down 2, passed its check 1, ground up to 1). */
const mapScore = (view: ViewCheck, passed: boolean, area: number, minArea: number) => (view.pass ? 2 : 0) + (passed ? 1 : 0) + Math.min(1, area / minArea);

/** Steps of making one map, for progress. */
const STEPS = 4;

/**
 * Design, paint, read and repair a place's map: all it needs is what the place is, so it can start before the world
 * is assembled. A map that is not top-down, or has too little ground, is made again with a new seed; the best try is
 * kept. Ways out that stay imperfect are accepted (the best edge spot stands in).
 */
export async function paintAndRead(w: WorldLook, s: PlaceSketch, ctx: PlaceContext): Promise<Painted> {
  const draft = new PlaceDraft(w.id, s.id);
  const brief = mapBrief(w, s);
  // (A plan saved by the old isometric pipeline has no floor or barrier: the map is planned afresh.)
  const saved = draft.json<MapPlan>('plan');
  const plan = saved?.plan && saved.barrier ? saved : await planMap(brief);
  draft.saveJson('plan', plan);
  const prompt = mapPrompt(brief, plan);
  const guide = draft.png('guide') ?? (await frameGuide(plan, brief.sides, s.kind));
  draft.savePng('guide', guide);
  const minArea = MIN_AREA[s.kind];
  let best: (Painted & { score: number }) | undefined;
  for (let attempt = 0; attempt < PAINT_TRIES; attempt++) {
    const seed = ctx.seed + attempt * 1000;
    const step = (k: number) => ctx.onPart?.(attempt * STEPS + k, PAINT_TRIES * STEPS);
    // 1. Paint, and check the view.
    const map = draft.png(`map_${seed}`) ?? (await ctx.gpu.run('krea', ctx.priority, () => paintMap(guide, prompt, s.kind, seed)));
    draft.savePng(`map_${seed}`, map);
    const view = draft.json<ViewCheck>(`view_${seed}`) ?? (await checkView(map));
    draft.saveJson(`view_${seed}`, view);
    step(1);
    if (!view.pass) {
      ctx.report(`${s.name}: map ${attempt + 1} is not a top-down map (${view.angle}${view.detailed ? '' : ', not detailed'}), painting it again`);
      if (!best || mapScore(view, false, 0, minArea) > best.score) best = { plan, seed, canvas: map, reading: emptyReading(map, s.kind), score: mapScore(view, false, 0, minArea) };
      continue;
    }
    // 2. Read it.
    const read = await readMap(draft, map, s, seed, ctx);
    step(2);
    // 3. Check and repair it.
    const { X, Y } = mapPixels(s.kind);
    const g: Grid = { cols: Math.round(X / CELL), rows: Math.round(Y / CELL) };
    const fixed = await ctx.gpu.run('krea', ctx.priority, () => repairMap(map, read.open, {
      g, sides: brief.sides, style: plan.style, floor: plan.floor, barrier: plan.barrier, indoor: s.indoor || s.kind === 'interior', seed, minArea,
      report: (m) => ctx.report(`${s.name}: ${m}`),
      saved: (round) => {
        const png = draft.png(`map_${seed}_r${round}`), open = draft.file(`open_${seed}_r${round}.bin`);
        return png && open ? { png, open: new Uint8Array(open) } : undefined;
      },
      save: (round, png, open) => {
        draft.savePng(`map_${seed}_r${round}`, png);
        draft.saveFile(`open_${seed}_r${round}.bin`, Buffer.from(open));
      },
    }));
    step(3);
    // 4. The reading the game uses.
    const { width: W, height: H } = (await sharp(fixed.png).metadata()) as { width: number; height: number };
    const walk = fixed.walk.walk.map((v, i) => (v && fixed.walk.label[i] === fixed.walk.main ? 1 : 0));
    const area = walk.reduce((a, v) => a + v, 0) * CELL * CELL;
    const reading: MapReading = {
      width: W, height: H, X, Y, grid: g, walk, sight: read.sight,
      doors: entrances(read.detected, walk, g, W, H),
      edges: fixed.exits,
      landmarks: landmarks(read.detected, walk, g, W, H),
      area,
    };
    draft.saveJson(`made_${seed}`, { passed: fixed.passed, rounds: fixed.rounds, area: Math.round(area), exits: fixed.exits.map((e) => e.label), doors: reading.doors.length, landmarks: reading.landmarks.length, agree: read.agree });
    step(4);
    const score = mapScore(view, fixed.passed, area, minArea);
    ctx.report(`${s.name}: ${Math.round(area)} m² to walk, ways out ${fixed.exits.map((e) => e.label).join(', ') || 'none'}, ${reading.doors.length} entrances${fixed.passed ? '' : ' (its check did not pass in full)'}${area < minArea ? ' — too little ground, painting it again' : ''}`);
    if (!best || score > best.score) best = { plan, seed, canvas: fixed.png, reading, score };
    if (area >= minArea) break;
  }
  return { plan, seed: best!.seed, canvas: best!.canvas, reading: best!.reading };
}

/** A reading with no ground (a map that never became usable): settling still gives the place its ways out. */
function emptyReading(map: Buffer, kind: ZoneKind): MapReading {
  const { W, H, X, Y } = mapPixels(kind);
  const g: Grid = { cols: Math.round(X / CELL), rows: Math.round(Y / CELL) };
  void map;
  const open = new Uint8Array(g.cols * g.rows);
  for (let r = 4; r < g.rows - 4; r++) for (let c = 4; c < g.cols - 4; c++) open[r * g.cols + c] = 1;
  const walk = walkOf(open, g).walk;
  return { width: W, height: H, X, Y, grid: g, walk, sight: new Uint8Array(g.cols * g.rows).fill(1), doors: [], edges: [], landmarks: [], area: walk.reduce((a, v) => a + v, 0) * CELL * CELL };
}

/** Read a map: SAM's names (checked once by Luna), Qwen's plan, and Luna where they disagree. Saved per map. */
async function readMap(draft: PlaceDraft, map: Buffer, s: PlaceSketch, seed: number, ctx: PlaceContext) {
  const { X, Y } = mapPixels(s.kind);
  const g: Grid = { cols: Math.round(X / CELL), rows: Math.round(Y / CELL) };
  const { width: W } = (await sharp(map).metadata()) as { width: number };
  const pxm = W / X;
  let read = draft.json<MapRead>(`names_${seed}`);
  let detected;
  if (read) detected = await ctx.gpu.run('reader', ctx.priority, () => detectAll(map, read!, g, pxm));
  else {
    read = await nameThings(map, s.name, s.description);
    detected = await ctx.gpu.run('reader', ctx.priority, () => detectAll(map, read!, g, pxm));
    const fix = await checkNames(await classView(map, detected, g), s.name, read);
    if (fix) {
      ctx.report(`${s.name}: ${fix.mistakes.join('; ').slice(0, 300)}`);
      read = fix.read;
      detected = await ctx.gpu.run('reader', ctx.priority, () => detectAll(map, read!, g, pxm));
    }
    draft.saveJson(`names_${seed}`, read);
  }
  draft.saveFile(`classes_${seed}.jpg`, await classView(map, detected, g));
  const { open: samOpen, sight } = samCells(detected);
  const qwen = (await draft.cells(`qwen_${seed}`, g)) ?? (await ctx.gpu.run('reader', ctx.priority, () => qwenCells(map, g)));
  await draft.saveCells(`qwen_${seed}`, qwen, g);
  let open = await draft.cells(`open_${seed}`, g);
  let agree = draft.json<number>(`agree_${seed}`) ?? 0;
  if (!open) {
    const arb = await arbitrate(map, samOpen, qwen, g);
    open = arb.open;
    agree = +arb.agree.toFixed(3);
    ctx.report(`${s.name}: readers agree on ${Math.round(arb.agree * 100)}% of the map; Luna settled ${arb.patches} patches (${arb.calls} looks)`);
    await draft.saveCells(`open_${seed}`, open, g);
    draft.saveJson(`agree_${seed}`, agree);
  }
  return { detected, open, sight, agree };
}

/** Design, paint and read a place, and turn it into game data. */
export async function buildPlace(w: WorldDefinition, z: ZoneDef, ctx: PlaceContext): Promise<void> {
  await settlePlace(w, z, await paintAndRead(worldLook(w), sketchOf(w, z), ctx), ctx);
}

/**
 * Put everything in a made place (Luna decides where), bring the map to game scale and turn it into game data:
 * mutates the zone, the world's NPCs (and drops interiors whose building has no entrance) and its assets.
 */
export async function settlePlace(w: WorldDefinition, z: ZoneDef, { plan, seed, canvas, reading }: Painted, ctx: PlaceContext): Promise<void> {
  const draft = new PlaceDraft(w.id, z.id);
  const needs = placeNeeds(w, z);
  z.design = { style: plan.style, layout: plan.plan };
  z.look = { ambient: plan.look.ambient, lightColor: normColor(plan.look.lightColor) ?? '#ffe8c0', fogColor: normColor(plan.look.fogColor) ?? '#101418', outdoor: plan.look.outdoor && !z.indoor, weather: z.indoor ? 'none' : plan.look.weather };
  const cands = candidates(reading);
  // Spots are picture positions, so a saved placement belongs to one map (a resumed build may pick another).
  const placed = draft.json<[string, Candidate][]>(`placement_${seed}`);
  // The place's mist is designed and painted while Luna places everything (both on this place's turn).
  const [spots, mist] = await Promise.all([
    placed ? new Map(placed) : place(canvas, needs, cands).then((p) => p.spots),
    paintMist(mistBrief(z), draft, ctx.gpu, ctx.priority, ctx.seed),
  ]);
  draft.saveJson(`placement_${seed}`, [...spots.entries()]);

  // SeedVR2 adds the detail an enlarged map needs (painted at 2×, then resampled down to the exact size).
  const k = gameScale(reading);
  const FW = Math.round(reading.width * k), FH = Math.round(reading.height * k);
  const source = k > 1.02 ? await ctx.gpu.run('seedvr2', ctx.priority, () => upscale(canvas, 2, ctx.seed)) : canvas;
  const image = await sharp(source).resize(FW, FH, { kernel: 'lanczos3' }).webp({ quality: 90 }).toBuffer();
  const key = saveAsset(w, `place_${z.id}`, image, { kind: 'painting', prompt: `map of ${z.name}`, width: FW, height: FH });
  await setAir(w, z, image, mist);

  furnish(w, z, reading, spots, { k, width: FW, height: FH, image: key });
}

/** Write a place's image into the world's assets (replacing its earlier file) and record it; returns its key. */
function saveAsset(w: WorldDefinition, key: string, image: Buffer, rec: Pick<AssetRecord, 'kind' | 'prompt' | 'width' | 'height'>): string {
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${key}_${Date.now().toString(36)}.webp`;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${key}_`)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, file), image);
  w.assets[key] = { key, file, status: 'ok', ...rec };
  return key;
}

export const mistBrief = (z: ZoneDef): MistBrief => ({
  name: z.name, kind: z.kind, indoor: !!z.indoor, description: z.description, style: z.design?.style,
  weather: z.look.weather, fogColor: z.look.fogColor, lightColor: z.look.lightColor,
});

/** A place's air and light: its mist tile saved with its assets, and the light measured from its map. */
export async function setAir(w: WorldDefinition, z: ZoneDef, painting: Buffer, mist: Buffer): Promise<void> {
  z.look.mist = saveAsset(w, `mist_${z.id}`, mist, { kind: 'texture', prompt: `mist of ${z.name}`, width: MIST_SIZE, height: MIST_SIZE });
  z.look.painted = await measureLight(painting);
}

/** Paint and set a place's air afterwards (a world built before places had it), from its saved map. */
export async function addAir(w: WorldDefinition, z: ZoneDef, ctx: Pick<PlaceContext, 'gpu' | 'priority' | 'seed'>): Promise<void> {
  const file = z.painting && w.assets[z.painting.image]?.file;
  if (!file) return;
  const mist = await paintMist(mistBrief(z), new PlaceDraft(w.id, z.id), ctx.gpu, ctx.priority, ctx.seed);
  await setAir(w, z, fs.readFileSync(path.join(worldAssetDir(w.id), file)), mist);
}

/** Game scale: the map is resized by this so a metre is PX_PER_METRE pixels, the scale figures are drawn at. */
export const gameScale = (r: MapReading) => Math.max(0.25, Math.min(3, PX_PER_METRE / pxPerMetre(r)));

/** The map laid on the ground at game scale `k`: its size, where the ground origin sits (its top left) and its navigation grid. */
export function groundOf(r: MapReading, k: number): { width: number; height: number; ox: number; oy: number; nav: NavDef } {
  const width = Math.round(r.width * k), height = Math.round(r.height * k);
  const cols = Math.ceil(r.X / NAV_CELL), rows = Math.ceil(r.Y / NAV_CELL);
  const walk = new BitSet(cols * rows), sight = new BitSet(cols * rows);
  const cell = (x: number, y: number) => {
    const c = Math.floor(x / CELL), rr = Math.floor(y / CELL);
    return c < 0 || rr < 0 || c >= r.grid.cols || rr >= r.grid.rows ? -1 : rr * r.grid.cols + c;
  };
  // A cell is walkable when any part of it is (its centre and eight points 0.2 m out): the plan already keeps a
  // character's centre 0.35 m from obstacles, and the pathfinder never cuts corners, so a diagonal passage sampled at
  // cell centres alone would break into corner-touching cells.
  const Q = NAV_CELL / 2.5, AROUND = [-Q, 0, Q].flatMap((dx) => [-Q, 0, Q].map((dy) => [dx, dy] as const));
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL, y = (cy + 0.5) * NAV_CELL, i = cell(x, y);
      if (i >= 0 && r.sight[i]) sight.set(cy * cols + cx);
      if (AROUND.some(([dx, dy]) => {
        const j = cell(x + dx, y + dy);
        return j >= 0 && r.walk[j];
      })) walk.set(cy * cols + cx);
    }
  return { width, height, ox: 0, oy: 0, nav: { cols, rows, walk: walk.encode(), sight: sight.encode() } };
}

/**
 * Lay the map on the ground: the navigation grid, and positions in ground metres for everything placed. What Luna
 * could not place is set down by rule (people and things at open spots, monster packs and traps by depth).
 */
function furnish(w: WorldDefinition, z: ZoneDef, r: MapReading, spots: Map<string, Candidate>, pic: { k: number; width: number; height: number; image: string }) {
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

  // Doors and ways out stand where the map has them (on the walkable ground at the door's foot). A way out at the
  // map's edge stands 1.5 m in from it, so people arriving by it stand on ground the mist at the edge leaves clear.
  const IN = 1.5;
  const inward = (c: Candidate) => {
    const p = at(c);
    if (c.id[0] !== 'E') return p;
    return { x: p.x < IN ? p.x + IN : p.x > r.X - IN ? p.x - IN : p.x, y: p.y < IN ? p.y + IN : p.y > r.Y - IN ? p.y - IN : p.y };
  };
  const unplacedDoors: FeatureDef[] = [];
  for (const f of z.features) {
    if (f.kind !== 'door' && f.kind !== 'exit') continue;
    const c = spots.get(f.id);
    if (!c) {
      unplacedDoors.push(f);
      continue;
    }
    // (A spot the reading left off the walkable ground still gets the nearest point people can reach.)
    const p = nav.nearestWalkable(inward(c), 6) ?? nav.nearestWalkable(at(c), 400) ?? at(c);
    f.x = p.x;
    f.y = p.y;
    taken.push(p);
  }
  // A building the map has no entrance for is left out: its people move outdoors, its interior goes.
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
  // People who work in a building stand outside its entrance; everyone else where Luna put them.
  for (const n of w.npcs.filter((x) => x.zoneId === z.id)) {
    const work = z.buildings?.find((b) => b.npcId === n.id);
    const c = (work && spots.get(work.id)) || spots.get(n.id);
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
