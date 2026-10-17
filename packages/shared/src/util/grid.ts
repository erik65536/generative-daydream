/** Grid geometry helpers: distance, pathfinding, line of sight. Tile coordinates are integers. */

export interface Vec2 {
  x: number;
  y: number;
}

/** Diagonal-aware distance (octile) used for movement costs and ranges. */
export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface PathOptions {
  width: number;
  height: number;
  /** Return true when the tile can be stood on. */
  passable: (x: number, y: number) => boolean;
  /** Extra cost for entering a tile (e.g. known traps, hazardous surfaces). */
  extraCost?: (x: number, y: number) => number;
  maxNodes?: number;
  /** Stop as soon as a tile within this (euclidean) distance of the goal is reached. */
  stopWithin?: number;
  /** Allow the goal tile itself to be impassable (e.g. path next to an NPC standing there). */
  allowBlockedGoal?: boolean;
}

class MinHeap {
  private items: { k: number; v: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(v: number, k: number) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!.v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** A* over an 8-connected grid without diagonal corner cutting. Returns tiles excluding start. */
export function findPath(start: Vec2, goal: Vec2, opts: PathOptions): Vec2[] | null {
  const { width, height, passable } = opts;
  const sx = Math.round(start.x), sy = Math.round(start.y);
  const gx = Math.round(goal.x), gy = Math.round(goal.y);
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return null;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const stopWithin = opts.stopWithin ?? 0;
  const goalBlocked = !passable(gx, gy);
  if (goalBlocked && !opts.allowBlockedGoal && stopWithin <= 0) return null;
  const idx = (x: number, y: number) => y * width + x;
  const n = width * height;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const si = idx(sx, sy);
  g[si] = 0;
  heap.push(si, octile(sx, sy, gx, gy));
  const maxNodes = opts.maxNodes ?? 20000;
  let expanded = 0;
  let endIndex = -1;
  const within = (x: number, y: number) => stopWithin > 0 && Math.hypot(x - gx, y - gy) <= stopWithin + 1e-6;
  while (heap.size) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % width, cy = (cur / width) | 0;
    if ((cx === gx && cy === gy) || within(cx, cy)) {
      endIndex = cur;
      break;
    }
    if (++expanded > maxNodes) break;
    for (const [dx, dy, c] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const isGoal = nx === gx && ny === gy;
      if (!passable(nx, ny) && !(isGoal && opts.allowBlockedGoal)) continue;
      if (dx !== 0 && dy !== 0 && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const ng = g[cur]! + c + (opts.extraCost ? opts.extraCost(nx, ny) : 0);
      if (ng < g[ni]!) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + octile(nx, ny, gx, gy));
      }
    }
  }
  if (endIndex < 0) return null;
  const path: Vec2[] = [];
  let c = endIndex;
  while (c !== si && c >= 0) {
    path.push({ x: c % width, y: (c / width) | 0 });
    c = came[c]!;
  }
  path.reverse();
  if (goalBlocked && path.length) {
    const last = path[path.length - 1]!;
    if (last.x === gx && last.y === gy) path.pop();
  }
  return path;
}

/** Path length in tiles. */
export function pathLength(start: Vec2, path: Vec2[]): number {
  let len = 0;
  let px = start.x, py = start.y;
  for (const p of path) {
    len += Math.hypot(p.x - px, p.y - py);
    px = p.x;
    py = p.y;
  }
  return len;
}

/** Bresenham line of sight. `blocksSight` should be true for walls and tall obstacles. */
export function hasLineOfSight(a: Vec2, b: Vec2, blocksSight: (x: number, y: number) => boolean): boolean {
  const ax = Math.round(a.x), ay = Math.round(a.y);
  let x0 = ax, y0 = ay;
  const x1 = Math.round(b.x), y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 === x1 && y0 === y1) return true;
    if (!(x0 === ax && y0 === ay) && blocksSight(x0, y0)) return false;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** All tiles within a radius (euclidean) of a center. */
export function tilesInRadius(cx: number, cy: number, r: number, width: number, height: number): Vec2[] {
  const out: Vec2[] = [];
  const ri = Math.ceil(r);
  const fx = Math.round(cx), fy = Math.round(cy);
  for (let y = Math.max(0, fy - ri); y <= Math.min(height - 1, fy + ri); y++)
    for (let x = Math.max(0, fx - ri); x <= Math.min(width - 1, fx + ri); x++)
      if (Math.hypot(x - cx, y - cy) <= r + 0.01) out.push({ x, y });
  return out;
}

/** Dijkstra flood from a start, returning tile index -> cost for every tile reachable within maxCost. */
export function reachable(start: Vec2, maxCost: number, opts: PathOptions): Map<number, number> {
  const { width, height, passable } = opts;
  const out = new Map<number, number>();
  const heap = new MinHeap();
  const si = Math.round(start.y) * width + Math.round(start.x);
  out.set(si, 0);
  heap.push(si, 0);
  const done = new Set<number>();
  while (heap.size) {
    const cur = heap.pop()!;
    if (done.has(cur)) continue;
    done.add(cur);
    const cg = out.get(cur)!;
    const cx = cur % width, cy = (cur / width) | 0;
    for (const [dx, dy, c] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!passable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const ng = cg + c + (opts.extraCost ? opts.extraCost(nx, ny) : 0);
      if (ng > maxCost + 1e-6) continue;
      const ni = ny * width + nx;
      if (ng < (out.get(ni) ?? Infinity)) {
        out.set(ni, ng);
        heap.push(ni, ng);
      }
    }
  }
  return out;
}
