/** Procedural tile-map generators for towns, wilderness, dungeons and building interiors. */
import { GROUND, OBJ, Rng, bytesToBase64, findPath, isWalkableGround, objBlocks, type FeatureDef, type Vec2, type ZoneLayoutPlan } from '@gd/shared';

const BLOCKING_OBJ = { has: objBlocks };

/** A neutral default plan (open, outdoor) for callers that do not have one. */
export const DEFAULT_PLAN: ZoneLayoutPlan = { structure: 'open', enclosed: false, blockers: { amount: 'some', arrangement: 'clusters' }, hazard: 'pools', structures: 'roofed', clutter: 'some' };

type PlanDraft = { structure?: ZoneLayoutPlan['structure']; enclosed?: boolean; blockers?: { amount?: ZoneLayoutPlan['blockers']['amount']; arrangement?: ZoneLayoutPlan['blockers']['arrangement'] }; hazard?: ZoneLayoutPlan['hazard']; structures?: ZoneLayoutPlan['structures']; clutter?: ZoneLayoutPlan['clutter'] };

/** Complete a (possibly partial) plan for a zone kind: each kind supports some structures, the rest is filled in. */
export function resolvePlan(kind: 'town' | 'wilderness' | 'dungeon', draft: PlanDraft | undefined, style?: string): ZoneLayoutPlan {
  const d = draft ?? {};
  const allowed: Record<typeof kind, ZoneLayoutPlan['structure'][]> = { town: ['hub', 'grid'], wilderness: ['open', 'grid'], dungeon: ['rooms', 'caves'] };
  const fallback: Record<typeof kind, ZoneLayoutPlan['structure']> = {
    town: d.structure === 'rooms' ? 'hub' : 'hub',
    wilderness: d.structure === 'rooms' ? 'grid' : 'open',
    dungeon: d.structure === 'open' ? 'caves' : d.structure === 'grid' || d.structure === 'hub' ? 'rooms' : style === 'dirt' || style === 'crystal' || style === 'flesh' ? 'caves' : 'rooms',
  };
  const structure = d.structure && allowed[kind].includes(d.structure) ? d.structure : fallback[kind];
  const enclosed = kind === 'dungeon' ? true : !!d.enclosed;
  return {
    structure,
    enclosed,
    blockers: { amount: d.blockers?.amount ?? 'some', arrangement: d.blockers?.arrangement ?? (structure === 'grid' ? 'rows' : 'clusters') },
    hazard: d.hazard ?? (structure === 'open' ? 'pools' : 'none'),
    structures: d.structures ?? (enclosed ? 'walled' : 'roofed'),
    clutter: d.clutter ?? 'some',
  };
}

/** Numbers behind the plan's words. */
function knobs(plan: ZoneLayoutPlan) {
  return {
    blockers: { sparse: 0.3, some: 0.55, dense: 0.8 }[plan.blockers.amount] ?? 0.55,
    clutter: { sparse: 0.5, some: 1, dense: 1.8 }[plan.clutter] ?? 1,
  };
}

/** A meandering band of impassable liquid from one side to the other (paths carved later bridge it). */
function river(m: MapBuilder, rng: Rng, width: number) {
  const vertical = rng.chance(0.5);
  const len = vertical ? m.h : m.w;
  let c = (vertical ? m.w : m.h) * rng.float(0.35, 0.65);
  for (let t = 0; t < len; t++) {
    c += rng.float(-0.9, 0.9);
    for (let d = -width; d <= width; d++) {
      const x = vertical ? Math.round(c + d) : t, y = vertical ? t : Math.round(c + d);
      if (m.in(x, y) && Math.min(x, y, m.w - 1 - x, m.h - 1 - y) >= 2) {
        m.setG(x, y, GROUND.water);
        m.setO(x, y, 0);
      }
    }
  }
}

export class MapBuilder {
  ground: Uint8Array;
  objects: Uint8Array;
  variation: Uint8Array;
  /** Tiles reserved for roads, doors, features etc. — decoration avoids them. */
  reserved: Uint8Array;
  features: FeatureDef[] = [];
  constructor(public w: number, public h: number, rng: Rng, fill: number = GROUND.floor) {
    this.ground = new Uint8Array(w * h).fill(fill);
    this.objects = new Uint8Array(w * h);
    this.reserved = new Uint8Array(w * h);
    this.variation = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) this.variation[i] = Math.floor(rng.next() * 256);
  }
  in(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  i(x: number, y: number) {
    return y * this.w + x;
  }
  g(x: number, y: number) {
    return this.in(x, y) ? this.ground[this.i(x, y)]! : GROUND.void;
  }
  setG(x: number, y: number, v: number) {
    if (this.in(x, y)) this.ground[this.i(x, y)] = v;
  }
  o(x: number, y: number) {
    return this.in(x, y) ? this.objects[this.i(x, y)]! : 0;
  }
  setO(x: number, y: number, v: number) {
    if (this.in(x, y)) this.objects[this.i(x, y)] = v;
  }
  walkableGround(x: number, y: number) {
    return isWalkableGround(this.g(x, y));
  }
  passable(x: number, y: number) {
    if (!this.walkableGround(x, y)) return false;
    if (BLOCKING_OBJ.has(this.o(x, y))) return false;
    return !this.features.some((f) => f.x === x && f.y === y && (f.kind === 'chest' || f.kind === 'shrine' || f.kind === 'sign' || f.kind === 'lever' || f.kind === 'gate' || f.kind === 'lore' || f.kind === 'bed' || f.kind === 'craft_station' || f.kind === 'waypoint'));
  }
  /** Free for placing something: walkable, no object, not reserved, no feature. */
  free(x: number, y: number) {
    return this.passable(x, y) && !this.o(x, y) && !this.reserved[this.i(x, y)] && !this.features.some((f) => f.x === x && f.y === y);
  }
  reserve(x: number, y: number) {
    if (this.in(x, y)) this.reserved[this.i(x, y)] = 1;
  }
  rect(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => void) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.in(x, y)) fn(x, y);
  }
  /** Carve a walkable path between two points (removes blocking objects and water). */
  carve(a: Vec2, b: Vec2, rng: Rng, width = 1, ground: number = GROUND.path) {
    const path = findPath(a, b, { width: this.w, height: this.h, passable: (x, y) => this.in(x, y) && this.g(x, y) !== GROUND.void && x > 0 && y > 0 && x < this.w - 1 && y < this.h - 1, extraCost: (x, y) => (this.g(x, y) === GROUND.water ? 3 : 0) + (BLOCKING_OBJ.has(this.o(x, y)) ? 1.5 : 0) + rng.next() * 0.8, maxNodes: 60000 });
    const pts = [a, ...(path ?? [])];
    for (const p of pts) {
      for (let dy = 0; dy < width; dy++)
        for (let dx = 0; dx < width; dx++) {
          const x = p.x + dx - Math.floor(width / 2), y = p.y + dy - Math.floor(width / 2);
          if (!this.in(x, y) || x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1) continue;
          if (this.g(x, y) === GROUND.wall && ground === GROUND.path) continue;
          this.setG(x, y, ground);
          this.setO(x, y, 0);
          this.reserve(x, y);
        }
    }
  }
  floodFrom(start: Vec2): Uint8Array {
    const seen = new Uint8Array(this.w * this.h);
    const stack = [this.i(start.x, start.y)];
    seen[stack[0]!] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % this.w, y = (k / this.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (!this.in(nx, ny)) continue;
        const ni = this.i(nx, ny);
        if (seen[ni] || !this.passable(nx, ny)) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    return seen;
  }
  randomFree(rng: Rng, filter?: (x: number, y: number) => boolean, tries = 400): Vec2 | null {
    for (let t = 0; t < tries; t++) {
      const x = rng.int(1, this.w - 2), y = rng.int(1, this.h - 2);
      if (this.free(x, y) && (!filter || filter(x, y))) return { x, y };
    }
    return null;
  }
  /** Drop walls that don't touch walkable ground so the map doesn't render a sea of blocks. */
  pruneWalls() {
    const keep = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.g(x, y) !== GROUND.wall) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) if (this.walkableGround(x + dx, y + dy) || this.g(x + dx, y + dy) === GROUND.water) near = true;
        if (near) keep[this.i(x, y)] = 1;
      }
    for (let k = 0; k < this.w * this.h; k++) if (this.ground[k] === GROUND.wall && !keep[k]) this.ground[k] = GROUND.void;
  }
  encode() {
    return { ground: bytesToBase64(this.ground), objects: bytesToBase64(this.objects), variation: bytesToBase64(this.variation) };
  }
}

/** Smooth value noise for organic shapes. */
export function valueNoise(w: number, h: number, scale: number, rng: Rng): Float32Array {
  const gw = Math.ceil(w / scale) + 2, gh = Math.ceil(h / scale) + 2;
  const grid = new Float32Array(gw * gh).map(() => rng.next());
  const out = new Float32Array(w * h);
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = x / scale, gy = y / scale;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const tx = s(gx - x0), ty = s(gy - y0);
      const a = grid[y0 * gw + x0]!, b = grid[y0 * gw + x0 + 1]!, c = grid[(y0 + 1) * gw + x0]!, d = grid[(y0 + 1) * gw + x0 + 1]!;
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  return out;
}

export function fbm(w: number, h: number, rng: Rng, scales = [16, 8, 4]): Float32Array {
  const out = new Float32Array(w * h);
  let total = 0;
  scales.forEach((sc, i) => {
    const amp = 1 / (i + 1);
    total += amp;
    const n = valueNoise(w, h, sc, rng);
    for (let k = 0; k < out.length; k++) out[k]! += n[k]! * amp;
  });
  for (let k = 0; k < out.length; k++) out[k]! /= total;
  return out;
}

export type EdgeDir = 'n' | 's' | 'e' | 'w';

export interface Building {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: Vec2;
  /** Tile outside the door where people arrive. */
  front: Vec2;
}

export interface LayoutResult {
  map: MapBuilder;
  entry: Vec2;
  edgeExits: Partial<Record<EdgeDir, Vec2>>;
  /** Spots for NPCs/merchants (outdoors). */
  npcSpots: Vec2[];
  /** Spots for monster packs (with a rough "depth" 0..1 from entry). */
  packSpots: (Vec2 & { depth: number; room?: number })[];
  chestSpots: (Vec2 & { depth: number })[];
  trapSpots: Vec2[];
  decorSpots: Vec2[];
  buildings: Building[];
  /** Dungeon only. */
  bossSpot?: Vec2;
  internalExitSpots: Vec2[];
  plaza?: Vec2;
}

const EDGE_ORDER: EdgeDir[] = ['e', 'w', 's', 'n'];

function edgePoint(dir: EdgeDir, w: number, h: number, rng: Rng): Vec2 {
  const j = rng.int(-4, 4);
  switch (dir) {
    case 'n': return { x: Math.floor(w / 2) + j, y: 0 };
    case 's': return { x: Math.floor(w / 2) + j, y: h - 1 };
    case 'e': return { x: w - 1, y: Math.floor(h / 2) + j };
    case 'w': return { x: 0, y: Math.floor(h / 2) + j };
  }
}

function inward(p: Vec2, dir: EdgeDir, n: number): Vec2 {
  switch (dir) {
    case 'n': return { x: p.x, y: p.y + n };
    case 's': return { x: p.x, y: p.y - n };
    case 'e': return { x: p.x - n, y: p.y };
    case 'w': return { x: p.x + n, y: p.y };
  }
}

// ------------------------------------------------------------------------------------- town

/** Straight L-shaped corridor between two points (unlike carve, which wanders like a trail). */
function corridor(m: MapBuilder, a: Vec2, b: Vec2, width: number, ground: number = GROUND.path) {
  const lay = (x: number, y: number) => {
    for (let d = 0; d < width; d++) {
      const off = d - Math.floor(width / 2);
      for (const [px, py] of [[x + off, y], [x, y + off]] as const) {
        if (px <= 0 || py <= 0 || px >= m.w - 1 || py >= m.h - 1) continue;
        m.setG(px, py, ground);
        m.setO(px, py, 0);
        m.reserve(px, py);
      }
    }
  };
  const sx = Math.sign(b.x - a.x), sy = Math.sign(b.y - a.y);
  let x = a.x, y = a.y;
  while (x !== b.x) (lay(x, y), (x += sx));
  while (y !== b.y) (lay(x, y), (y += sy));
  lay(x, y);
}

/**
 * Indoor hub (an office lobby, a station concourse, a mall atrium): a walled floor with a central atrium,
 * straight corridors to every exit, and suites (shops, offices, quarters) opening onto the corridors.
 */
function generateIndoorHub(rng: Rng, opts: { size: number; buildingCount: number; edges: EdgeDir[]; plan: ZoneLayoutPlan }): LayoutResult {
  const k = knobs(opts.plan);
  const W = opts.size, H = opts.size;
  const m = new MapBuilder(W, H, rng, GROUND.floor);
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  m.rect(0, 0, W - 1, H - 1, (x, y) => {
    if (Math.min(x, y, W - 1 - x, H - 1 - y) < 2) m.setG(x, y, GROUND.wall);
  });
  // Corridors from every side to the atrium (exits on linked sides, dead-end wings elsewhere).
  const edgeExits: LayoutResult['edgeExits'] = {};
  for (const dir of EDGE_ORDER) {
    const p = edgePoint(dir, W, H, rng);
    const start = opts.edges.includes(dir) ? inward(p, dir, 1) : inward(p, dir, 5);
    if (opts.edges.includes(dir)) edgeExits[dir] = p;
    corridor(m, start, { x: cx, y: cy }, 3);
    if (opts.edges.includes(dir)) m.setG(p.x, p.y, GROUND.path);
  }
  // Atrium: a different floor finish, a reception island, columns at its corners.
  m.rect(cx - 6, cy - 6, cx + 6, cy + 6, (x, y) => {
    m.setG(x, y, Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 5 ? GROUND.floorAlt : GROUND.path);
    m.setO(x, y, 0);
    m.reserve(x, y);
  });
  // Centrepiece: a pool or basin when the plan has liquid, otherwise an island of furniture.
  if (opts.plan.hazard !== 'none') m.rect(cx - 1, cy - 1, cx, cy, (x, y) => m.setG(x, y, GROUND.water));
  else m.rect(cx - 1, cy - 1, cx, cy, (x, y) => m.setO(x, y, OBJ.furniture));
  for (const [dx, dy] of [[-5, -5], [5, -5], [-5, 5], [5, 5]] as const) m.setO(cx + dx, cy + dy, OBJ.pillar);
  // Suites along the corridors.
  const buildings: Building[] = [];
  const occupied = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0 - 1; y <= y1 + 1; y++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (!m.in(x, y) || m.reserved[m.i(x, y)] || m.g(x, y) === GROUND.wall) return true;
        if (x < 3 || y < 3 || x > W - 4 || y > H - 4) return true;
      }
    return false;
  };
  let attempts = 0;
  while (buildings.length < opts.buildingCount && attempts++ < 4000) {
    const bw = rng.int(6, 9), bh = rng.int(5, 7);
    const x0 = rng.int(3, W - bw - 4), y0 = rng.int(3, H - bh - 4);
    const x1 = x0 + bw - 1, y1 = y0 + bh - 1;
    if (occupied(x0, y0, x1, y1)) continue;
    // Doors face the camera (south or east), on the side nearer the atrium.
    const doorSide = cx > x1 ? 'e' : 's';
    const door: Vec2 = doorSide === 's' ? { x: rng.int(x0 + 1, x1 - 1), y: y1 } : { x: x1, y: rng.int(y0 + 1, y1 - 1) };
    const front = doorSide === 's' ? { x: door.x, y: door.y + 1 } : { x: door.x + 1, y: door.y };
    m.rect(x0, y0, x1, y1, (x, y) => {
      m.setG(x, y, GROUND.wall);
      m.setO(x, y, 0);
      m.reserve(x, y);
    });
    m.setG(door.x, door.y, GROUND.path);
    // A short straight hallway to the nearest corridor.
    const target = Math.abs(front.x - cx) < Math.abs(front.y - cy) ? { x: cx, y: front.y } : { x: front.x, y: cy };
    corridor(m, front, target, 1);
    buildings.push({ id: `b${buildings.length}`, x: x0, y: y0, w: bw, h: bh, door, front });
  }
  // Furnishing: plants and lights lining the corridors, seating groups in open floor, the odd column.
  const decorSpots: Vec2[] = [];
  m.rect(2, 2, W - 3, H - 3, (x, y) => {
    if (!m.free(x, y)) return;
    const byCorridor = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.g(x + dx!, y + dy!) === GROUND.path);
    const byWall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.g(x + dx!, y + dy!) === GROUND.wall);
    if (byCorridor && rng.chance(0.06 * k.clutter)) m.setO(x, y, rng.chance(0.6) ? OBJ.plant : OBJ.light);
    else if (byWall && rng.chance(0.05 * k.clutter)) m.setO(x, y, OBJ.furniture);
    else if (rng.chance(0.012 * k.clutter)) m.setO(x, y, OBJ.furniture);
    else if (rng.chance(0.02 * k.blockers)) m.setO(x, y, rng.chance(0.5) ? OBJ.tree : OBJ.pillar);
    else if (rng.chance(0.02)) decorSpots.push({ x, y });
  });
  const npcSpots: Vec2[] = [];
  for (let i = 0; i < 40; i++) {
    const p = m.randomFree(rng, (x, y) => Math.hypot(x - cx, y - cy) < 14) ?? m.randomFree(rng);
    if (p) npcSpots.push(p);
  }
  return { map: m, entry: { x: cx + 3, y: cy + 3 }, edgeExits, npcSpots, packSpots: [], chestSpots: [], trapSpots: [], decorSpots, buildings, internalExitSpots: [], plaza: { x: cx, y: cy } };
}

/**
 * A town on a grid of lanes (streets, aisles, decks): enterable structures fill the blocks, facing the lanes,
 * with the zone's blockers and clutter in what is left.
 */
function generateGridTown(rng: Rng, opts: { size: number; buildingCount: number; edges: EdgeDir[]; plan: ZoneLayoutPlan }): LayoutResult {
  const W = opts.size, H = opts.size;
  const k = knobs(opts.plan);
  const m = new MapBuilder(W, H, rng, GROUND.floor);
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  const cell = rng.int(11, 13);
  m.rect(0, 0, W - 1, H - 1, (x, y) => {
    const d = Math.min(x, y, W - 1 - x, H - 1 - y);
    if (d < 2) {
      if (opts.plan.enclosed) m.setG(x, y, GROUND.wall);
      else m.setO(x, y, OBJ.tree);
    } else if (x % cell <= 1 || y % cell <= 1) {
      m.setG(x, y, GROUND.path);
      m.reserve(x, y);
    }
  });
  const edgeExits: LayoutResult['edgeExits'] = {};
  for (const dir of EDGE_ORDER) {
    if (!opts.edges.includes(dir)) continue;
    const p = edgePoint(dir, W, H, rng);
    edgeExits[dir] = p;
    corridor(m, inward(p, dir, 1), { x: cx, y: cy }, 2);
    m.setG(p.x, p.y, GROUND.path);
  }
  // A square at the centre lane crossing.
  const sq = { x: Math.round(cx / cell) * cell, y: Math.round(cy / cell) * cell };
  m.rect(sq.x - 3, sq.y - 3, sq.x + 4, sq.y + 4, (x, y) => {
    m.setG(x, y, GROUND.floorAlt);
    m.setO(x, y, 0);
    m.reserve(x, y);
  });
  if (opts.plan.hazard !== 'none') m.rect(sq.x, sq.y, sq.x + 1, sq.y + 1, (x, y) => m.setG(x, y, GROUND.water));
  else m.setO(sq.x, sq.y, OBJ.pillar);
  // One structure per block, set against the lane below or to the right so its door faces the camera.
  const buildings: Building[] = [];
  const blocks: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let by = 0; by * cell < H; by++)
    for (let bx = 0; bx * cell < W; bx++) {
      const x0 = bx * cell + 2, y0 = by * cell + 2, x1 = Math.min(W - 3, x0 + cell - 3), y1 = Math.min(H - 3, y0 + cell - 3);
      // Only blocks whose lower edge borders a lane can take a structure (its door opens onto that lane).
      if (x1 - x0 >= 5 && y1 - y0 >= 5 && (y1 + 1) % cell === 0 && y1 + 1 < H - 2) blocks.push({ x0, y0, x1, y1 });
    }
  for (const b of rng.shuffle([...blocks])) {
    if (buildings.length >= opts.buildingCount) break;
    if ([...Array((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1))].some((_, i) => m.reserved[m.i(b.x0 + (i % (b.x1 - b.x0 + 1)), b.y0 + Math.floor(i / (b.x1 - b.x0 + 1)))])) continue;
    const bw = Math.min(b.x1 - b.x0 + 1, rng.int(6, 9)), bh = Math.min(b.y1 - b.y0 + 1, rng.int(5, 7));
    const x0 = b.x0 + rng.int(0, b.x1 - b.x0 + 1 - bw), y1 = b.y1, y0 = y1 - bh + 1, x1 = x0 + bw - 1;
    const door = { x: rng.int(x0 + 1, x1 - 1), y: y1 };
    m.rect(x0, y0, x1, y1, (x, y) => {
      m.setG(x, y, GROUND.wall);
      m.setO(x, y, 0);
      m.reserve(x, y);
    });
    m.setG(door.x, door.y, GROUND.path);
    const front = { x: door.x, y: door.y + 1 };
    m.reserve(front.x, front.y);
    buildings.push({ id: `b${buildings.length}`, x: x0, y: y0, w: bw, h: bh, door, front });
  }
  // What is left of each block: the zone's blockers and clutter.
  const decorSpots: Vec2[] = [];
  m.rect(2, 2, W - 3, H - 3, (x, y) => {
    if (!m.free(x, y) || m.reserved[m.i(x, y)]) return;
    const byLane = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.g(x + dx!, y + dy!) === GROUND.path);
    if (byLane && rng.chance(0.05 * k.clutter)) m.setO(x, y, rng.chance(0.5) ? OBJ.light : OBJ.plant);
    else if (!byLane && rng.chance(0.06 * k.blockers)) m.setO(x, y, OBJ.tree);
    else if (rng.chance(0.04 * k.clutter)) m.setO(x, y, rng.chance(0.5) ? OBJ.rock : OBJ.rubble);
    else if (rng.chance(0.02)) decorSpots.push({ x, y });
  });
  const npcSpots: Vec2[] = [];
  for (let i = 0; i < 40; i++) {
    const p = m.randomFree(rng, (x, y) => Math.hypot(x - sq.x, y - sq.y) < 14) ?? m.randomFree(rng);
    if (p) npcSpots.push(p);
  }
  return { map: m, entry: { x: sq.x + 2, y: sq.y + 3 }, edgeExits, npcSpots, packSpots: [], chestSpots: [], trapSpots: [], decorSpots, buildings, internalExitSpots: [], plaza: sq };
}

export function generateTown(rng: Rng, opts: { size: number; buildingCount: number; edges: EdgeDir[]; plan?: ZoneLayoutPlan }): LayoutResult {
  const plan = opts.plan ?? { ...DEFAULT_PLAN, structure: 'hub' };
  if (plan.structure === 'grid') return generateGridTown(rng, { ...opts, plan });
  if (plan.enclosed) return generateIndoorHub(rng, { ...opts, plan });
  return generatePlazaTown(rng, { ...opts, plan });
}

/** An open-air town: lanes winding to a central square, structures along them, blockers around the edge. */
function generatePlazaTown(rng: Rng, opts: { size: number; buildingCount: number; edges: EdgeDir[]; plan: ZoneLayoutPlan }): LayoutResult {
  const k = knobs(opts.plan);
  const W = opts.size, H = opts.size;
  const m = new MapBuilder(W, H, rng, GROUND.floor);
  const noise = fbm(W, H, rng, [10, 5]);
  for (let k = 0; k < W * H; k++) if (noise[k]! > 0.6) m.ground[k] = GROUND.floorAlt;
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  // Roads: cross through the center, plaza in the middle.
  const edges = opts.edges;
  const edgeExits: LayoutResult['edgeExits'] = {};
  for (const dir of EDGE_ORDER) {
    const p = edgePoint(dir, W, H, rng);
    if (edges.includes(dir)) edgeExits[dir] = p;
    m.carve(edges.includes(dir) ? p : inward(p, dir, 6), { x: cx, y: cy }, rng, 3);
  }
  m.rect(cx - 5, cy - 5, cx + 5, cy + 5, (x, y) => {
    if (Math.hypot(x - cx, y - cy) <= 5.2) {
      m.setG(x, y, GROUND.path);
      m.setO(x, y, 0);
      m.reserve(x, y);
    }
  });
  // A border of the zone's blockers, leaving the lanes open.
  m.rect(0, 0, W - 1, H - 1, (x, y) => {
    const d = Math.min(x, y, W - 1 - x, H - 1 - y);
    if (m.reserved[m.i(x, y)]) return;
    if (d < 2 || (d < 4 && rng.chance(0.25 + 0.4 * k.blockers))) m.setO(x, y, OBJ.tree);
  });
  // Centrepiece: a pool when the plan has liquid, otherwise a monument.
  if (opts.plan.hazard !== 'none') m.rect(cx - 1, cy - 1, cx, cy, (x, y) => m.setG(x, y, GROUND.water));
  else m.setO(cx, cy, OBJ.pillar);
  const buildings: Building[] = [];
  const occupied = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0 - 1; y <= y1 + 1; y++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (!m.in(x, y) || m.reserved[m.i(x, y)] || m.g(x, y) === GROUND.wall || m.g(x, y) === GROUND.water) return true;
        if (x < 4 || y < 4 || x > W - 5 || y > H - 5) return true;
      }
    return false;
  };
  let attempts = 0;
  while (buildings.length < opts.buildingCount && attempts++ < 3000) {
    const bw = rng.int(6, 9), bh = rng.int(5, 7);
    const x0 = rng.int(4, W - bw - 5), y0 = rng.int(4, H - bh - 5);
    const x1 = x0 + bw - 1, y1 = y0 + bh - 1;
    if (occupied(x0, y0, x1, y1)) continue;
    // Door on the side closest to the plaza.
    // Doors go on the faces the isometric camera can see (south-west and south-east).
    const doorSide = cx > x1 && !(cy > y1 && Math.abs(cy - y1) > Math.abs(cx - x1)) ? 'e' : cy > y1 ? 's' : cx > (x0 + x1) / 2 ? 'e' : 's';
    const door: Vec2 = doorSide === 's' ? { x: rng.int(x0 + 1, x1 - 1), y: y1 } : { x: x1, y: rng.int(y0 + 1, y1 - 1) };
    const front = doorSide === 's' ? { x: door.x, y: door.y + 1 } : { x: door.x + 1, y: door.y };
    m.rect(x0, y0, x1, y1, (x, y) => {
      m.setG(x, y, GROUND.wall);
      m.setO(x, y, 0);
      m.reserve(x, y);
    });
    m.setG(door.x, door.y, GROUND.path);
    m.reserve(front.x, front.y);
    // Walkway from the door to the nearest road.
    m.carve(front, { x: cx, y: cy }, rng, 1);
    buildings.push({ id: `b${buildings.length}`, x: x0, y: y0, w: bw, h: bh, door, front });
  }
  // Decoration: trees, plants, lamps along roads.
  const decorSpots: Vec2[] = [];
  m.rect(2, 2, W - 3, H - 3, (x, y) => {
    if (!m.free(x, y)) return;
    const nearRoad = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.g(x + dx!, y + dy!) === GROUND.path);
    if (nearRoad && rng.chance(0.05)) m.setO(x, y, OBJ.light);
    else if (!nearRoad && rng.chance(0.06 * k.blockers)) m.setO(x, y, OBJ.tree);
    else if (rng.chance(0.06 * k.clutter)) m.setO(x, y, OBJ.plant);
    else if (rng.chance(0.02)) decorSpots.push({ x, y });
  });
  // Plaza lamps.
  for (const [dx, dy] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const) {
    m.reserved[m.i(cx + dx, cy + dy)] = 0;
    m.setO(cx + dx, cy + dy, OBJ.light);
  }
  const npcSpots: Vec2[] = [];
  for (let i = 0; i < 40; i++) {
    const p = m.randomFree(rng, (x, y) => Math.hypot(x - cx, y - cy) < 14 && m.g(x, y) !== GROUND.water) ?? m.randomFree(rng);
    if (p) npcSpots.push(p);
  }
  const entry = { x: cx + 3, y: cy + 3 };
  return { map: m, entry, edgeExits, npcSpots, packSpots: [], chestSpots: [], trapSpots: [], decorSpots, buildings, internalExitSpots: [], plaza: { x: cx, y: cy } };
}

// ------------------------------------------------------------------------------------- interior

export function generateInterior(rng: Rng, purpose: string): LayoutResult {
  const W = rng.int(11, 15), H = rng.int(9, 12);
  const m = new MapBuilder(W, H, rng, GROUND.floor);
  m.rect(0, 0, W - 1, H - 1, (x, y) => {
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) m.setG(x, y, GROUND.wall);
  });
  // Rug in the middle.
  m.rect(3, 3, W - 4, H - 4, (x, y) => rng.chance(0.9) && m.setG(x, y, GROUND.floorAlt));
  const door = { x: Math.floor(W / 2), y: H - 1 };
  m.setG(door.x, door.y, GROUND.path);
  const entry = { x: door.x, y: door.y - 1 };
  m.reserve(entry.x, entry.y);
  m.reserve(entry.x, entry.y - 1);
  for (let y = entry.y; y > Math.floor(H / 2); y--) m.reserve(door.x, y);
  // Furniture along the top wall, lights in corners.
  for (let x = 2; x < W - 2; x++) if (rng.chance(0.45)) m.setO(x, 1, OBJ.furniture);
  for (let y = 2; y < H - 3; y++) {
    if (rng.chance(0.3)) m.setO(1, y, OBJ.furniture);
    if (rng.chance(0.3)) m.setO(W - 2, y, OBJ.furniture);
  }
  m.setO(1, H - 2, OBJ.light);
  m.setO(W - 2, H - 2, OBJ.light);
  m.setO(1, 1, OBJ.plant);
  const decorSpots: Vec2[] = [];
  if (/inn|tavern|rest|bunk|hotel/i.test(purpose)) {
    for (let i = 0; i < 2; i++) {
      const p = m.randomFree(rng, (x, y) => x > W / 2 && y < H - 3);
      if (p) m.features.push({ id: `bed${i}`, kind: 'bed', x: p.x, y: p.y, name: 'Bed' });
    }
  }
  if (/forge|smith|craft|workshop|alchem/i.test(purpose)) {
    const p = m.randomFree(rng, (x, y) => y < H / 2);
    if (p) m.features.push({ id: 'craft', kind: 'craft_station', x: p.x, y: p.y, name: 'Workbench' });
  }
  // A counter in front of the shopkeeper.
  const keeper = { x: Math.floor(W / 2), y: 3 };
  if (/shop|store|merchant|smith|alchem|market|trader|vendor/i.test(purpose)) {
    for (let x = keeper.x - 2; x <= keeper.x + 2; x++) if (x !== keeper.x) m.setO(x, keeper.y + 1, OBJ.furniture);
  }
  m.setO(keeper.x, keeper.y, 0);
  const npcSpots: Vec2[] = [keeper];
  for (let i = 0; i < 8; i++) {
    const p = m.randomFree(rng);
    if (p) npcSpots.push(p);
  }
  const chestSpots = [m.randomFree(rng, (x, y) => y <= 2) ?? { x: 2, y: 2 }].map((p) => ({ ...p, depth: 0.2 }));
  return { map: m, entry, edgeExits: {}, npcSpots, packSpots: [], chestSpots, trapSpots: [], decorSpots, buildings: [], internalExitSpots: [door] };
}

// ------------------------------------------------------------------------------------- wilderness

/**
 * Built travel areas (open-plan office floors, parking garages, city blocks, ship decks): straight aisles on a
 * grid, blocks filled with regular rows of the zone's large blocker (cubicle partitions, parked cars, shelving,
 * columns), open blocks as gathering spots, columns at crossings. Indoors the edge is a wall.
 */
function builtTerrain(m: MapBuilder, rng: Rng, plan: ZoneLayoutPlan) {
  const W = m.w, H = m.h;
  const k = knobs(plan);
  const cell = rng.int(10, 13);
  const aisle = (v: number, n: number) => v % n <= 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const d = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (d < 2) {
        // The edge is blockers for now; indoors it becomes wall once the exits are cut through it.
        m.objects[k] = OBJ.tree;
        continue;
      }
      if (aisle(x, cell) || aisle(y, cell)) {
        m.ground[k] = GROUND.path;
        continue;
      }
    }
  // Blocks: most get rows of blockers, some stay open (lounges, plazas, clearings for fights).
  for (let by = 0; by * cell < H; by++)
    for (let bx = 0; bx * cell < W; bx++) {
      const x0 = bx * cell + 2, y0 = by * cell + 2, x1 = Math.min(W - 3, x0 + cell - 3), y1 = Math.min(H - 3, y0 + cell - 3);
      if (x1 - x0 < 3 || y1 - y0 < 3) continue;
      const kind = rng.next();
      const arrangement = plan.blockers.arrangement;
      if (plan.hazard === 'pools' && kind > 0.9) {
        // A pool filling part of the block.
        m.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, (x, y) => m.setG(x, y, GROUND.water));
      } else if (kind < k.blockers && arrangement === 'edges') {
        // Blockers ring the block, with a gap on two sides.
        m.rect(x0, y0, x1, y1, (x, y) => {
          const ring = x === x0 || x === x1 || y === y0 || y === y1;
          const gap = (y === y1 && Math.abs(x - (x0 + x1) / 2) < 1.5) || (x === x1 && Math.abs(y - (y0 + y1) / 2) < 1.5);
          if (ring && !gap) m.setO(x, y, OBJ.tree);
        });
      } else if (kind < k.blockers && arrangement === 'clusters') {
        const c = { x: rng.int(x0 + 1, x1 - 1), y: rng.int(y0 + 1, y1 - 1) };
        m.rect(x0, y0, x1, y1, (x, y) => {
          if (Math.hypot(x - c.x, y - c.y) < rng.float(1.5, 3.2)) m.setO(x, y, OBJ.tree);
        });
      } else if (kind < k.blockers && arrangement === 'scattered') {
        m.rect(x0, y0, x1, y1, (x, y) => {
          if (rng.chance(0.18)) m.setO(x, y, OBJ.tree);
        });
      } else if (kind < k.blockers) {
        // Rows two tiles apart with a gap every few tiles so the block can be walked through.
        const horizontal = rng.chance(0.5);
        const gap = rng.int(3, 5);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const row = horizontal ? (y - y0) % 2 === 0 : (x - x0) % 2 === 0;
            const along = horizontal ? x - x0 : y - y0;
            if (row && along % gap !== gap - 1) m.setO(x, y, OBJ.tree);
          }
      } else if (kind < k.blockers + 0.2) {
        // Open area on a different floor finish with a few pieces of furniture.
        m.rect(x0, y0, x1, y1, (x, y) => m.setG(x, y, GROUND.floorAlt));
        for (let i = 0; i < 3; i++) m.setO(rng.int(x0 + 1, x1 - 1), rng.int(y0 + 1, y1 - 1), OBJ.furniture);
      } else {
        // Scattered clutter.
        m.rect(x0, y0, x1, y1, (x, y) => {
          if (rng.chance(0.08 * k.clutter)) m.setO(x, y, OBJ.rock);
          else if (rng.chance(0.05 * k.clutter)) m.setO(x, y, OBJ.rubble);
          else if (rng.chance(0.05 * k.clutter)) m.setO(x, y, OBJ.plant);
        });
      }
    }
  // Channels: liquid down the middle of every other cross lane (lanes carved later bridge them).
  if (plan.hazard === 'channels')
    for (let y = cell; y < H - 2; y += cell * 2) m.rect(2, y, W - 3, y, (x, yy) => m.setG(x, yy, GROUND.water));
  if (plan.hazard === 'river') river(m, rng, 1);
  // Columns at aisle crossings, lights along aisles.
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      if (m.g(x, y) !== GROUND.path) continue;
      if (x % cell === 0 && y % cell === 0 && rng.chance(0.7)) m.setO(x, y, OBJ.pillar);
      else if ((x % cell === 1) !== (y % cell === 1) && rng.chance(0.03)) m.setO(x, y, OBJ.light);
    }
}

export function generateWilderness(rng: Rng, opts: { size: number; edges: EdgeDir[]; internalExits: number; style: string; plan?: ZoneLayoutPlan }): LayoutResult {
  const W = opts.size, H = opts.size;
  const plan = opts.plan ?? DEFAULT_PLAN;
  const m = new MapBuilder(W, H, rng, GROUND.floor);
  const grid = plan.structure === 'grid' || plan.blockers.arrangement === 'rows';
  if (grid) builtTerrain(m, rng, plan);
  else naturalTerrain(m, rng, plan);
  const out = finishWilderness(m, rng, { ...opts, built: grid });
  if (plan.enclosed)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (Math.min(x, y, W - 1 - x, H - 1 - y) >= 2 || m.o(x, y) !== OBJ.tree) continue;
        m.setO(x, y, 0);
        m.setG(x, y, GROUND.wall);
      }
  return out;
}

/** Free-form travel ground: blockers in groves, scattered or along the edges; pools or a river; clutter. */
function naturalTerrain(m: MapBuilder, rng: Rng, plan: ZoneLayoutPlan) {
  const W = m.w, H = m.h;
  const kn = knobs(plan);
  const arrangement = plan.blockers.arrangement;
  const n1 = fbm(W, H, rng, [14, 7, 3]);
  const n2 = fbm(W, H, rng, [9, 4]);
  const n3 = fbm(W, H, rng, [20, 10]);
  const treeDensity = 0.78 - kn.blockers * 0.25;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (n2[k]! > 0.58) m.ground[k] = GROUND.floorAlt;
      if (plan.hazard === 'pools' && n3[k]! > 0.72) m.ground[k] = GROUND.water;
      const d = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (d < 2) {
        m.objects[k] = OBJ.tree;
        continue;
      }
      if (m.ground[k] === GROUND.water) continue;
      const blocker =
        arrangement === 'scattered' ? rng.chance(0.02 + 0.09 * kn.blockers)
        : arrangement === 'edges' ? d < 3 + n1[k]! * 7 * kn.blockers || rng.chance(0.01)
        : n1[k]! > treeDensity && rng.chance(0.7);
      if (blocker) m.objects[k] = OBJ.tree;
      else if (rng.chance(0.012 * kn.clutter)) m.objects[k] = OBJ.rock;
      else if (rng.chance(0.07 * kn.clutter)) m.objects[k] = OBJ.plant;
      else if (rng.chance(0.006 * kn.clutter)) m.objects[k] = OBJ.rubble;
    }
  if (plan.hazard === 'river') river(m, rng, 1);
  if (plan.hazard === 'channels') for (let y = Math.floor(H / 3); y < H - 3; y += Math.floor(H / 3)) m.rect(2, y, W - 3, y + 1, (x, yy) => m.setG(x, yy, GROUND.water));
}

function finishWilderness(m: MapBuilder, rng: Rng, opts: { edges: EdgeDir[]; internalExits: number; built?: boolean }): LayoutResult {
  const W = m.w, H = m.h;
  const edges = opts.edges;
  const edgeExits: LayoutResult['edgeExits'] = {};
  const hub = { x: Math.floor(W / 2) + rng.int(-6, 6), y: Math.floor(H / 2) + rng.int(-6, 6) };
  for (const dir of edges) {
    const p = edgePoint(dir, W, H, rng);
    edgeExits[dir] = p;
    m.carve(p, hub, rng, 2);
  }
  // Internal exits (dungeon entrances) in remote spots, connected by trails.
  const internalExitSpots: Vec2[] = [];
  for (let i = 0; i < opts.internalExits; i++) {
    const angle = rng.float(0, Math.PI * 2);
    const r = rng.float(W * 0.25, W * 0.38);
    const p = { x: Math.round(W / 2 + Math.cos(angle) * r), y: Math.round(H / 2 + Math.sin(angle) * r) };
    p.x = Math.max(5, Math.min(W - 6, p.x));
    p.y = Math.max(5, Math.min(H - 6, p.y));
    m.rect(p.x - 2, p.y - 2, p.x + 2, p.y + 2, (x, y) => {
      m.setG(x, y, GROUND.floorAlt);
      m.setO(x, y, 0);
    });
    m.carve({ x: p.x, y: p.y + 1 }, hub, rng, 1);
    // Something framing the entrance: rocks in the wild, columns in built places.
    m.setO(p.x - 1, p.y, opts.built ? OBJ.pillar : OBJ.rock);
    m.setO(p.x + 1, p.y, opts.built ? OBJ.pillar : OBJ.rock);
    m.reserve(p.x, p.y);
    m.reserve(p.x, p.y + 1);
    internalExitSpots.push(p);
  }
  // Remove unreachable pockets.
  const entry = edges.length ? inward(edgeExits[edges[0]!]!, edges[0]!, 2) : hub;
  const reach = m.floodFrom(entry);
  for (let k = 0; k < W * H; k++) if (!reach[k] && m.walkableGround(k % W, (k / W) | 0) && !BLOCKING_OBJ.has(m.objects[k]!)) m.objects[k] = OBJ.tree;
  // Clearings for monster packs.
  const packSpots: LayoutResult['packSpots'] = [];
  for (let i = 0; i < 60 && packSpots.length < 14; i++) {
    const p = m.randomFree(rng, (x, y) => Math.hypot(x - entry.x, y - entry.y) > 12 && reach[m.i(x, y)] === 1);
    if (!p || packSpots.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 9)) continue;
    m.rect(p.x - 1, p.y - 1, p.x + 1, p.y + 1, (x, y) => {
      if (m.walkableGround(x, y) && m.o(x, y) !== OBJ.rock) m.setO(x, y, 0);
    });
    packSpots.push({ ...p, depth: Math.min(1, Math.hypot(p.x - entry.x, p.y - entry.y) / (W * 0.9)) });
  }
  const chestSpots: LayoutResult['chestSpots'] = [];
  for (let i = 0; i < 6; i++) {
    const p = m.randomFree(rng, (x, y) => reach[m.i(x, y)] === 1 && Math.hypot(x - entry.x, y - entry.y) > 8 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.o(x + dx!, y + dy!) === OBJ.tree));
    if (p) chestSpots.push({ ...p, depth: Math.hypot(p.x - entry.x, p.y - entry.y) / W });
  }
  const trapSpots: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    const p = m.randomFree(rng, (x, y) => m.g(x, y) === GROUND.path && Math.hypot(x - entry.x, y - entry.y) > 10);
    if (p) trapSpots.push(p);
  }
  const decorSpots: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    const p = m.randomFree(rng, (x, y) => reach[m.i(x, y)] === 1);
    if (p) decorSpots.push(p);
  }
  return { map: m, entry, edgeExits, npcSpots: [], packSpots, chestSpots, trapSpots, decorSpots, buildings: [], internalExitSpots };
}

// ------------------------------------------------------------------------------------- dungeon

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export function generateDungeon(rng: Rng, opts: { size: number; caves: boolean }): LayoutResult & { rooms: Room[]; gate?: { gates: Vec2[]; lever: Vec2 } } {
  const W = opts.size, H = opts.size;
  const m = new MapBuilder(W, H, rng, GROUND.wall);
  const rooms: Room[] = [];
  // BSP split.
  const split = (x: number, y: number, w: number, h: number, depth: number) => {
    if (depth > 3 || (w < 22 && h < 22)) {
      // Rooms big enough for a party to manoeuvre in during turn-based fights.
      const rw = rng.int(Math.min(8, w - 4), Math.max(8, Math.min(w - 4, 16)));
      const rh = rng.int(Math.min(7, h - 4), Math.max(7, Math.min(h - 4, 14)));
      const rx = x + rng.int(2, Math.max(2, w - rw - 2)), ry = y + rng.int(2, Math.max(2, h - rh - 2));
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) });
      return;
    }
    const horiz = w > h ? false : h > w ? true : rng.chance(0.5);
    if (horiz) {
      const s = rng.int(Math.floor(h * 0.4), Math.floor(h * 0.6));
      split(x, y, w, s, depth + 1);
      split(x, y + s, w, h - s, depth + 1);
    } else {
      const s = rng.int(Math.floor(w * 0.4), Math.floor(w * 0.6));
      split(x, y, s, h, depth + 1);
      split(x + s, y, w - s, h, depth + 1);
    }
  };
  split(1, 1, W - 2, H - 2, 0);
  for (const r of rooms) {
    m.rect(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, (x, y) => {
      if (opts.caves) {
        const dx = (x - r.cx) / (r.w / 2), dy = (y - r.cy) / (r.h / 2);
        if (dx * dx + dy * dy > 1.05 + rng.float(-0.25, 0.1)) return;
      }
      m.setG(x, y, GROUND.floor);
    });
  }
  // Connect rooms in BSP order with corridors (L-shaped, 2-3 tiles wide so parties can pass and fight), plus loops.
  const corridor = (a: Room, b: Room) => {
    let x = a.cx, y = a.cy;
    const width = opts.caves ? rng.int(2, 4) : rng.chance(0.35) ? 3 : 2;
    const horizontalFirst = rng.chance(0.5);
    const brush = (cx: number, cy: number) => {
      const r0 = -Math.floor((width - 1) / 2);
      for (let dy = r0; dy < r0 + width; dy++) for (let dx = r0; dx < r0 + width; dx++) dig(cx + dx, cy + dy);
      // Caves: ragged edges.
      if (opts.caves && rng.chance(0.25)) dig(cx + rng.int(-2, 2), cy + rng.int(-2, 2));
    };
    brush(x, y);
    const stepX = () => { while (x !== b.cx) { x += Math.sign(b.cx - x); brush(x, y); } };
    const stepY = () => { while (y !== b.cy) { y += Math.sign(b.cy - y); brush(x, y); } };
    if (horizontalFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  };
  const corridorTiles: Vec2[] = [];
  const dig = (x: number, y: number) => {
    if (!m.in(x, y) || x < 1 || y < 1 || x > W - 2 || y > H - 2) return;
    if (m.g(x, y) === GROUND.wall) {
      m.setG(x, y, GROUND.path);
      corridorTiles.push({ x, y });
    }
  };
  for (let i = 1; i < rooms.length; i++) corridor(rooms[i - 1]!, rooms[i]!);
  for (let i = 0; i < Math.floor(rooms.length / 3); i++) corridor(rng.pick(rooms), rng.pick(rooms));
  // Floor variation and decoration inside rooms.
  const noise = fbm(W, H, rng, [6, 3]);
  for (const r of rooms) {
    m.rect(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, (x, y) => {
      if (m.g(x, y) !== GROUND.floor) return;
      if (noise[m.i(x, y)]! > 0.62) m.setG(x, y, GROUND.floorAlt);
    });
    if (r.w >= 9 && r.h >= 8 && rng.chance(0.6)) {
      for (const [px, py] of [[r.x + 2, r.y + 2], [r.x + r.w - 3, r.y + 2], [r.x + 2, r.y + r.h - 3], [r.x + r.w - 3, r.y + r.h - 3]] as const)
        if (m.walkableGround(px, py)) m.setO(px, py, OBJ.pillar);
    }
    if (rng.chance(0.25) && opts.caves) {
      const p = { x: r.cx + rng.int(-2, 2), y: r.cy + rng.int(-2, 2) };
      m.rect(p.x - 1, p.y - 1, p.x + 1, p.y, (x, y) => m.walkableGround(x, y) && m.setG(x, y, GROUND.water));
    }
  }
  // Lights on room edges (braziers/torches).
  for (const r of rooms) {
    for (let t = 0; t < 2; t++) {
      const x = rng.int(r.x, r.x + r.w - 1), y = rng.chance(0.5) ? r.y : r.y + r.h - 1;
      if (m.walkableGround(x, y)) m.setO(x, y, OBJ.light);
    }
    for (let t = 0; t < 4; t++) {
      const x = rng.int(r.x, r.x + r.w - 1), y = rng.int(r.y, r.y + r.h - 1);
      if (m.walkableGround(x, y) && !m.o(x, y)) m.setO(x, y, rng.chance(0.6) ? OBJ.rubble : OBJ.rock);
    }
  }
  // Entrance = first room; boss = farthest room by path.
  const start = rooms[0]!;
  const entry = { x: start.cx, y: start.cy };
  m.rect(entry.x - 1, entry.y - 1, entry.x + 1, entry.y + 1, (x, y) => {
    m.setO(x, y, 0);
    if (m.g(x, y) === GROUND.water) m.setG(x, y, GROUND.floor);
    m.reserve(x, y);
  });
  const dist = (r: Room) => findPath(entry, { x: r.cx, y: r.cy }, { width: W, height: H, passable: (x, y) => m.walkableGround(x, y) })?.length ?? 0;
  const roomDist = rooms.map(dist);
  const maxD = Math.max(1, ...roomDist);
  let bossIdx = 0;
  roomDist.forEach((d, i) => { if (d > roomDist[bossIdx]!) bossIdx = i; });
  const boss = rooms[bossIdx]!;
  m.rect(boss.cx - 1, boss.cy - 1, boss.cx + 1, boss.cy + 1, (x, y) => { m.setO(x, y, 0); if (m.g(x, y) === GROUND.water) m.setG(x, y, GROUND.floor); });
  const packSpots: LayoutResult['packSpots'] = [];
  rooms.forEach((r, i) => {
    if (i === 0 || i === bossIdx) return;
    const p = { x: r.cx, y: r.cy };
    if (!m.walkableGround(p.x, p.y)) return;
    m.setO(p.x, p.y, 0);
    packSpots.push({ ...p, depth: roomDist[i]! / maxD, room: i });
  });
  const chestSpots: LayoutResult['chestSpots'] = [];
  rooms.forEach((r, i) => {
    if (i === 0) return;
    const corners = [[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]] as const;
    const [x, y] = rng.pick(corners);
    if (m.free(x, y) && (rng.chance(0.55) || i === bossIdx)) chestSpots.push({ x, y, depth: roomDist[i]! / maxD });
  });
  const trapSpots = rng.shuffle(corridorTiles.filter((t) => Math.hypot(t.x - entry.x, t.y - entry.y) > 6)).slice(0, 10);
  // Optional gate+lever puzzle guarding the boss room. Corridors are wide, so the gate is a line of gate tiles
  // across the corridor, and it only counts if it really cuts the boss room off (no loop around it).
  let gate: { gates: Vec2[]; lever: Vec2 } | undefined;
  if (rooms.length > 4 && rng.chance(0.6)) {
    const path = findPath(entry, { x: boss.cx, y: boss.cy }, { width: W, height: H, passable: (x, y) => m.walkableGround(x, y) }) ?? [];
    const inRoom = (r: Room, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const leverRoom = rooms.filter((_, i) => i !== bossIdx && i !== 0).sort((a, b) => dist(b) - dist(a))[0];
    for (let i = path.length - 1; i > 0 && !gate && leverRoom; i--) {
      const p = path[i]!, q = path[i - 1]!;
      if (m.g(p.x, p.y) !== GROUND.path || inRoom(boss, p.x, p.y)) continue;
      if (Math.hypot(p.x - boss.cx, p.y - boss.cy) > Math.max(boss.w, boss.h) + 6) continue;
      // Perpendicular to the direction of travel (corridors are axis-aligned).
      const along = { x: Math.sign(p.x - q.x), y: Math.sign(p.y - q.y) };
      if (along.x && along.y) continue;
      const perp = { x: along.y, y: along.x };
      const cut: Vec2[] = [p];
      for (const s of [1, -1])
        for (let k = 1; k <= 4; k++) {
          const t = { x: p.x + perp.x * k * s, y: p.y + perp.y * k * s };
          if (!m.walkableGround(t.x, t.y)) break;
          cut.push(t);
        }
      if (cut.length > 4 || cut.some((t) => m.g(t.x, t.y) !== GROUND.path)) continue;
      const blocked = new Set(cut.map((t) => t.y * W + t.x));
      const open = (x: number, y: number) => m.walkableGround(x, y) && !blocked.has(y * W + x);
      if (findPath(entry, { x: boss.cx, y: boss.cy }, { width: W, height: H, passable: open })) continue;
      const lp = m.randomFree(rng, (x, y) => inRoom(leverRoom, x, y));
      if (lp && findPath(entry, lp, { width: W, height: H, passable: open })) gate = { gates: cut, lever: lp };
    }
  }
  const decorSpots: Vec2[] = [];
  for (const r of rooms) decorSpots.push({ x: r.x + 1, y: r.y + 1 });
  m.pruneWalls();
  return { map: m, entry, edgeExits: {}, npcSpots: [], packSpots, chestSpots, trapSpots, decorSpots, buildings: [], internalExitSpots: [], bossSpot: { x: boss.cx, y: boss.cy }, rooms, gate };
}
