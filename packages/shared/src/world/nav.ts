/**
 * Where people can walk and see in a painted place. Game positions are metres on the ground; the painting is a
 * top-down map of that ground (x across, y down the picture). The reader turns the painting into two bit grids of
 * half-metre cells: walkable (where a character's centre may stand, clearance already included) and see-through.
 */
import { BitSet } from '../util/encode';
import { findPath, hasLineOfSight, reachable, type PathOptions, type Vec2 } from '../util/grid';

/**
 * Picture pixels per metre: the one scale of the game. Ground runs this many pixels per metre both ways (the places
 * are top-down maps), and figures stand this many pixels per metre tall (a 1.75 m person is 82 px).
 */
export const PX_PER_METRE = 82 / 1.75;
/** Navigation cell size in metres. */
export const NAV_CELL = 0.5;

/** Ground metres to picture pixels, given the picture position of the ground origin. */
export function groundToPicture(x: number, y: number, ox: number, oy: number): Vec2 {
  return { x: x * PX_PER_METRE + ox, y: y * PX_PER_METRE + oy };
}

/** Picture pixels to ground metres. */
export function pictureToGround(px: number, py: number, ox: number, oy: number): Vec2 {
  return { x: (px - ox) / PX_PER_METRE, y: (py - oy) / PX_PER_METRE };
}

export interface NavDef {
  cols: number;
  rows: number;
  /** Base64 bitsets of cols*rows cells: walkable, and see-through. */
  walk: string;
  sight: string;
}

export interface NavPathOptions {
  /** Extra cost (metres) for entering a cell, e.g. a known trap or an ally to squeeze past. */
  extraCost?: (cx: number, cy: number) => number;
  /** Cells that are blocked for this walk only (other people in combat). */
  blocked?: (cx: number, cy: number) => boolean;
  /** Stop once within this many metres of the goal. */
  stopWithin?: number;
  /** Plan to the goal even when it can't be stood on (walking up to someone). */
  allowBlockedGoal?: boolean;
  maxNodes?: number;
}

export class Nav {
  readonly cols: number;
  readonly rows: number;
  private walk: BitSet;
  private sight: BitSet;

  constructor(def: NavDef) {
    this.cols = def.cols;
    this.rows = def.rows;
    this.walk = new BitSet(def.cols * def.rows, def.walk);
    this.sight = new BitSet(def.cols * def.rows, def.sight);
  }

  /** Ground size in metres. */
  get width() {
    return this.cols * NAV_CELL;
  }
  get height() {
    return this.rows * NAV_CELL;
  }

  cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x / NAV_CELL), Math.floor(y / NAV_CELL)];
  }

  centre(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * NAV_CELL, y: (cy + 0.5) * NAV_CELL };
  }

  inside(cx: number, cy: number) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  walkableCell(cx: number, cy: number) {
    return this.inside(cx, cy) && this.walk.get(cy * this.cols + cx);
  }

  seeThroughCell(cx: number, cy: number) {
    return this.inside(cx, cy) && this.sight.get(cy * this.cols + cx);
  }

  walkable(x: number, y: number) {
    const [cx, cy] = this.cellOf(x, y);
    return this.walkableCell(cx, cy);
  }

  /** Whether one can see from a to b (metres). */
  sees(a: Vec2, b: Vec2): boolean {
    const [ax, ay] = this.cellOf(a.x, a.y), [bx, by] = this.cellOf(b.x, b.y);
    return hasLineOfSight({ x: ax, y: ay }, { x: bx, y: by }, (x, y) => !this.seeThroughCell(x, y));
  }

  /** The straight walk a→b stays on walkable ground (checked every quarter metre). */
  clear(a: Vec2, b: Vec2, ok: (cx: number, cy: number) => boolean = (cx, cy) => this.walkableCell(cx, cy)): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (NAV_CELL / 2)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const [cx, cy] = this.cellOf(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      if (!ok(cx, cy)) return false;
    }
    return true;
  }

  private gridOptions(o: NavPathOptions): PathOptions {
    const blocked = o.blocked;
    return {
      width: this.cols,
      height: this.rows,
      passable: blocked ? (x, y) => this.walkableCell(x, y) && !blocked(x, y) : (x, y) => this.walkableCell(x, y),
      extraCost: o.extraCost ? (x, y) => o.extraCost!(x, y) / NAV_CELL : undefined,
      maxNodes: o.maxNodes ?? 30000,
      stopWithin: o.stopWithin !== undefined ? o.stopWithin / NAV_CELL : undefined,
      allowBlockedGoal: o.allowBlockedGoal,
    };
  }

  /**
   * A walk from a to b in metres: an any-angle path (waypoints after the start), ending at b itself when b can be
   * stood on. Null when there is no way.
   */
  path(from: Vec2, to: Vec2, o: NavPathOptions = {}): Vec2[] | null {
    const g = this.gridOptions(o);
    const [sx, sy] = this.cellOf(from.x, from.y), [gx, gy] = this.cellOf(to.x, to.y);
    const cells = findPath({ x: sx, y: sy }, { x: gx, y: gy }, g);
    if (!cells) return null;
    const ok = (cx: number, cy: number) => g.passable(cx, cy);
    const pts = cells.map((c) => this.centre(c.x, c.y));
    const ends = pts.length && cells[cells.length - 1]!.x === gx && cells[cells.length - 1]!.y === gy && ok(gx, gy);
    if (ends) pts[pts.length - 1] = { x: to.x, y: to.y };
    // Any-angle: skip waypoints while the straight walk stays clear.
    const out: Vec2[] = [];
    let cur = from;
    for (let i = 0; i < pts.length; ) {
      let j = pts.length - 1;
      while (j > i && !this.clear(cur, pts[j]!, ok)) j--;
      out.push(pts[j]!);
      cur = pts[j]!;
      i = j + 1;
    }
    return out;
  }

  /** Metres along a walk. */
  static length(from: Vec2, path: Vec2[]): number {
    let len = 0, p = from;
    for (const q of path) {
      len += Math.hypot(q.x - p.x, q.y - p.y);
      p = q;
    }
    return len;
  }

  /** Walking cost in metres to every cell reachable within `budget` metres (cell index → cost). */
  reach(from: Vec2, budget: number, o: NavPathOptions = {}): Map<number, number> {
    const [sx, sy] = this.cellOf(from.x, from.y);
    const costs = reachable({ x: sx, y: sy }, budget / NAV_CELL, this.gridOptions(o));
    for (const [k, c] of costs) costs.set(k, c * NAV_CELL);
    return costs;
  }

  /** The nearest walkable point to p (searching outwards up to `maxR` metres), or null. */
  nearestWalkable(p: Vec2, maxR = 6, ok: (cx: number, cy: number) => boolean = (cx, cy) => this.walkableCell(cx, cy)): Vec2 | null {
    const [px, py] = this.cellOf(p.x, p.y);
    if (ok(px, py)) return p;
    const R = Math.ceil(maxR / NAV_CELL);
    for (let r = 1; r <= R; r++) {
      let best: Vec2 | null = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !ok(px + dx, py + dy)) continue;
          const c = this.centre(px + dx, py + dy);
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < bd) (bd = d), (best = c);
        }
      if (best) return best;
    }
    return null;
  }

  /** Indices of walkable cells within r metres of p. */
  cellsWithin(p: Vec2, r: number, walkableOnly = true): number[] {
    const out: number[] = [];
    const [px, py] = this.cellOf(p.x, p.y);
    const R = Math.ceil(r / NAV_CELL);
    for (let cy = Math.max(0, py - R); cy <= Math.min(this.rows - 1, py + R); cy++)
      for (let cx = Math.max(0, px - R); cx <= Math.min(this.cols - 1, px + R); cx++) {
        const c = this.centre(cx, cy);
        if (Math.hypot(c.x - p.x, c.y - p.y) > r) continue;
        if (walkableOnly && !this.walkableCell(cx, cy)) continue;
        out.push(cy * this.cols + cx);
      }
    return out;
  }
}

/** A navigation grid from tests at each cell's centre (arenas and tests). */
export function makeNav(width: number, height: number, walk: (x: number, y: number) => boolean, sight: (x: number, y: number) => boolean = walk): NavDef {
  const cols = Math.ceil(width / NAV_CELL), rows = Math.ceil(height / NAV_CELL);
  const w = new BitSet(cols * rows), s = new BitSet(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL, y = (cy + 0.5) * NAV_CELL;
      if (walk(x, y)) w.set(cy * cols + cx);
      if (sight(x, y)) s.set(cy * cols + cx);
    }
  return { cols, rows, walk: w.encode(), sight: s.encode() };
}

/** Explored ground is remembered per square metre: a bitset of fog.w × fog.h. */
export const fogSize = (z: { width: number; height: number }) => ({ w: Math.ceil(z.width), h: Math.ceil(z.height) });
