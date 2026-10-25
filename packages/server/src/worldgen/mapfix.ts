/**
 * Making a read map usable without repainting it (see docs/places.md). The character may clip a little through
 * things that look solid, if that gives a map it can use.
 *
 * 1. Clean: blocked specks under 0.5 m² inside open ground open (reader noise, tiny props); open specks under 1 m²
 *    close.
 * 2. The barrier band round the edge is blocked, except the gaps at the ways out.
 * 3. Check: every region cut off at the reader's clearance (two cells) of at least MIN_REGION m² is shown to `keep`
 *    (Luna: is this ground the player should reach?); a rejected one is blocked with its margin, so the smaller
 *    clearance below cannot join a roof or a cliff top through a narrow neck.
 * 4. Widen: the character's centre keeps CLEARANCE (one cell) from blocked cells. Thin walls stay walls (blocked cells
 *    are never walkable), but passages a reader drew a little narrow open up.
 * 5. Connect: every other region of at least MIN_REGION m² joins the main one along the cheapest route (walkable cells
 *    cost little, open but narrow ones more, blocked ones most), carved open CARVE either side, when it punches through
 *    at most MAX_PUNCH of blocked ground; every way out joins too, however far.
 */
import { CELL, components, neighbours, walkOf, type Grid, type Side } from './mapgrid';

const MIN_REGION = 4, MAX_PUNCH = 3, CARVE = 0.45, SPECK = 0.5, ISLAND = 1;

/** A way out: the side of the map, where along it (0 to 1), and its gap through the barrier band (m). */
export interface Gap {
  side: Side;
  at: number;
}

export interface Fixed {
  /** Open ground after the fixes, and where the character can walk (the main region, clearance kept). */
  open: Uint8Array;
  walk: Uint8Array;
  /** Cells carved open; regions joined and left out; ways out that needed a route. */
  carved: Uint8Array;
  joined: number;
  left: number;
  exits: number;
}

function disc(R: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= R * R + 0.5) out.push([dr, dc]);
  return out;
}

/** Cheapest route from the `from` cells to a cell where `to` holds (cost per cell entered). */
function cheapest(g: Grid, cost: (i: number) => number, from: number[], to: (i: number) => boolean): number[] {
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
  for (const i of from) (dist[i] = 0), push([0, i]);
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]!) continue;
    if (to(i)) {
      const path: number[] = [];
      for (let k = i; k >= 0; k = prev[k]!) path.push(k);
      return path.reverse();
    }
    for (const j of neighbours(i, g)) {
      const nd = d + cost(j);
      if (nd < dist[j]!) (dist[j] = nd), (prev[j] = i), push([nd, j]);
    }
  }
  return [];
}

/** The cells of each way out's gap through the barrier band (`band`, `gap` in cells). */
export function gapCells(g: Grid, gaps: Gap[], band: number, gap: number): number[][] {
  return gaps.map((e) => {
    const out: number[] = [];
    const a = e.at * (e.side === 'top' || e.side === 'bottom' ? g.cols : g.rows), half = gap / 2;
    for (let r = 0; r < g.rows; r++)
      for (let c = 0; c < g.cols; c++) {
        const inGap = e.side === 'top' ? r < band && Math.abs(c - a) < half : e.side === 'bottom' ? r >= g.rows - band && Math.abs(c - a) < half
          : e.side === 'left' ? c < band && Math.abs(r - a) < half : c >= g.cols - band && Math.abs(r - a) < half;
        if (inGap) out.push(r * g.cols + c);
      }
    return out;
  });
}

/** Make a read map usable (see the file comment). `band` and `gap` are in cells. */
export async function fixMap(read: Uint8Array, g: Grid, gaps: Gap[], band: number, gap: number, keep?: (region: number[]) => Promise<boolean>): Promise<Fixed> {
  const open = Uint8Array.from(read), n = open.length;
  const border = (i: number) => { const r = Math.floor(i / g.cols), c = i % g.cols; return r === 0 || c === 0 || r === g.rows - 1 || c === g.cols - 1; };
  for (const p of components(g, (i) => !open[i])) if (!p.some(border) && p.length * CELL * CELL < SPECK) for (const i of p) open[i] = 1;
  for (const p of components(g, (i) => !!open[i])) if (p.length * CELL * CELL < ISLAND) for (const i of p) open[i] = 0;
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (Math.min(r, c, g.rows - 1 - r, g.cols - 1 - c) < band) open[r * g.cols + c] = 0;
  const gapsAt = gapCells(g, gaps, band, gap);
  for (const cells of gapsAt) for (const i of cells) open[i] = 1;

  const minCells = MIN_REGION / (CELL * CELL);
  /** Cells of regions already accepted (no second look) or already tried. */
  const accepted = new Uint8Array(n), tried = new Uint8Array(n);
  let left = 0;
  if (keep) {
    const w0 = walkOf(open, g, 2);
    const drop = new Uint8Array(n), main0 = new Uint8Array(n);
    w0.label.forEach((l, i) => { if (l === w0.main) main0[i] = 1; });
    const regions = new Map<number, number[]>();
    w0.label.forEach((l, i) => {
      if (l < 0 || l === w0.main) return;
      if (!regions.has(l)) regions.set(l, []);
      regions.get(l)!.push(i);
    });
    for (const reg of regions.values()) {
      if (reg.length < minCells) continue;
      if (await keep(reg)) { for (const i of reg) accepted[i] = 1; continue; }
      left++;
      for (const i of reg) drop[i] = 1;
    }
    // A rejected region takes its margin of open cells with it (never the main region's).
    for (let pass = 0; pass < 3; pass++) {
      const add: number[] = [];
      for (let i = 0; i < n; i++) if (!drop[i] && open[i] && !main0[i] && neighbours(i, g).some((j) => drop[j])) add.push(i);
      for (const i of add) drop[i] = 1;
    }
    for (let i = 0; i < n; i++) if (drop[i]) open[i] = 0;
  }

  const carved = new Uint8Array(n), cd = disc(Math.round(CARVE / CELL));
  const carve = (path: number[]) => {
    for (const i of path) {
      const r = Math.floor(i / g.cols), c = i % g.cols;
      for (const [dr, dc] of cd) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
        const k = rr * g.cols + cc;
        if (!open[k]) (open[k] = 1), (carved[k] = 1);
      }
    }
  };
  let w = walkOf(open, g);
  const cost = (i: number) => (w.walk[i] ? 0.02 : open[i] ? 0.2 : 1);
  let joined = 0, exits = 0;
  for (;;) {
    const sizes = w.sizes.map((s, l) => ({ s, l })).filter(({ s, l }) => l !== w.main && s >= minCells);
    const cells = (l: number) => { const out: number[] = []; w.label.forEach((x, i) => { if (x === l) out.push(i); }); return out; };
    const next = sizes.map(({ l }) => cells(l)).find((reg) => !reg.some((i) => tried[i]));
    if (!next) break;
    for (const i of next) tried[i] = 1;
    if (keep && !next.some((i) => accepted[i]) && !(await keep(next))) { left++; continue; }
    const path = cheapest(g, cost, next, (i) => w.label[i] === w.main);
    if (!path.length || path.filter((i) => !open[i]).length * CELL > MAX_PUNCH) { left++; continue; }
    carve(path);
    joined++;
    w = walkOf(open, g);
  }
  for (const cells of gapsAt) {
    if (!cells.length || cells.some((i) => w.label[i] === w.main)) continue;
    const path = cheapest(g, cost, cells, (i) => w.label[i] === w.main);
    if (path.length) (carve(path), exits++, (w = walkOf(open, g)));
  }
  return { open, walk: Uint8Array.from(w.label, (l) => (l === w.main ? 1 : 0)), carved, joined, left, exits };
}
