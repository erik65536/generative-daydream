/**
 * A place's plan while it is made: its top-down map laid over a grid of quarter-metre cells, each open (floor people
 * may stand on) or not, and where people can actually walk: a character's centre keeps CLEARANCE metres from
 * anything not open, and the walkable cells split into joined regions (the largest is the place).
 */

/** Plan cell size in metres. */
export const CELL = 0.25;
/** A character's centre keeps this far from anything not open (metres): one cell, so a passage a reader drew a little
 * narrow still opens (characters may clip slightly into things that look solid). */
export const CLEARANCE = 0.25;

export type Side = 'top' | 'bottom' | 'left' | 'right';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export interface Grid {
  cols: number;
  rows: number;
}

export interface Walk {
  /** Walkable cells (clearance included). */
  walk: Uint8Array;
  /** Region of each walkable cell (-1 none), each region's size in cells, and the largest one. */
  label: Int32Array;
  sizes: number[];
  main: number;
}

/** Where people can walk on an open mask: clearance (R cells), then 4-joined regions. The grid's edge counts as open (ways out). */
export function walkOf(open: Uint8Array, g: Grid, R = Math.ceil(CLEARANCE / CELL)): Walk {
  const { cols, rows } = g, n = cols * rows;
  const disc: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= R * R) disc.push([dr, dc]);
  const walk = new Uint8Array(n);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!open[r * cols + c]) continue;
      let ok = true;
      for (const [dr, dc] of disc) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        if (!open[rr * cols + cc]) {
          ok = false;
          break;
        }
      }
      if (ok) walk[r * cols + c] = 1;
    }
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!walk[i] || label[i]! >= 0) continue;
    const id = sizes.length, st = [i];
    label[i] = id;
    let size = 0;
    while (st.length) {
      const k = st.pop()!;
      size++;
      for (const j of neighbours(k, g)) if (walk[j] && label[j]! < 0) (label[j] = id), st.push(j);
    }
    sizes.push(size);
  }
  let main = -1;
  sizes.forEach((s, i) => (main < 0 || s > sizes[main]! ? (main = i) : 0));
  return { walk, label, sizes, main };
}

/** The 4 neighbours of a cell inside the grid. */
export function neighbours(i: number, g: Grid): number[] {
  const r = Math.floor(i / g.cols), c = i % g.cols, out: number[] = [];
  if (c > 0) out.push(i - 1);
  if (c < g.cols - 1) out.push(i + 1);
  if (r > 0) out.push(i - g.cols);
  if (r < g.rows - 1) out.push(i + g.cols);
  return out;
}

/** The side a border cell lies on (corners count for the top and bottom). */
export function sideOf(i: number, g: Grid): Side {
  const r = Math.floor(i / g.cols), c = i % g.cols;
  return r === 0 ? 'top' : r === g.rows - 1 ? 'bottom' : c === 0 ? 'left' : 'right';
}

/** Connected pieces of the cells where `on` holds (4-joined). */
export function components(g: Grid, on: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(g.cols * g.rows), out: number[][] = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !on(i)) continue;
    const comp = [i], st = [i];
    seen[i] = 1;
    while (st.length) {
      const k = st.pop()!;
      for (const j of neighbours(k, g)) if (!seen[j] && on(j)) (seen[j] = 1), st.push(j), comp.push(j);
    }
    out.push(comp);
  }
  return out;
}

/** A per-cell mask from a picture-sized one (a cell is set when most of its pixels are). */
export function cellsOf(px: Uint8Array, W: number, H: number, g: Grid): Uint8Array {
  const out = new Uint8Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const x0 = Math.floor((c * W) / g.cols), x1 = Math.max(x0 + 1, Math.floor(((c + 1) * W) / g.cols));
      const y0 = Math.floor((r * H) / g.rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * H) / g.rows));
      let n = 0, f = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) (n++, px[y * W + x] && f++);
      if (2 * f > n) out[r * g.cols + c] = 1;
    }
  return out;
}

/** Cheapest route over the grid from cells where `from` holds to cells where `to` holds: open cells cost little. */
export function route(g: Grid, open: Uint8Array, from: (i: number) => boolean, to: (i: number) => boolean): number[] {
  const n = g.cols * g.rows, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (e: [number, number]) => {
    heap.push(e);
    for (let k = heap.length - 1; k > 0; ) {
      const p = (k - 1) >> 1;
      if (heap[p]![0] <= heap[k]![0]) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (from(i)) (dist[i] = 0), push([0, i]);
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]!) continue;
    if (to(i)) {
      const path: number[] = [];
      for (let k = i; k >= 0 && path.length <= n; k = prev[k]!) path.push(k);
      return path.reverse();
    }
    for (const j of neighbours(i, g)) {
      const nd = d + (open[j] ? 0.05 : 1);
      if (nd < dist[j]!) (dist[j] = nd), (prev[j] = i), push([nd, j]);
    }
  }
  return [];
}
