/**
 * The architect: turns a place's floor plan (a Blueprint the level designer wrote) into a tile map. Areas with
 * a purpose get their own floor, walls and doorways where the plan asks for them, and their props set out the
 * way such a room is furnished (desks in rows with chairs, shelves along the walls, stools around a table).
 *
 * Built places are cut into rooms by straight corridors (a binary split, so every room opens onto one); natural
 * places are organic regions in a mass of filler (clearings in a forest) joined by trails.
 */
import {
  GROUND, OBJ, PROP_COVER, PROP_COVER_TALL, Rng, SURFACE_BASE, findPath, propCode, propIndex,
  type Blueprint, type BlueprintArea, type BlueprintArrangement, type PropDef, type GroundDef, type Vec2,
} from '@gd/shared';
import { MapBuilder, fbm, type Building, type EdgeDir, type LayoutResult } from './layout';

export interface ArchitectOpts {
  kind: 'town' | 'wilderness' | 'dungeon';
  size: number;
  /** Map sides with a way to a neighbouring place. */
  edges: EdgeDir[];
  /** Ways down (dungeon entrances) inside a wilderness. */
  internalExits: number;
  /** A town's enterable buildings, in the order of its doors. */
  buildings: string[];
  /** Under a roof: the edge is wall rather than filler. */
  enclosed: boolean;
  props: PropDef[];
  surfaces: GroundDef[];
}

export interface ArchitectResult extends LayoutResult {
  /** Each area as built (dungeons use them as rooms). */
  rooms: { x: number; y: number; w: number; h: number; cx: number; cy: number; name: string }[];
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
interface Req { area: BlueprintArea; weight: number; copy: number; building?: string }
interface Placed { req: Req; rect: Rect; tiles: Vec2[]; doors: Vec2[]; building?: Building; /** Where its furniture goes. */ inner?: Rect }

const WEIGHT = { small: 1, medium: 2, large: 4 } as const;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const w = (r: Rect) => r.x1 - r.x0 + 1;
const h = (r: Rect) => r.y1 - r.y0 + 1;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Build the map for a blueprint. Throws when the plan cannot be realised (the caller tries another seed). */
export function realiseBlueprint(bp: Blueprint, rng: Rng, o: ArchitectOpts): ArchitectResult {
  const a = new Architect(bp, rng, o);
  return bp.style === 'natural' && o.kind !== 'dungeon' ? a.natural() : a.built();
}

class Architect {
  m: MapBuilder;
  W: number;
  H: number;
  /** Tiles of corridors, lanes and trails. */
  corr: Uint8Array;
  /** Which placed area each tile belongs to (-1 none). */
  owner: Int16Array;
  placed: Placed[] = [];
  edgeExits: LayoutResult['edgeExits'] = {};
  internalExitSpots: Vec2[] = [];
  buildings: Building[] = [];
  propIdx = new Map<string, number>();
  corridorGround: number;
  /** What fills unused ground (the plan's filler or the place's big blocker). */
  fillCode: number = OBJ.tree;

  constructor(public bp: Blueprint, public rng: Rng, public o: ArchitectOpts) {
    this.W = o.size;
    this.H = o.size;
    this.m = new MapBuilder(this.W, this.H, rng, o.kind === 'dungeon' ? GROUND.wall : GROUND.floor);
    this.corr = new Uint8Array(this.W * this.H);
    this.owner = new Int16Array(this.W * this.H).fill(-1);
    o.props.forEach((p, i) => this.propIdx.set(p.id, i));
    this.corridorGround = this.groundOf(bp.corridors, GROUND.path);
  }

  // ---------------------------------------------------------------------------------- basics

  groundOf(id: string | undefined, fallback: number = GROUND.floor): number {
    if (!id) return fallback;
    if (id === 'floor') return GROUND.floor;
    if (id === 'floorAlt') return GROUND.floorAlt;
    if (id === 'path') return GROUND.path;
    if (id === 'water') return GROUND.water;
    const i = this.o.surfaces.findIndex((s) => s.id === id);
    return i >= 0 ? SURFACE_BASE + i : fallback;
  }

  prop(id: string | undefined): (PropDef & { index: number }) | null {
    if (!id) return null;
    const i = this.propIdx.get(id);
    return i === undefined ? null : { ...this.o.props[i]!, index: i };
  }

  /** The areas to build, one per copy, with the town's buildings matched to areas (or given small lots). */
  requests(): Req[] {
    const reqs: Req[] = [];
    const names = [...this.o.buildings];
    const claim = (want: string | undefined) => {
      if (!want || !names.length) return undefined;
      const n = norm(want);
      let i = names.findIndex((x) => norm(x) === n);
      if (i < 0) i = names.findIndex((x) => norm(x).includes(n) || n.includes(norm(x)));
      if (i < 0) return undefined;
      return names.splice(i, 1)[0];
    };
    for (const area of this.bp.areas) {
      const count = Math.max(1, Math.min(8, Math.round(area.count || 1)));
      // Lots are sized by the plan's size and by how much the area holds: a hall with three things in it
      // gets less floor than a room full of desks, so nothing reads as an empty warehouse.
      const holds = area.arrangements.reduce((s, r) => s + { few: 0.15, some: 0.4, many: 1 }[r.amount], 0);
      const weight = (WEIGHT[area.size] ?? 2) * Math.max(0.45, Math.min(1.25, 0.4 + holds * 0.6));
      for (let c = 0; c < count; c++) reqs.push({ area, weight, copy: c, building: c === 0 ? claim(area.building) : undefined });
    }
    // Buildings the plan did not seat: areas that wanted a building but lost the name match take them first.
    for (const r of reqs) if (!r.building && r.area.building && names.length) r.building = names.shift();
    for (const name of names) reqs.push({ area: { id: `lot_${reqs.length}`, name, purpose: name, count: 1, size: 'small', floor: 'floor', enclosure: 'open', where: 'any', arrangements: [] }, weight: 1, copy: 0, building: name });
    // Too many areas for the map: the smallest go first (never a building).
    const interior = (this.W - 4) * (this.H - 4);
    while (reqs.length > 2 && reqs.length * 42 > interior) {
      const i = reqs.reduce((best, r, k) => (!r.building && (best < 0 || r.weight < reqs[best]!.weight) ? k : best), -1);
      if (i < 0) break;
      reqs.splice(i, 1);
    }
    return reqs;
  }

  /** Where people arrive: the first linked side, or the middle. */
  primaryEntry(): Vec2 {
    const d = this.o.edges[0];
    const W = this.W, H = this.H;
    if (!d) return { x: W / 2, y: H / 2 };
    return { n: { x: W / 2, y: 0 }, s: { x: W / 2, y: H - 1 }, e: { x: W - 1, y: H / 2 }, w: { x: 0, y: H / 2 } }[d];
  }

  /** How well a spot suits an area's "where" (lower is better, 0..1). */
  hintCost(where: BlueprintArea['where'], c: Vec2, entry: Vec2): number {
    const W = this.W, H = this.H;
    const dEntry = Math.hypot(c.x - entry.x, c.y - entry.y) / Math.hypot(W, H);
    const dCenter = Math.hypot(c.x - W / 2, c.y - H / 2) / (Math.hypot(W, H) / 2);
    const dEdge = Math.min(c.x, c.y, W - 1 - c.x, H - 1 - c.y) / (Math.min(W, H) / 2);
    switch (where) {
      case 'entrance': return dEntry;
      case 'deep': return 1 - dEntry;
      case 'center': return dCenter;
      case 'edge': return dEdge;
      default: return 0.3;
    }
  }

  // ---------------------------------------------------------------------------------- built

  built(): ArchitectResult {
    const { m, W, H } = this;
    const reqs = this.requests();
    const inner: Rect = { x0: 2, y0: 2, x1: W - 3, y1: H - 3 };
    // The edge: walls indoors and underground, the plan's filler (or the place's big blocker) outdoors.
    const filler = this.prop(this.bp.filler);
    if (filler && filler.blocks && filler.size === 1) this.fillCode = propCode(filler.index, filler);
    m.rect(0, 0, W - 1, H - 1, (x, y) => {
      if (Math.min(x, y, W - 1 - x, H - 1 - y) >= 2) return;
      if (this.o.enclosed || this.o.kind === 'dungeon') m.setG(x, y, GROUND.wall);
      else m.setO(x, y, this.fillCode);
    });
    // Cut the floor into one lot per area, corridors along the cuts.
    const leaves: { rect: Rect; req: Req }[] = [];
    this.split(inner, this.rng.shuffle([...reqs]), 0, leaves);
    this.assign(leaves);
    for (const lf of leaves) this.buildArea(lf.req, lf.rect);
    // Ways out are cut before anything is furnished, so they never slice through furniture.
    this.openEdges();
    for (const p of this.placed) if (p.inner) this.furnish(p, p.inner);
    this.groundCover();
    this.dressCorridors();
    return this.finish();
  }

  /** Binary split: balance the areas' weights on both sides, leave a corridor between them. */
  split(r: Rect, reqs: Req[], depth: number, out: { rect: Rect; req: Req }[]): void {
    if (reqs.length === 1) return void out.push({ rect: r, req: reqs[0]! });
    const total = reqs.reduce((s, q) => s + q.weight, 0);
    // Two groups of similar weight (largest first, each to the lighter side).
    const sorted = [...reqs].sort((p, q) => q.weight - p.weight || this.rng.next() - 0.5);
    const A: Req[] = [], B: Req[] = [];
    let wa = 0, wb = 0;
    for (const q of sorted) {
      if (wa <= wb) (A.push(q), (wa += q.weight));
      else (B.push(q), (wb += q.weight));
    }
    const cw = depth === 0 ? 3 : 2;
    const MIN = 5;
    // Cut across whichever way leaves both sides best shaped (no long slivers of rooms).
    const share = wa / total;
    const jitter = this.rng.float(-1, 1);
    const option = (vertical: boolean) => {
      const len = (vertical ? w(r) : h(r)) - cw;
      if (len < MIN * 2) return null;
      const la = Math.max(MIN, Math.min(len - MIN, Math.round(len * share + jitter)));
      const other = vertical ? h(r) : w(r);
      const aspect = (a: number, b: number, n: number) => Math.max(a, b) / Math.min(a, b) / Math.sqrt(Math.max(1, n));
      // Groups of several areas are cut again later, so a long side is fine for them.
      const worst = Math.max(aspect(la, other, A.length), aspect(len - la, other, B.length));
      return { vertical, la, len, worst };
    };
    const opts = [option(true), option(false)].filter((x): x is NonNullable<typeof x> => !!x);
    if (!opts.length) {
      // No room for both: keep the heavier group only.
      return this.split(r, wa >= wb ? A : B, depth, out);
    }
    const { vertical, la } = opts.sort((p, q) => p.worst - q.worst)[0]!;
    const ground = this.corridorGround;
    if (vertical) {
      const cx0 = r.x0 + la, cx1 = cx0 + cw - 1;
      this.m.rect(cx0, r.y0, cx1, r.y1, (x, y) => this.corridorTile(x, y, ground));
      this.split({ ...r, x1: cx0 - 1 }, A, depth + 1, out);
      this.split({ ...r, x0: cx1 + 1 }, B, depth + 1, out);
    } else {
      const cy0 = r.y0 + la, cy1 = cy0 + cw - 1;
      this.m.rect(r.x0, cy0, r.x1, cy1, (x, y) => this.corridorTile(x, y, ground));
      this.split({ ...r, y1: cy0 - 1 }, A, depth + 1, out);
      this.split({ ...r, y0: cy1 + 1 }, B, depth + 1, out);
    }
  }

  corridorTile(x: number, y: number, ground: number) {
    const m = this.m;
    m.setG(x, y, ground);
    m.setO(x, y, 0);
    this.corr[m.i(x, y)] = 1;
  }

  /**
   * Move areas to the lots that suit their "where" (entrance, deep, centre, edge) and size best. The split already
   * gave each area a lot of the right size; pairs of areas swap lots while that makes the whole plan fit better.
   */
  assign(leaves: { rect: Rect; req: Req }[]) {
    const entry = this.primaryEntry();
    const total = leaves.reduce((s, l) => s + w(l.rect) * h(l.rect), 0);
    const wsum = leaves.reduce((s, l) => s + l.req.weight, 0);
    const cost = (q: Req, r: Rect) => {
      const want = (total * q.weight) / wsum;
      const c = { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
      return this.hintCost(q.area.where, c, entry) * (q.area.where === 'any' ? 0 : 1.4) + 1.6 * Math.abs(Math.log((w(r) * h(r)) / want)) + (q.building ? this.buildingLotCost(r) : 0);
    };
    for (let pass = 0; pass < 8; pass++) {
      let swapped = false;
      for (let i = 0; i < leaves.length; i++)
        for (let j = i + 1; j < leaves.length; j++) {
          const a = leaves[i]!, b = leaves[j]!;
          if (cost(a.req, b.rect) + cost(b.req, a.rect) < cost(a.req, a.rect) + cost(b.req, b.rect) - 0.01) {
            [a.req, b.req] = [b.req, a.req];
            swapped = true;
          }
        }
      if (!swapped) break;
    }
  }

  /** Buildings want a lot with a corridor on a side the camera sees (south or east), so their door shows. */
  buildingLotCost(r: Rect): number {
    const south = this.corr[this.m.i(Math.round((r.x0 + r.x1) / 2), Math.min(this.H - 1, r.y1 + 1))];
    const east = this.corr[this.m.i(Math.min(this.W - 1, r.x1 + 1), Math.round((r.y0 + r.y1) / 2))];
    return (south || east ? 0 : 1.5) + (w(r) < 7 || h(r) < 6 ? 2 : 0);
  }

  /** Sides of a lot that open onto a corridor, with the corridor-facing tiles. */
  openSides(r: Rect): { side: EdgeDir; tiles: Vec2[] }[] {
    const sides: { side: EdgeDir; tiles: Vec2[] }[] = [];
    const along = (side: EdgeDir) => {
      const t: Vec2[] = [];
      if (side === 'n' || side === 's') {
        const y = side === 'n' ? r.y0 : r.y1, oy = side === 'n' ? -1 : 1;
        for (let x = r.x0 + 1; x < r.x1; x++) if (this.m.in(x, y + oy) && this.corr[this.m.i(x, y + oy)]) t.push({ x, y });
      } else {
        const x = side === 'w' ? r.x0 : r.x1, ox = side === 'w' ? -1 : 1;
        for (let y = r.y0 + 1; y < r.y1; y++) if (this.m.in(x + ox, y) && this.corr[this.m.i(x + ox, y)]) t.push({ x, y });
      }
      return t;
    };
    for (const s of ['s', 'e', 'n', 'w'] as EdgeDir[]) {
      const t = along(s);
      if (t.length >= 2) sides.push({ side: s, tiles: t });
    }
    return sides;
  }

  /** Floor, walls and doorways, a building if the area holds one, then its furnishings. */
  buildArea(req: Req, rect: Rect) {
    const m = this.m;
    const idx = this.placed.length;
    const floor = this.groundOf(req.area.floor);
    const walled = req.area.enclosure === 'walled' || this.o.kind === 'dungeon';
    const p: Placed = { req, rect, tiles: [], doors: [] };
    this.placed.push(p);
    m.rect(rect.x0, rect.y0, rect.x1, rect.y1, (x, y) => {
      m.setG(x, y, floor);
      m.setO(x, y, 0);
      this.owner[m.i(x, y)] = idx;
    });
    let inner = rect;
    const sides = this.openSides(rect);
    if (walled && w(rect) >= 4 && h(rect) >= 4) {
      m.rect(rect.x0, rect.y0, rect.x1, rect.y1, (x, y) => {
        if (x === rect.x0 || y === rect.y0 || x === rect.x1 || y === rect.y1) m.setG(x, y, GROUND.wall);
      });
      // Doorways onto one or two corridors (wider for bigger rooms).
      const wide = req.area.size !== 'small' && this.o.kind !== 'dungeon' ? 2 : 1;
      const doorSides = sides.length ? this.rng.shuffle([...sides]).slice(0, req.area.size === 'large' || this.rng.chance(0.35) ? 2 : 1) : [];
      for (const s of doorSides) {
        const k = this.rng.int(0, Math.max(0, s.tiles.length - wide));
        for (const t of s.tiles.slice(k, k + wide)) this.doorway(p, t, floor);
      }
      if (!doorSides.length) {
        // A lot with no corridor beside it (rare): open the side nearest the middle.
        const t = { x: rect.x1, y: Math.round((rect.y0 + rect.y1) / 2) };
        this.doorway(p, t, floor);
        for (let x = t.x + 1; x < this.W - 2 && !this.corr[m.i(x, t.y)]; x++) this.corridorTile(x, t.y, this.corridorGround);
      }
      inner = { x0: rect.x0 + 1, y0: rect.y0 + 1, x1: rect.x1 - 1, y1: rect.y1 - 1 };
    }
    if (req.building) inner = this.building(p, inner, sides, req.building);
    for (let y = inner.y0; y <= inner.y1; y++) for (let x = inner.x0; x <= inner.x1; x++) if (m.g(x, y) !== GROUND.wall) p.tiles.push({ x, y });
    p.inner = inner;
  }

  doorway(p: Placed, t: Vec2, floor: number) {
    const m = this.m;
    m.setG(t.x, t.y, floor);
    m.reserve(t.x, t.y);
    // Keep the step inside the door clear too.
    for (const [dx, dy] of DIRS4) {
      const x = t.x + dx, y = t.y + dy;
      if (this.owner[m.i(x, y)] === this.placed.indexOf(p) && m.g(x, y) !== GROUND.wall) m.reserve(x, y);
    }
    p.doors.push(t);
  }

  /** An enterable building on its lot, set against the corridor it opens onto; returns the yard left over. */
  building(p: Placed, r: Rect, sides: { side: EdgeDir }[], name: string): Rect {
    const m = this.m;
    const bw = Math.min(w(r), this.rng.int(6, 9)), bh = Math.min(h(r), this.rng.int(5, 7));
    const side = sides.find((s) => s.side === 's')?.side ?? sides.find((s) => s.side === 'e')?.side ?? sides[0]?.side ?? 's';
    let x0: number, y0: number;
    if (side === 's') (x0 = r.x0 + this.rng.int(0, w(r) - bw)), (y0 = r.y1 - bh + 1);
    else if (side === 'e') (x0 = r.x1 - bw + 1), (y0 = r.y0 + this.rng.int(0, h(r) - bh));
    else if (side === 'n') (x0 = r.x0 + this.rng.int(0, w(r) - bw)), (y0 = r.y0);
    else (x0 = r.x0), (y0 = r.y0 + this.rng.int(0, h(r) - bh));
    const x1 = x0 + bw - 1, y1 = y0 + bh - 1;
    m.rect(x0, y0, x1, y1, (x, y) => {
      m.setG(x, y, GROUND.wall);
      m.setO(x, y, 0);
      m.reserve(x, y);
    });
    const door = side === 's' ? { x: this.rng.int(x0 + 1, x1 - 1), y: y1 } : side === 'n' ? { x: this.rng.int(x0 + 1, x1 - 1), y: y0 } : side === 'e' ? { x: x1, y: this.rng.int(y0 + 1, y1 - 1) } : { x: x0, y: this.rng.int(y0 + 1, y1 - 1) };
    const front = { x: door.x + (side === 'e' ? 1 : side === 'w' ? -1 : 0), y: door.y + (side === 's' ? 1 : side === 'n' ? -1 : 0) };
    m.setG(door.x, door.y, GROUND.path);
    m.reserve(front.x, front.y);
    // A short walk from the door to the corridor when the building does not touch it.
    let q = { ...front };
    for (let i = 0; i < 6 && m.in(q.x, q.y) && !this.corr[m.i(q.x, q.y)]; i++) {
      if (m.g(q.x, q.y) === GROUND.wall && !this.isOuterEdge(q)) m.setG(q.x, q.y, this.corridorGround);
      m.reserve(q.x, q.y);
      q = { x: q.x + (front.x - door.x), y: q.y + (front.y - door.y) };
    }
    const b: Building = { id: `b${this.buildings.length}`, x: x0, y: y0, w: bw, h: bh, door, front };
    this.buildings.push(b);
    this.buildingNames.push(name);
    p.building = b;
    // The yard: the larger strip beside or in front of the building.
    const strips: Rect[] = [
      { ...r, y1: y0 - 2 }, { ...r, y0: y1 + 2 }, { ...r, x1: x0 - 2 }, { ...r, x0: x1 + 2 },
    ].filter((s) => w(s) >= 2 && h(s) >= 2);
    return strips.sort((s, t) => w(t) * h(t) - w(s) * h(s))[0] ?? { x0: r.x0, y0: r.y0, x1: r.x0 - 1, y1: r.y0 - 1 };
  }
  buildingNames: string[] = [];

  isOuterEdge(p: Vec2) {
    return Math.min(p.x, p.y, this.W - 1 - p.x, this.H - 1 - p.y) < 2;
  }

  /** Ways out on the linked sides: the corridor that reaches that side, extended through the edge. */
  openEdges() {
    const { m, W, H } = this;
    for (const dir of this.o.edges) {
      const cand: Vec2[] = [];
      if (dir === 'n' || dir === 's') {
        const y = dir === 'n' ? 2 : H - 3;
        for (let x = 3; x < W - 3; x++) if (this.corr[m.i(x, y)]) cand.push({ x, y });
      } else {
        const x = dir === 'w' ? 2 : W - 3;
        for (let y = 3; y < H - 3; y++) if (this.corr[m.i(x, y)]) cand.push({ x, y });
      }
      const mid = (dir === 'n' || dir === 's' ? W : H) / 2;
      const pick = cand.sort((a, b) => Math.abs((dir === 'n' || dir === 's' ? a.x : a.y) - mid) - Math.abs((dir === 'n' || dir === 's' ? b.x : b.y) - mid))[0]
        ?? (dir === 'n' || dir === 's' ? { x: Math.floor(W / 2), y: dir === 'n' ? 2 : H - 3 } : { x: dir === 'w' ? 2 : W - 3, y: Math.floor(H / 2) });
      const step = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } }[dir];
      // Through the edge to the map border.
      let p = { ...pick };
      for (;;) {
        for (const off of [0, 1]) {
          const x = p.x + (step.x ? 0 : off), y = p.y + (step.y ? 0 : off);
          if (m.in(x, y)) this.corridorTile(x, y, this.corridorGround);
        }
        if (p.x <= 0 || p.y <= 0 || p.x >= W - 1 || p.y >= H - 1) break;
        p = { x: p.x + step.x, y: p.y + step.y };
      }
      // Inward until it meets a corridor of the network (when the pick was not on one).
      let q = { x: pick.x - step.x, y: pick.y - step.y };
      for (let i = 0; i < W && m.in(q.x, q.y) && !this.corr[m.i(q.x, q.y)]; i++) {
        this.corridorTile(q.x, q.y, this.corridorGround);
        q = { x: q.x - step.x, y: q.y - step.y };
      }
      this.edgeExits[dir] = p;
    }
  }

  /** The plan's corridor props (lamps, plants, bins) along the corridors' edges, never closing one off. */
  dressCorridors() {
    const { m } = this;
    const cp = this.bp.corridorProps ?? [];
    for (const arr of cp) {
      const p = this.prop(arr.prop);
      if (!p || p.size !== 1) continue;
      // Spaced out along the corridors' edges: none closer than this to another of its kind.
      const every = arr.amount === 'many' ? 6 : arr.amount === 'some' ? 10 : 16;
      const cands: Vec2[] = [];
      for (let y = 2; y < this.H - 2; y++)
        for (let x = 2; x < this.W - 2; x++) {
          const i = m.i(x, y);
          if (!this.corr[i] || m.reserved[i] || m.o(x, y)) continue;
          if (!DIRS4.some(([dx, dy]) => !this.corr[m.i(x + dx, y + dy)])) continue;
          // Only where the corridor is wide enough to pass beside it.
          if (p.blocks && !DIRS4.some(([dx, dy]) => this.corr[m.i(x + dx, y + dy)] && this.corr[m.i(x + dx * 2, y + dy * 2)])) continue;
          cands.push({ x, y });
        }
      const placed: Vec2[] = [];
      for (const c of this.rng.shuffle(cands)) {
        if (placed.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < every)) continue;
        m.setO(c.x, c.y, propCode(p.index, p));
        placed.push(c);
      }
    }
  }

  // ---------------------------------------------------------------------------------- furnishing

  furnish(p: Placed, r: Rect) {
    if (w(r) < 1 || h(r) < 1) return;
    const run = (bump: boolean) => {
      for (const arr of p.req.area.arrangements) {
        const prop = this.prop(arr.prop);
        if (!prop) continue;
        // A second, denser pass leaves centrepieces alone (one reception desk is right; two is not).
        // Nor more chairs and litter: only real furniture fills a room.
        if (bump && (arr.pattern === 'center' || arr.pattern === 'corners' || arr.pattern === 'line' || !prop.blocks)) continue;
        const amount = bump ? (arr.amount === 'few' ? 'some' : 'many') : arr.amount;
        this.arrange(p, r, { ...arr, amount }, prop, this.prop(arr.with));
      }
    };
    run(false);
    // An area that came out nearly empty for its size gets its own furniture again, more of it.
    if (this.fill(p, r) < 0.08) run(true);
  }

  /** Share of an area's tiles with something standing on them. */
  fill(p: Placed, r: Rect): number {
    let n = 0, used = 0;
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (!this.m.walkableGround(x, y) && this.m.g(x, y) !== GROUND.water) continue;
        n++;
        if (this.m.o(x, y)) used++;
      }
    return n ? used / n : 1;
  }

  /** Free for a prop: inside the area's rect, walkable, nothing there, not kept clear. */
  freeAt(p: Placed, r: Rect, x: number, y: number): boolean {
    const m = this.m;
    if (x < r.x0 || y < r.y0 || x > r.x1 || y > r.y1) return false;
    const i = m.i(x, y);
    return this.owner[i] === this.placed.indexOf(p) && !this.corr[i] && !m.reserved[i] && !m.o(x, y) && m.walkableGround(x, y) && !m.features.some((f) => f.x === x && f.y === y);
  }

  /** Put a prop with its back corner at x,y; refused if it does not fit or would wall part of the area off. */
  put(p: Placed, r: Rect, prop: PropDef & { index: number }, x: number, y: number): boolean {
    const m = this.m;
    const n = prop.size;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) if (!this.freeAt(p, r, x + dx, y + dy)) return false;
    const code = propCode(prop.index, prop);
    const cover = !prop.blocks ? 0 : prop.height === 'tall' ? PROP_COVER_TALL : PROP_COVER;
    const prev: number[] = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
      prev.push(m.o(x + dx, y + dy));
      m.setO(x + dx, y + dy, dx || dy ? cover || PROP_COVER : code);
    }
    // Non-blocking props bigger than a tile keep their other tiles walkable but taken.
    if (!prop.blocks) for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) if (dx || dy) m.reserve(x + dx, y + dy), m.setO(x + dx, y + dy, 0);
    if (prop.blocks && !this.stillConnected(p)) {
      let k = 0;
      for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) m.setO(x + dx, y + dy, prev[k++]!);
      return false;
    }
    return true;
  }

  /** Every open tile of the area can still be reached from its doorways / the corridors beside it. */
  stillConnected(p: Placed): boolean {
    const m = this.m;
    const idx = this.placed.indexOf(p);
    const inArea = (x: number, y: number) => m.in(x, y) && this.owner[m.i(x, y)] === idx;
    const open = (x: number, y: number) => m.passable(x, y);
    const seeds: Vec2[] = [];
    if (p.doors.length) seeds.push(...p.doors);
    else for (const t of p.tiles) if (DIRS4.some(([dx, dy]) => m.in(t.x + dx, t.y + dy) && this.corr[m.i(t.x + dx, t.y + dy)])) seeds.push(t);
    if (p.building) seeds.push(p.building.front);
    let total = 0;
    for (const t of p.tiles) if (open(t.x, t.y)) total++;
    const seen = new Set<number>();
    const stack = seeds.filter((s) => open(s.x, s.y)).map((s) => m.i(s.x, s.y));
    for (const s of stack) seen.add(s);
    let reached = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % this.W, y = (k / this.W) | 0;
      if (inArea(x, y)) reached++;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        const ni = m.i(nx, ny);
        if (!m.in(nx, ny) || seen.has(ni) || !open(nx, ny) || !(inArea(nx, ny) || this.corr[ni])) continue;
        // Through corridors only one step (to join doorways of the same area), never across the map.
        if (this.corr[ni] && !inArea(x, y)) continue;
        seen.add(ni);
        stack.push(ni);
      }
    }
    // Doorway tiles count as area tiles only when they are in the area.
    return reached >= total;
  }

  arrange(p: Placed, r: Rect, arr: BlueprintArrangement, prop: PropDef & { index: number }, mate: (PropDef & { index: number }) | null) {
    const rng = this.rng;
    const n = prop.size;
    const amount = arr.amount;
    // "few" is a handful whatever the room; "some" grows with the room; "many" fills it.
    const cap = amount === 'few' ? 3 : amount === 'some' ? Math.max(4, Math.min(16, Math.round((w(r) * h(r)) / (28 * n * n)))) : Infinity;
    let count = 0;
    const put = (x: number, y: number) => {
      if (count >= cap && arr.pattern !== 'rows' && arr.pattern !== 'grid') return false;
      const ok = this.put(p, r, prop, x, y);
      if (ok) count++;
      return ok;
    };
    /** The mate on the free tiles beside a prop (one for "rows", around it for "around"). */
    const putMates = (x: number, y: number, ring: boolean, side?: Vec2) => {
      if (!mate) return;
      const spots: Vec2[] = [];
      if (side) for (let k = 0; k < n; k++) spots.push(side.x ? { x: side.x > 0 ? x + n : x - 1, y: y + k } : { x: x + k, y: side.y > 0 ? y + n : y - 1 });
      else if (ring) {
        for (let k = 0; k < n; k++) spots.push({ x: x + k, y: y - 1 }, { x: x + k, y: y + n }, { x: x - 1, y: y + k }, { x: x + n, y: y + k });
      }
      for (const s of spots) if (mate.size === 1) this.put(p, r, mate, s.x, s.y);
    };
    const W0 = w(r), H0 = h(r);
    const horizontal = W0 >= H0;
    switch (arr.pattern) {
      case 'rows': {
        // Rows along the long side; a seat row beside each when there is a mate; aisles between.
        const period = n + (mate ? 1 : 0) + 1;
        const across = horizontal ? H0 : W0, along = horizontal ? W0 : H0;
        const maxRows = amount === 'few' ? 2 : amount === 'some' ? Math.max(2, Math.ceil(across / period / 1.6)) : 99;
        const start = across >= period + 2 ? 1 : 0;
        const margin = along >= 7 ? 1 : 0;
        const gapEvery = along > 9 ? rng.int(5, 7) : 99;
        let rows = 0;
        for (let o = start; o + n - 1 < across - (start ? 1 : 0) && rows < maxRows; o += period, rows++) {
          for (let a = margin; a + n - 1 < along - margin; a += n) {
            if ((a - margin + 1) % (gapEvery + 1) === 0) continue;
            const x = horizontal ? r.x0 + a : r.x0 + o, y = horizontal ? r.y0 + o : r.y0 + a;
            if (put(x, y) && mate) putMates(x, y, false, horizontal ? { x: 0, y: 1 } : { x: 1, y: 0 });
          }
        }
        break;
      }
      case 'grid': {
        const s = n + (amount === 'many' ? 1 : amount === 'some' ? 2 : 3);
        const off = W0 > s + 1 ? 1 : 0;
        for (let y = r.y0 + off; y + n - 1 <= r.y1; y += s) for (let x = r.x0 + off; x + n - 1 <= r.x1; x += s) if (put(x, y)) putMates(x, y, true);
        break;
      }
      case 'along_walls': {
        // Around the inside of the area, in runs, leaving the doorways clear.
        const perim: Vec2[] = [];
        for (let x = r.x0; x <= r.x1 - n + 1; x += n) perim.push({ x, y: r.y0 });
        for (let y = r.y0 + n; y <= r.y1 - n + 1; y += n) perim.push({ x: r.x1 - n + 1, y });
        for (let x = r.x1 - n + 1 - n; x >= r.x0; x -= n) perim.push({ x, y: r.y1 - n + 1 });
        for (let y = r.y1 - n + 1 - n; y > r.y0; y -= n) perim.push({ x: r.x0, y });
        const run = amount === 'many' ? 99 : amount === 'some' ? 3 : 2;
        const gap = amount === 'many' ? 0 : amount === 'some' ? rng.int(1, 2) : 3;
        let k = 0;
        for (const t of perim) {
          const inRun = k % (run + gap) < run;
          k++;
          if (!inRun) continue;
          if (put(t.x, t.y) && mate) {
            const side = t.y === r.y0 ? { x: 0, y: 1 } : t.y === r.y1 - n + 1 ? { x: 0, y: -1 } : t.x === r.x0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
            putMates(t.x, t.y, false, side);
          }
        }
        break;
      }
      case 'around': {
        const centers: Vec2[] = [];
        const span = n + 3;
        if (amount === 'few' || W0 < span * 2 || H0 < span * 2) centers.push({ x: Math.floor((r.x0 + r.x1 - n + 1) / 2), y: Math.floor((r.y0 + r.y1 - n + 1) / 2) });
        else {
          const sx = amount === 'many' ? span : span + 2;
          for (let y = r.y0 + 1; y + n <= r.y1; y += sx) for (let x = r.x0 + 1; x + n <= r.x1; x += sx) centers.push({ x, y });
          if (amount === 'some') rng.shuffle(centers).splice(Math.max(2, Math.ceil(centers.length / 2)));
        }
        for (const c of centers) if (put(c.x, c.y)) putMates(c.x, c.y, true);
        break;
      }
      case 'cluster': {
        const clusters = amount === 'few' ? 1 : amount === 'some' ? 2 : 4;
        for (let c = 0; c < clusters; c++) {
          let at = { x: rng.int(r.x0, Math.max(r.x0, r.x1 - n + 1)), y: rng.int(r.y0, Math.max(r.y0, r.y1 - n + 1)) };
          const size = rng.int(3, amount === 'many' ? 8 : 6);
          for (let k = 0, tries = 0; k < size && tries < 40; tries++) {
            if (put(at.x, at.y)) k++;
            const [dx, dy] = rng.pick(DIRS4);
            at = { x: Math.max(r.x0, Math.min(r.x1, at.x + dx * n)), y: Math.max(r.y0, Math.min(r.y1, at.y + dy * n)) };
          }
        }
        break;
      }
      case 'scatter': {
        const count = Math.max(1, Math.round(W0 * H0 * (amount === 'few' ? 0.04 : amount === 'some' ? 0.08 : 0.15) / (n * n)));
        for (let k = 0, tries = 0; k < count && tries < count * 8; tries++) {
          const x = rng.int(r.x0, r.x1), y = rng.int(r.y0, r.y1);
          if (put(x, y)) (k++, putMates(x, y, false, rng.pick([{ x: 1, y: 0 }, { x: 0, y: 1 }])));
        }
        break;
      }
      case 'center': {
        const x = Math.floor((r.x0 + r.x1 - n + 1) / 2), y = Math.floor((r.y0 + r.y1 - n + 1) / 2);
        if (put(x, y)) putMates(x, y, true);
        break;
      }
      case 'corners': {
        for (const [x, y] of [[r.x0, r.y0], [r.x1 - n + 1, r.y0], [r.x0, r.y1 - n + 1], [r.x1 - n + 1, r.y1 - n + 1]] as const) put(x, y);
        break;
      }
      case 'line': {
        // A counter or bar across the area a third of the way in, with a way round its end.
        const len = Math.max(n, Math.min(amount === 'few' ? 3 : amount === 'some' ? 6 : 12, Math.round((horizontal ? W0 : H0) * (amount === 'few' ? 0.4 : amount === 'some' ? 0.6 : 0.8))));
        const o = Math.max(0, Math.round((horizontal ? H0 : W0) / 3) - 1);
        const s0 = Math.floor(((horizontal ? W0 : H0) - len) / 2);
        for (let a = s0; a + n - 1 < s0 + len; a += n) {
          const x = horizontal ? r.x0 + a : r.x0 + o, y = horizontal ? r.y0 + o : r.y0 + a;
          if (put(x, y) && mate) putMates(x, y, false, horizontal ? { x: 0, y: 1 } : { x: 1, y: 0 });
        }
        break;
      }
      case 'ring': {
        const inset = W0 >= 9 && H0 >= 9 ? 2 : 1;
        const q = { x0: r.x0 + inset, y0: r.y0 + inset, x1: r.x1 - inset, y1: r.y1 - inset };
        const step = n + (amount === 'many' ? 1 : amount === 'some' ? 2 : 3);
        for (let x = q.x0; x <= q.x1 - n + 1; x += step) (put(x, q.y0), put(x, q.y1 - n + 1));
        for (let y = q.y0 + step; y < q.y1 - n + 1; y += step) (put(q.x0, y), put(q.x1 - n + 1, y));
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------------- natural

  natural(): ArchitectResult {
    const { m, W, H, rng } = this;
    const reqs = this.requests();
    const entry = this.primaryEntry();
    const filler = this.prop(this.bp.filler);
    if (filler && filler.blocks && filler.size === 1) this.fillCode = propCode(filler.index, filler);
    const fillCode = this.fillCode;
    // Region seeds: spread out, each drawn toward where its area wants to be.
    const seeds: { req: Req; x: number; y: number; r: number }[] = [];
    const scale = Math.sqrt(((W - 8) * (H - 8)) / Math.max(1, reqs.reduce((s, q) => s + q.weight, 0)) / Math.PI) * 0.92;
    for (const q of [...reqs].sort((p2, q2) => q2.weight - p2.weight)) {
      const r = Math.max(3.5, scale * Math.sqrt(q.weight));
      let best: Vec2 = { x: W / 2, y: H / 2 }, bestCost = Infinity;
      for (let t = 0; t < 140; t++) {
        const c = { x: rng.float(4 + r * 0.7, W - 5 - r * 0.7), y: rng.float(4 + r * 0.7, H - 5 - r * 0.7) };
        const crowd = seeds.reduce((s, sd) => s + Math.max(0, sd.r + r + 2 - Math.hypot(sd.x - c.x, sd.y - c.y)), 0);
        const cost = this.hintCost(q.area.where, c, entry) * 6 + crowd * 1.2;
        if (cost < bestCost) (bestCost = cost), (best = c);
      }
      seeds.push({ req: q, x: best.x, y: best.y, r });
    }
    // Each tile goes to the nearest region it lies inside of (organic edges), else it is filler.
    const noise = fbm(W, H, rng, [9, 4]);
    const fillNoise = fbm(W, H, rng, [6, 3]);
    m.rect(0, 0, W - 1, H - 1, (x, y) => {
      const d = Math.min(x, y, W - 1 - x, H - 1 - y);
      const i = m.i(x, y);
      const between = this.bp.between ?? 'filler';
      if (d < 2) {
        if (this.o.enclosed) m.setG(x, y, GROUND.wall);
        else if (between === 'water') m.setG(x, y, GROUND.water);
        else m.setO(x, y, fillCode);
        return;
      }
      let best = -1, bestD = Infinity;
      seeds.forEach((s, k) => {
        const dd = Math.hypot(x - s.x, y - s.y) / s.r + (noise[i]! - 0.5) * 0.5;
        if (dd < bestD) (bestD = dd), (best = k);
      });
      if (bestD <= 1) this.owner[i] = best;
      else if (between === 'water') m.setG(x, y, GROUND.water);
      else if (between === 'open' ? fillNoise[i]! > 0.68 : fillNoise[i]! > 0.38 || bestD > 1.5) m.setO(x, y, fillCode);
    });
    // Areas: floors, walls (ruins, fences) with gaps, then the trails between them.
    seeds.forEach((s, k) => {
      const tiles: Vec2[] = [];
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      const floor = this.groundOf(s.req.area.floor, GROUND.floorAlt);
      m.rect(0, 0, W - 1, H - 1, (x, y) => {
        if (this.owner[m.i(x, y)] !== k) return;
        tiles.push({ x, y });
        if (floor !== GROUND.floor) m.setG(x, y, floor);
        x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y);
      });
      this.placed.push({ req: s.req, rect: { x0, y0, x1, y1 }, tiles, doors: [] });
    });
    // Trails: a tree joining the regions (nearest first), plus a loop or two, plus each linked edge.
    // Ponds and pools are scenery: trails join the walkable areas only.
    const centers = this.placed.filter((p) => this.groundOf(p.req.area.floor) !== GROUND.water).map((p) => this.centerOf(p));
    if (!centers.length) centers.push({ x: Math.floor(W / 2), y: Math.floor(H / 2) });
    const joined = [0];
    const links: [number, number][] = [];
    while (joined.length < centers.length) {
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of joined) centers.forEach((c, j) => {
        if (joined.includes(j)) return;
        const d = Math.hypot(c.x - centers[i]!.x, c.y - centers[i]!.y);
        if (d < bd) (bd = d), (bi = i), (bj = j);
      });
      joined.push(bj);
      links.push([bi, bj]);
    }
    for (let k = 0; k < Math.min(2, centers.length - 2); k++) links.push([rng.int(0, centers.length - 1), rng.int(0, centers.length - 1)]);
    for (const [i, j] of links) if (i !== j) this.trail(centers[i]!, centers[j]!);
    for (const dir of this.o.edges) {
      const p = { n: { x: Math.floor(W / 2) + rng.int(-5, 5), y: 0 }, s: { x: Math.floor(W / 2) + rng.int(-5, 5), y: H - 1 }, e: { x: W - 1, y: Math.floor(H / 2) + rng.int(-5, 5) }, w: { x: 0, y: Math.floor(H / 2) + rng.int(-5, 5) } }[dir];
      const near = centers.reduce((b, c) => (Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? c : b), centers[0] ?? { x: W / 2, y: H / 2 });
      this.trail(p, near);
      this.edgeExits[dir] = p;
    }
    // Walled regions (ruins, fenced yards): a wall on their rim, broken where trails pass.
    this.placed.forEach((p, k) => {
      if (p.req.area.enclosure !== 'walled') return;
      for (const t of p.tiles) {
        const rim = DIRS4.some(([dx, dy]) => this.owner[m.i(t.x + dx, t.y + dy)] !== k);
        if (rim && !this.corr[m.i(t.x, t.y)] && !m.reserved[m.i(t.x, t.y)]) m.setG(t.x, t.y, GROUND.wall);
        else if (rim) p.doors.push(t);
      }
      p.tiles = p.tiles.filter((t) => m.g(t.x, t.y) !== GROUND.wall);
    });
    // Buildings on their regions, then furnishings.
    for (const p of this.placed) {
      const inner = this.innerRect(p);
      let r = inner;
      if (p.req.building) r = this.building(p, inner, [{ side: 's' }, { side: 'e' }], p.req.building);
      this.furnish(p, r);
    }
    this.groundCover();
    return this.finish();
  }

  centerOf(p: Placed): Vec2 {
    const c = p.tiles.reduce((s, t) => ({ x: s.x + t.x, y: s.y + t.y }), { x: 0, y: 0 });
    const n = Math.max(1, p.tiles.length);
    const ideal = { x: c.x / n, y: c.y / n };
    return p.tiles.reduce((b, t) => (Math.hypot(t.x - ideal.x, t.y - ideal.y) < Math.hypot(b.x - ideal.x, b.y - ideal.y) ? t : b), p.tiles[0] ?? { x: Math.round(ideal.x), y: Math.round(ideal.y) });
  }

  /** The biggest rectangle of a region's own tiles around its middle (for patterns that need straight lines). */
  innerRect(p: Placed): Rect {
    const m = this.m, k = this.placed.indexOf(p);
    const c = this.centerOf(p);
    const r: Rect = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    const ok = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!m.in(x, y) || this.owner[m.i(x, y)] !== k || m.g(x, y) === GROUND.wall) return false;
      return true;
    };
    for (let grew = true; grew; ) {
      grew = false;
      if (ok(r.x0 - 1, r.y0, r.x0 - 1, r.y1)) (r.x0--, (grew = true));
      if (ok(r.x1 + 1, r.y0, r.x1 + 1, r.y1)) (r.x1++, (grew = true));
      if (ok(r.x0, r.y0 - 1, r.x1, r.y0 - 1)) (r.y0--, (grew = true));
      if (ok(r.x0, r.y1 + 1, r.x1, r.y1 + 1)) (r.y1++, (grew = true));
    }
    return r;
  }

  /** A winding trail (2 wide), clearing filler on its way. */
  trail(a: Vec2, b: Vec2) {
    const { m, W, H } = this;
    const path = findPath(a, b, { width: W, height: H, passable: (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1, extraCost: (x, y) => (this.owner[m.i(x, y)] >= 0 ? 0.6 : 0) + this.rng.next() * 0.9, maxNodes: 60000 }) ?? [];
    for (const p of [a, ...path])
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]] as const) {
        const x = p.x + dx, y = p.y + dy;
        if (!m.in(x, y) || (Math.min(x, y, W - 1 - x, H - 1 - y) < 1 && !(x === p.x && y === p.y))) continue;
        this.corridorTile(x, y, this.corridorGround);
        m.reserve(x, y);
      }
  }

  /** Remove whatever stands on a tile, the whole of it (a big prop's every tile). */
  clearProp(x: number, y: number) {
    const m = this.m;
    const o = m.o(x, y);
    if (!o) return;
    // A cover tile belongs to the prop whose anchor is up and/or left of it.
    let ax = x, ay = y;
    if (o === PROP_COVER || o === PROP_COVER_TALL) {
      const anchor = ([[-1, 0], [0, -1], [-1, -1]] as const).map(([dx, dy]) => ({ x: x + dx, y: y + dy })).find((q) => {
        const pi = propIndex(m.o(q.x, q.y));
        return pi >= 0 && this.o.props[pi]?.size === 2;
      });
      if (!anchor) return void m.setO(x, y, 0);
      (ax = anchor.x), (ay = anchor.y);
    }
    const pi = propIndex(m.o(ax, ay));
    const n = pi >= 0 ? this.o.props[pi]?.size ?? 1 : 1;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) m.setO(ax + dx, ay + dy, 0);
  }

  /** A thin scatter of the plan's ground cover over all open ground (more of it outdoors, in the wild). */
  groundCover() {
    const m = this.m;
    const cover = (this.bp.groundCover ?? []).map((id) => this.prop(id)).filter((p): p is NonNullable<typeof p> => !!p && !p.blocks && p.size === 1);
    if (!cover.length) return;
    const rate = this.bp.style === 'natural' ? 0.09 : 0.025;
    for (let y = 2; y < this.H - 2; y++)
      for (let x = 2; x < this.W - 2; x++) {
        const i = m.i(x, y);
        if (m.o(x, y) || m.reserved[i] || !m.walkableGround(x, y) || this.rng.next() > (this.corr[i] ? rate * 0.3 : rate)) continue;
        if (m.features.some((f) => f.x === x && f.y === y)) continue;
        const p = this.rng.pick(cover);
        m.setO(x, y, propCode(p.index, p));
      }
  }

  // ---------------------------------------------------------------------------------- finishing

  /** Spots for everything the game places (people, monsters, chests, traps, exits), from the built map. */
  finish(): ArchitectResult {
    const { m, W, H, rng } = this;
    // Arrival: just inside the first linked side, a town's gathering place, or a dungeon's entrance room.
    const entranceArea = this.placed.find((p) => p.req.area.where === 'entrance') ?? this.placed[0];
    const gathering = this.placed.filter((p) => p.req.area.gathering);
    const plazaArea = this.o.kind === 'town' ? (gathering.find((p) => p.req.area.where === 'center') ?? gathering[0] ?? this.placed.find((p) => p.req.area.where === 'center')) : undefined;
    const openNear = (c: Vec2, r = 6) => {
      for (let d = 0; d <= r; d++)
        for (let y = c.y - d; y <= c.y + d; y++) for (let x = c.x - d; x <= c.x + d; x++) if (m.in(x, y) && m.passable(x, y) && !m.o(x, y) && !this.isOuterEdge({ x, y })) return { x, y };
      return null;
    };
    let entry: Vec2 | null = null;
    const first = this.o.edges[0];
    if (this.o.kind === 'dungeon' && entranceArea) entry = openNear(this.centerOf(entranceArea));
    else if (plazaArea) entry = openNear(this.centerOf(plazaArea));
    else if (first && this.edgeExits[first]) {
      const e = this.edgeExits[first]!;
      const step = { n: { x: 0, y: 1 }, s: { x: 0, y: -1 }, e: { x: -1, y: 0 }, w: { x: 1, y: 0 } }[first];
      entry = openNear({ x: e.x + step.x * 3, y: e.y + step.y * 3 });
    }
    entry ??= openNear({ x: Math.floor(W / 2), y: Math.floor(H / 2) }, 20) ?? { x: Math.floor(W / 2), y: Math.floor(H / 2) };
    // Ways down inside a wilderness: in the area that sounds like one (stairs, a hatch), else the deepest.
    const downish = /stair|elevator|lift|hatch|shaft|descent|cave|tunnel|entrance|gate|door|basement|vault|pit|well/i;
    const pool = [...this.placed].filter((p) => !p.building && p.tiles.length >= 9);
    for (let i = 0; i < this.o.internalExits; i++) {
      const pick = pool.find((p) => downish.test(`${p.req.area.name} ${p.req.area.purpose}`)) ?? pool.sort((a, b) => Math.hypot(this.centerOf(b).x - entry!.x, this.centerOf(b).y - entry!.y) - Math.hypot(this.centerOf(a).x - entry!.x, this.centerOf(a).y - entry!.y))[0];
      if (!pick) break;
      pool.splice(pool.indexOf(pick), 1);
      const s = openNear(this.centerOf(pick), 8);
      if (!s) continue;
      m.reserve(s.x, s.y);
      for (const [dx, dy] of DIRS4) {
        // Clear the way to it (a prop in front of a staircase would be odd).
        if (m.o(s.x + dx, s.y + dy) && this.owner[m.i(s.x + dx, s.y + dy)] >= 0) this.clearProp(s.x + dx, s.y + dy);
        m.reserve(s.x + dx, s.y + dy);
      }
      this.internalExitSpots.push(s);
    }
    m.reserve(entry.x, entry.y);
    // Reachability from the arrival point (and its distances, for "depth").
    const dist = new Int32Array(W * H).fill(-1);
    const q: number[] = [m.i(entry.x, entry.y)];
    dist[q[0]!] = 0;
    for (let k = 0; k < q.length; k++) {
      const i = q[k]!, x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy, ni = ny * W + nx;
        if (!m.in(nx, ny) || dist[ni]! >= 0 || !m.passable(nx, ny)) continue;
        dist[ni] = dist[i]! + 1;
        q.push(ni);
      }
    }
    let maxD = 1;
    for (let i = 0; i < dist.length; i++) if (dist[i]! > maxD) maxD = dist[i]!;
    // Ground nobody can reach outside the areas becomes filler (or wall indoors), so no pocket looks walkable.
    if (this.o.kind !== 'dungeon')
      for (let i = 0; i < W * H; i++) {
        const x = i % W, y = (i / W) | 0;
        if (dist[i]! < 0 && this.owner[i]! < 0 && !this.corr[i] && m.walkableGround(x, y) && !m.o(x, y)) {
          if (this.o.enclosed) m.setG(x, y, GROUND.wall);
          else m.setO(x, y, this.fillCode);
        }
      }
    const reach = (x: number, y: number) => m.in(x, y) && dist[m.i(x, y)]! >= 0;
    const depth = (x: number, y: number) => Math.max(0, dist[m.i(x, y)]!) / maxD;
    const freeTile = (x: number, y: number) => reach(x, y) && m.free(x, y);
    const room3 = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!freeTile(x + dx, y + dy)) return false;
      return true;
    };
    // Monster packs: open 3x3 spots spread out, preferring rooms over corridors, away from the arrival.
    const packSpots: ArchitectResult['packSpots'] = [];
    const cands: Vec2[] = [];
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) if (room3(x, y) && Math.hypot(x - entry.x, y - entry.y) > 10) cands.push({ x, y });
    rng.shuffle(cands).sort((a, b) => (this.corr[m.i(a.x, a.y)] ? 1 : 0) - (this.corr[m.i(b.x, b.y)] ? 1 : 0));
    for (const c of cands) {
      if (packSpots.length >= 14) break;
      if (packSpots.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 9)) continue;
      const room = this.owner[m.i(c.x, c.y)];
      packSpots.push({ ...c, depth: depth(c.x, c.y), room: room >= 0 ? room : undefined });
    }
    // Chests tucked against walls and furniture in rooms; traps on corridors; shrines and notes in rooms.
    const chestSpots: ArchitectResult['chestSpots'] = [];
    const roomTiles = this.placed.flatMap((p) => p.tiles).filter((t) => freeTile(t.x, t.y));
    for (const t of rng.shuffle([...roomTiles])) {
      if (chestSpots.length >= 8) break;
      const against = DIRS4.some(([dx, dy]) => m.g(t.x + dx, t.y + dy) === GROUND.wall || (m.o(t.x + dx, t.y + dy) && !m.passable(t.x + dx, t.y + dy)));
      if (!against || Math.hypot(t.x - entry.x, t.y - entry.y) < 8 || chestSpots.some((c) => Math.hypot(c.x - t.x, c.y - t.y) < 6)) continue;
      chestSpots.push({ ...t, depth: depth(t.x, t.y) });
    }
    const trapSpots: Vec2[] = [];
    for (let k = 0; k < 400 && trapSpots.length < 8; k++) {
      const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
      if (this.corr[m.i(x, y)] && freeTile(x, y) && Math.hypot(x - entry.x, y - entry.y) > 10) trapSpots.push({ x, y });
    }
    const decorSpots = rng.shuffle([...roomTiles]).slice(0, 8);
    // People: in the gathering areas first, then around the arrival.
    const npcSpots: Vec2[] = [];
    const npcPool = rng.shuffle((gathering.length ? gathering : this.placed).flatMap((p) => p.tiles).filter((t) => freeTile(t.x, t.y)));
    for (const t of npcPool) {
      if (npcSpots.length >= 40) break;
      if (!npcSpots.some((s) => Math.hypot(s.x - t.x, s.y - t.y) < 2)) npcSpots.push(t);
    }
    // Dungeons: the boss waits in the deepest room (or the one the plan calls deep).
    let bossSpot: Vec2 | undefined;
    if (this.o.kind === 'dungeon') {
      const rooms = this.placed.filter((p) => p !== entranceArea && p.tiles.some((t) => reach(t.x, t.y)));
      const deepest = rooms.sort((a, b) => (b.req.area.where === 'deep' ? 1 : 0) - (a.req.area.where === 'deep' ? 1 : 0) || depth(this.centerOf(b).x, this.centerOf(b).y) - depth(this.centerOf(a).x, this.centerOf(a).y))[0];
      if (deepest) {
        const c = this.centerOf(deepest);
        bossSpot = openNear(c) ?? c;
        m.rect(bossSpot.x - 1, bossSpot.y - 1, bossSpot.x + 1, bossSpot.y + 1, (x, y) => {
          if (this.owner[m.i(x, y)] === this.placed.indexOf(deepest) && m.g(x, y) !== GROUND.wall) this.clearProp(x, y);
        });
      }
      m.pruneWalls();
    }
    const rooms = this.placed.map((p) => {
      const c = this.centerOf(p);
      return { x: p.rect.x0, y: p.rect.y0, w: w(p.rect), h: h(p.rect), cx: c.x, cy: c.y, name: p.req.area.name };
    });
    const plaza = plazaArea ? this.centerOf(plazaArea) : undefined;
    // Buildings in the order of the town's doors (by name), so each door keeps its own interior.
    const order = this.o.buildings.map((n) => this.buildings[this.buildingNames.indexOf(n)]).filter((b): b is Building => !!b);
    return { map: m, entry, edgeExits: this.edgeExits, npcSpots, packSpots, chestSpots, trapSpots, decorSpots, buildings: order.length === this.buildings.length ? order : this.buildings, bossSpot, internalExitSpots: this.internalExitSpots, plaza, rooms };
  }
}
