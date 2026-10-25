/**
 * A place, from design to game data: Luna plans it, it is painted as a big top-down map (mapdraw.ts: the whole place
 * once, enlarged and detailed, then its exits and barrier), it is read (where people can walk, made usable without
 * repainting: mapread.ts, mapfix.ts), Luna decides where everything goes, and the map is resampled to game scale and
 * turned into ground metres (the navigation grid, every door, exit, person, chest, trap and monster pack). See
 * docs/places.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  BitSet, NAV_CELL, Nav, PX_PER_METRE, Rng, pictureToGround,
  type AssetRecord, type FeatureDef, type NavDef, type Vec2, type WorldDefinition, type ZoneDef, type ZoneKind,
  wayDrawnInside,
} from '@gd/shared';
import { buildPack } from '../rules/encounters';
import { worldAssetDir, worldDir, writeJsonAtomic } from '../storage';
import { upscale } from './comfy';
import type { GpuQueue } from './gpu';
import { BARRIER_DEPTH_M, EXIT_GAP_M, MAP_STEPS, PAINT_PXM, makeMap, mapPixels, planMap, type MapBrief, type MapExit, type MapPlan, type Tiles } from './mapdraw';
import { CELL, type Grid, type Side } from './mapgrid';
import { fixMap } from './mapfix';
import { BUILDING_PLAN, judgeArea, judgeWater, landmarks, readPlan, settle, WALK_READINGS, type PlanCells } from './mapread';
import { dropSameBuilding, findEntrances, fuseDoors, nameLandmarks, ontoWalk, readDoorPlan, type Spot } from './mapspots';
import { candidates, place, pxPerMetre, type Candidate, type MapReading, type PlaceNeeds } from './placement';
import { MIST_SIZE, measureLight, paintMist, type MistBrief } from './atmosphere';
import { normColor } from './schemas';

/** Monster packs keep their distance so fighting one never drags in the next (aggro reaches about 6.5 m). */
const PACK_SPACING = 13;
/** And from the ways in: a party arriving stands out of reach of every member (aggro 6.5 m, packs about 3 m across). */
const PACK_FROM_DOOR = 11;
/** A pack's centre keeps this far (m) from anything blocked where the map has room: in a room or clearing, not a passage. */
const PACK_CLEARANCE = 2;

const THING_KINDS = new Set(['chest', 'sign', 'lore', 'waypoint', 'craft_station', 'object']);

/** A place as far as painting and reading it go: what it is, its buildings and its ways out (ids are the world's). */
export interface PlaceSketch extends Pick<PlaceNeeds, 'name' | 'description' | 'buildings'> {
  id: string;
  kind: ZoneKind;
  /** The map's size (chosen when the world is planned). */
  tiles: Tiles;
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
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    tiles: z.tiles,
    indoor: !!z.indoor,
    description: z.description,
    lore: z.lore,
    buildings: (z.buildings ?? []).map((b) => ({ id: b.id, name: b.name, purpose: b.purpose })),
    exits: z.features.filter((f) => f.kind === 'exit').map((f) => {
      // A way down into a dungeon is drawn inside the map; other ways out face where they lead.
      const into = wayDrawnInside(z, target(f));
      return { id: f.id, to: target(f)?.name ?? 'elsewhere', into, side: into ? undefined : sideToward(z.mapPos, target(f)?.mapPos) };
    }),
  };
}

/** What the place must hold: its entrances, ways out, people and things (by world id). */
export function placeNeeds(w: WorldDefinition, z: ZoneDef): PlaceNeeds {
  return {
    ...sketchOf(w, z),
    // Companions travel in the party: they are not placed.
    people: w.npcs.filter((n) => n.zoneId === z.id && !n.companion).map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role, works: z.buildings?.find((b) => b.npcId === n.id)?.name })),
    things: z.features.filter((f) => THING_KINDS.has(f.kind)).map((f) => ({ id: f.id, what: thingText(f) })),
    bosses: w.bosses.filter((b) => b.zoneId === z.id).map((b) => ({ id: b.id, name: `${b.name}, ${b.title}`, what: b.description.slice(0, 200) })),
  };
}

function thingText(f: FeatureDef): string {
  switch (f.kind) {
    case 'chest': return `a treasure chest${f.items?.length ? ' holding something important' : ''}`;
    case 'sign': return 'a signpost greeting travellers';
    case 'lore': return `a note or inscription: "${f.name}"`;
    case 'waypoint': return 'the waypoint travellers use (central, easy to find)';
    case 'craft_station': return 'a workbench for crafting';
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
    tiles: s.tiles,
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

/**
 * Design and paint a place's map, and where people can walk on it: all it needs is what the place is, so it can start
 * before the world is assembled. Every step is saved in the place's draft, so a stopped build resumes.
 */
export async function paintAndRead(w: WorldLook, s: PlaceSketch, ctx: PlaceContext): Promise<Painted> {
  const draft = new PlaceDraft(w.id, s.id);
  const brief = mapBrief(w, s);
  // A plan saved by an earlier pipeline (no tiles or exit look) is planned afresh.
  const saved = draft.json<MapPlan>('plan');
  const plan = saved?.tiles && saved.exitLook ? saved : await planMap(brief);
  draft.saveJson('plan', plan);
  const made = await makeMap(brief, plan, ctx.seed, {
    gpu: (model, fn) => ctx.gpu.run(model, ctx.priority, fn),
    draft,
    report: ctx.report,
    step: (k) => ctx.onPart?.(k, MAP_STEPS),
  });
  const r = made.review;
  ctx.report(`${s.name}: map made (Sol: fun ${r.fun}, coherence ${r.coherence}, theme ${r.theme}${r.usable ? ', usable as is' : `; ${r.problems.slice(0, 200)}`})`);
  const reading = await readPlace(draft, made.png, s, made.exits, ctx);
  return { plan, seed: ctx.seed, canvas: made.png, reading };
}

/**
 * Read a painted map (mapread.ts, then mapfix.ts): Qwen's plans of it, Luna where they split and on its water, the
 * fixes that make it usable, and its entrances, named landmarks and ways out (mapspots.ts). Every step is saved per
 * map, so a resumed build picks up where it stopped.
 */
export async function readPlace(draft: PlaceDraft, map: Buffer, s: PlaceSketch, exits: MapExit[], ctx: PlaceContext): Promise<MapReading> {
  const { W, H, X, Y } = mapPixels(s.tiles);
  const g: Grid = { cols: Math.round(X / CELL), rows: Math.round(Y / CELL) };
  const tag = `${ctx.seed}`, place = { name: s.name, description: s.description };
  const band = Math.ceil(BARRIER_DEPTH_M / CELL), gap = EXIT_GAP_M / CELL;
  const plans: PlanCells[] = [];
  for (const [i, plan] of [...WALK_READINGS, BUILDING_PLAN].entries()) {
    const name = (part: string) => `read${i}_${part}_${tag}`;
    const saved = await Promise.all(['walk', 'water', 'building'].map((p) => draft.cells(name(p), g)));
    if (saved.every(Boolean)) {
      plans.push({ walk: saved[0]!, water: saved[1]!, building: saved[2]! });
      continue;
    }
    const read = await ctx.gpu.run('reader', ctx.priority, () => readPlan(map, g, plan, ctx.seed));
    for (const p of ['walk', 'water', 'building'] as const) await draft.saveCells(name(p), read[p], g);
    plans.push(read);
  }
  const walkPlans = plans.slice(0, WALK_READINGS.length), building = plans[plans.length - 1]!.building;
  let open = await draft.cells(`open_${tag}`, g);
  if (!open) {
    const st = await settle(map, walkPlans.map((p) => p.walk), g, place);
    const wet = await judgeWater(map, st.open, walkPlans.map((p) => p.water), g, band, place);
    ctx.report(`${s.name}: Qwen's readings agree on ${Math.round(st.agree * 100)}% of the map; Luna settled the rest (${st.looks} looks)${wet ? `, and ${wet} water patches people can walk across` : ''}`);
    open = st.open;
    await draft.saveCells(`open_${tag}`, open, g);
  }
  let walk = await draft.cells(`walk_${tag}`, g);
  let fixedOpen = await draft.cells(`fixed_${tag}`, g);
  if (!walk || !fixedOpen) {
    const keep = async (cells: number[]) => (await judgeArea(map, W, H, cells, g, place, 'reach').catch(() => 1)) > 0.5;
    const f = await fixMap(open, g, exits, band, gap, keep);
    ctx.report(`${s.name}: ${f.joined} cut-off areas joined, ${f.left} left out${f.exits ? `, ${f.exits} ways out opened` : ''}`);
    walk = f.walk;
    fixedOpen = f.open;
    await draft.saveCells(`walk_${tag}`, walk, g);
    await draft.saveCells(`fixed_${tag}`, fixedOpen, g);
  }
  const water = Uint8Array.from(fixedOpen, (_, i) => (2 * walkPlans.reduce((a, p) => a + p.water[i]!, 0) > walkPlans.length ? 1 : 0));
  let spots = draft.json<{ doors: Spot[]; landmarks: Spot[] }>(`spots_${tag}`);
  if (!spots) {
    const pxm = W / X;
    // Entrances only where the place has buildings: Luna's finds, moved onto Qwen's door marks (marks she missed are
    // kept too), onto the walkable ground, then one per building.
    const doors = async () => {
      // Qwen's door plan (GPU) and Luna's search (OpenAI) at once.
      const [marks, entrances] = await Promise.all([ctx.gpu.run('reader', ctx.priority, () => readDoorPlan(map, pxm, ctx.seed)), findEntrances(map, pxm, place)]);
      const found = fuseDoors(entrances, marks, pxm);
      const missed = marks.filter((m) => m.building && found.every((f) => Math.hypot(f.x - m.x, f.y - m.y) >= 2 * pxm)).map((m) => ({ x: m.x, y: m.y, label: 'a building' }));
      return dropSameBuilding(map, pxm, place, ontoWalk([...found, ...missed], walk!, g, W, H));
    };
    const [d, named] = await Promise.all([s.buildings.length ? doors() : Promise.resolve([]), nameLandmarks(map, pxm, place).catch((): Spot[] => [])]);
    // People stand on the walkable ground nearest a landmark (a pond's shore, a statue's foot).
    const sights = named.length ? ontoWalk(named, walk, g, W, H, 15) : landmarks(fixedOpen, walk, building, water, g, W, H);
    spots = { doors: d, landmarks: sights };
    ctx.report(`${s.name}: ${d.length} entrances; landmarks: ${sights.map((m) => m.label).join(', ')}`);
    draft.saveJson(`spots_${tag}`, spots);
  }
  const inset = (BARRIER_DEPTH_M + 2) * PAINT_PXM;
  const edges: Spot[] = exits.map((e) => {
    const a = e.at * (e.side === 'top' || e.side === 'bottom' ? W : H);
    return { x: e.side === 'left' ? inset : e.side === 'right' ? W - inset : a, y: e.side === 'top' ? inset : e.side === 'bottom' ? H - inset : a, label: e.side };
  });
  return {
    width: W, height: H, X, Y, grid: g, walk,
    // Buildings block sight; the rest of what blocks walking is mostly low (props, rocks) or seen through (trees' gaps).
    sight: Uint8Array.from(building, (v) => (v ? 0 : 1)),
    doors: spots.doors,
    edges,
    landmarks: spots.landmarks,
    area: walk.reduce((a, v) => a + v, 0) * CELL * CELL,
  };
}

/**
 * Put everything in a made place (Luna decides where), bring the map to game scale and turn it into game data:
 * mutates the zone, the world's NPCs and its assets.
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

  // SeedVR2 adds the detail a much enlarged map needs (painted at 2×, then resampled down to the exact size); the
  // painted maps are drawn about 1.2× (PAINT_PXM to PX_PER_METRE), which plain resampling handles.
  const k = gameScale(reading);
  const FW = Math.round(reading.width * k), FH = Math.round(reading.height * k);
  const source = k > 1.5 ? await ctx.gpu.run('seedvr2', ctx.priority, () => upscale(canvas, 2, ctx.seed)) : canvas;
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
  // character's centre CLEARANCE from obstacles, and the pathfinder never cuts corners, so a diagonal passage sampled at
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

  // Ways out stand where the map has them. A way out at the map's edge stands 1.5 m in from it, so people arriving
  // by it stand on ground the mist at the edge leaves clear; a way down drawn inside the map stands at its foot.
  const IN = 1.5;
  const inward = (c: Candidate) => {
    const p = at(c);
    if (c.id[0] !== 'E') return p;
    return { x: p.x < IN ? p.x + IN : p.x > r.X - IN ? p.x - IN : p.x, y: p.y < IN ? p.y + IN : p.y > r.Y - IN ? p.y - IN : p.y };
  };
  for (const f of z.features) {
    if (f.kind !== 'exit') continue;
    const c = spots.get(f.id);
    // (A spot the reading left off the walkable ground still gets the nearest point people can reach; placement
    // insists on every way out, so a missing one only guards a resumed draft.)
    const p = c ? nav.nearestWalkable(inward(c), 6) ?? nav.nearestWalkable(at(c), 400) ?? at(c) : settle(fallbackSpot());
    f.x = p.x;
    f.y = p.y;
    taken.push(p);
  }
  // People who work in a building stand outside its entrance; everyone else where Luna put them.
  for (const n of w.npcs.filter((x) => x.zoneId === z.id && !x.companion)) {
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
  const entryFeature = z.features.find((f) => f.kind === 'waypoint') ?? z.features.find((f) => f.kind === 'exit');
  z.entry = entryFeature ? { x: entryFeature.x, y: entryFeature.y } : settle(fallbackSpot());

  // A boss waits in the lair Luna chose for it (its spot), else deepest in.
  const lairs = new Map([...spots].filter(([id]) => w.bosses.some((b) => b.id === id)).map(([id, c]) => [id, at(c)]));
  if (z.kind === 'wilderness' || z.kind === 'dungeon') populate(w, z, nav, rng, r.area, taken, lairs);
}

/**
 * Monster packs, the boss and traps, spread by walking distance from the way in (deeper = harder). Packs gather in open
 * ground (rooms, clearings, squares), never passages: their centres keep PACK_CLEARANCE from anything blocked. A boss waits in its lair (a spot placement chose), else deepest in.
 */
export function populate(w: WorldDefinition, z: ZoneDef, nav: Nav, rng: Rng, area: number, taken: Vec2[], lairs = new Map<string, Vec2>()) {
  const r = w.ruleset;
  const costs = nav.reach(z.entry, 1e6);
  if (!costs.size) return;
  const far = Math.max(...costs.values());
  const cells = [...costs.keys()].map((i) => ({ i, p: nav.centre(i % nav.cols, Math.floor(i / nav.cols)), depth: costs.get(i)! / far }));
  rng.shuffle(cells);
  // The ways in, and where a party coming through each stands (no pack within sight of an arriving party).
  const doors = z.features.filter((f) => f.kind === 'exit').flatMap((f) => [f, nav.arrival(f)]);
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

  const bosses = w.bosses.filter((b) => b.zoneId === z.id);
  const deepest = cells.reduce((a, b) => (b.depth > a.depth ? b : a)).p;
  const reached = (p: Vec2) => costs.has(nav.cellOf(p.x, p.y)[1] * nav.cols + nav.cellOf(p.x, p.y)[0]);
  const lairOf = (id: string) => (lairs.has(id) && reached(lairs.get(id)!) ? lairs.get(id)! : deepest);
  for (const b of bosses) {
    const fam = w.families.find((f) => f.id === b.familyId) ?? families[0];
    if (!fam) continue;
    const adds = buildPack(r, rng.fork(`boss:${b.id}`), { mode: w.input.combatMode, level: b.level, kind: 'boss', roles: fam.members.map((m) => m.archetype) }).filter((m) => !m.boss);
    spawnAt(`${z.id}_boss`, [{ role: b.archetype, level: b.level, boss: true }, ...adds.map((m) => ({ ...m, level: Math.max(1, b.level - 1) }))], lairOf(b.id), fam.id, b.id);
  }

  // Packs: about one per 160 m² of walkable ground, spaced apart, away from the ways in and out.
  if (families.length) {
    const want = Math.max(3, Math.min(12, Math.round(area / (z.kind === 'dungeon' ? 130 : 160))));
    const packs: Vec2[] = bosses.length ? bosses.map((b) => lairOf(b.id)) : [deepest];
    // Only open ground, best clearance first (with some chance): fewer packs rather than packs in passages. A map with no
    // open ground at all takes the shuffled order.
    const clear = clearance(nav), roomy = cells.filter((c) => clear[c.i]! >= PACK_CLEARANCE);
    const order = roomy.length ? roomy.map((c) => ({ c, s: clear[c.i]! * (0.6 + 0.8 * rng.next()) })).sort((a, b) => b.s - a.s).map((x) => x.c) : cells;
    let n = 0;
    for (const c of order) {
      if (n >= want) break;
      if (nearDoor(c.p, PACK_FROM_DOOR) || packs.some((p) => Math.hypot(p.x - c.p.x, p.y - c.p.y) < PACK_SPACING)) continue;
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

/** Each navigation cell's distance (m) to the nearest blocked cell or the map's edge (city-block steps). */
export function clearance(nav: Nav): Float32Array {
  const n = nav.cols * nav.rows, d = new Float32Array(n).fill(Infinity), queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const cx = i % nav.cols, cy = Math.floor(i / nav.cols);
    if (!nav.walkableCell(cx, cy)) (d[i] = 0), queue.push(i);
    else if (cx === 0 || cy === 0 || cx === nav.cols - 1 || cy === nav.rows - 1) (d[i] = NAV_CELL), queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h]!, cx = i % nav.cols, cy = Math.floor(i / nav.cols);
    for (const [x, y] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
      const j = y * nav.cols + x;
      if (nav.inside(x, y) && d[j]! > d[i]! + NAV_CELL) (d[j] = d[i]! + NAV_CELL), queue.push(j);
    }
  }
  return d;
}
