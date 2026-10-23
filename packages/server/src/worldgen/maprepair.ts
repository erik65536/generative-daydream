/**
 * Checking a read map against what the place needs, and repairing it in place (see docs/places.md):
 * - Openings: runs of open floor along the map's edge (open floor, not the clearance-trimmed walk: that hid painted
 *   paths running off the edge). On each side that wants a way out, the opening of the main region nearest where the
 *   frame guide put the gap is kept; a missing one gets a route from the main region to that spot, painted as a way
 *   out. Other openings are blocked in the plan only (the final plan blocks the whole edge except at the ways out);
 *   painting them shut too is possible (PAINT_CLOSURES) but slow, so a painted path may seem to lead out where the
 *   game lets nobody walk.
 * - Cut-off regions of 4 m² or more (or 1% of the walkable ground) are joined to the main region along the cheapest
 *   route, painted as a passage.
 * Each repair is painted by Krea 2 AnyPaint in a window around it (the window is its reference, so the patch matches)
 * and checked there alone by Qwen's walk plan (one retry with another seed). The plan follows each repair by
 * construction (a passage is open, a closure blocked): reading the whole map again would bring back the readers'
 * noise and never settle. A round that makes the check worse is undone.
 */
import sharp from 'sharp';
import { kreaContinue } from './comfy';
import { gapsAlong } from './mapdraw';
import { CELL, route, sideOf, walkOf, type Grid, type Side, type Walk } from './mapgrid';
import { walkPlan, type Spot } from './mapread';

/**
 * Paint unwanted openings shut (those PAINT_CLOSE m or wider) with the place's barrier. Off: a wild place's edge can
 * have twenty openings at about a minute each, and the plan blocks them anyway.
 */
const PAINT_CLOSURES = false;
const PAINT_CLOSE = 1.5;
/** Regions at least this big (m²), or this share of the walkable ground, are joined to the main one. */
const JOIN_MIN = 4;
const JOIN_SHARE = 0.01;

interface Opening {
  cells: number[];
  side: Side;
  width: number;
  /** Middle cell. */
  mid: number;
  /** Belongs to the main region (its walkable ground reaches within 2 m of it). */
  main: boolean;
}

interface Repair {
  kind: 'close' | 'join' | 'exit';
  cells: number[];
  radius: number;
  note: string;
}

export interface MapCheck {
  walk: Walk;
  openings: Opening[];
  keep: Opening[];
  missing: Side[];
  repairs: Repair[];
  /** Main region (m²) and all walkable ground (m²). */
  main: number;
  walkable: number;
  /** Lower is better: what is still wrong. */
  score: number;
}

/** Where the frame guide put the gaps of each side (a cell on that side). */
function gapCells(sides: Side[], g: Grid): { side: Side; cell: number }[] {
  const out: { side: Side; cell: number }[] = [];
  for (const s of new Set(sides)) {
    for (const f of gapsAlong(sides.filter((x) => x === s).length)) {
      const c = Math.round(f * (g.cols - 1)), r = Math.round(f * (g.rows - 1));
      out.push({ side: s, cell: s === 'top' ? c : s === 'bottom' ? (g.rows - 1) * g.cols + c : s === 'left' ? r * g.cols : r * g.cols + g.cols - 1 });
    }
  }
  return out;
}

const dist = (a: number, b: number, g: Grid) => Math.hypot((a % g.cols) - (b % g.cols), Math.floor(a / g.cols) - Math.floor(b / g.cols));

/** Check a plan: its openings, which to keep and close, cut-off regions and missing ways out. */
export function checkMap(open: Uint8Array, g: Grid, sides: Side[]): MapCheck {
  const walk = walkOf(open, g);
  const m2 = CELL * CELL;
  const total = walk.sizes.reduce((a, b) => a + b, 0) * m2;
  // Border cells in order round the map, and runs of open ones.
  const border: number[] = [];
  for (let c = 0; c < g.cols; c++) border.push(c);
  for (let r = 1; r < g.rows; r++) border.push(r * g.cols + g.cols - 1);
  for (let c = g.cols - 2; c >= 0; c--) border.push((g.rows - 1) * g.cols + c);
  for (let r = g.rows - 2; r > 0; r--) border.push(r * g.cols);
  // Start the walk round at a closed cell (an edge open all round counts as one opening per side).
  let start = border.findIndex((i) => !open[i]);
  const openings: Opening[] = [];
  if (start < 0) {
    const corners = [0, g.cols - 1, g.cols - 1 + g.rows - 1, 2 * (g.cols - 1) + g.rows - 1];
    for (const c of corners) open = Uint8Array.from(open, (v, i) => (i === border[c] ? 0 : v));
    start = corners[0]!;
  }
  {
    let run: number[] = [];
    const flush = () => {
      if (run.length * CELL >= 0.75) {
        const mid = run[Math.floor(run.length / 2)]!;
        // Main if the main region's walkable ground comes within 2 m of the opening.
        const R = Math.round(2 / CELL);
        let main = false;
        for (const k of run) {
          const r0 = Math.floor(k / g.cols), c0 = k % g.cols;
          for (let dr = -R; dr <= R && !main; dr++)
            for (let dc = -R; dc <= R && !main; dc++) {
              const rr = r0 + dr, cc = c0 + dc;
              if (rr >= 0 && cc >= 0 && rr < g.rows && cc < g.cols && walk.main >= 0 && walk.label[rr * g.cols + cc] === walk.main) main = true;
            }
          if (main) break;
        }
        openings.push({ cells: run, side: sideOf(mid, g), width: run.length * CELL, mid, main });
      }
      run = [];
    };
    for (let k = 1; k <= border.length; k++) {
      const i = border[(start + k) % border.length]!;
      if (open[i]) run.push(i);
      else flush();
    }
    flush();
  }
  // Keep, for each wanted gap, the main region's opening on that side nearest it.
  const keep: Opening[] = [];
  const missing: Side[] = [];
  for (const gap of gapCells(sides, g)) {
    const o = openings.filter((q) => q.side === gap.side && q.main && !keep.includes(q)).sort((a, b) => dist(a.mid, gap.cell, g) - dist(b.mid, gap.cell, g))[0];
    if (o) keep.push(o);
    else missing.push(gap.side);
  }
  const repairs: Repair[] = [];
  for (const o of openings) {
    if (!PAINT_CLOSURES || keep.includes(o) || o.width < PAINT_CLOSE) continue;
    const cells: number[] = [];
    for (const i of o.cells)
      for (let k = 0; k < Math.round(1.5 / CELL); k++) {
        const r = Math.floor(i / g.cols), c = i % g.cols;
        cells.push(o.side === 'top' ? (r + k) * g.cols + c : o.side === 'bottom' ? (r - k) * g.cols + c : o.side === 'left' ? r * g.cols + c + k : r * g.cols + c - k);
      }
    repairs.push({ kind: 'close', cells, radius: 0.6, note: `close the ${o.width.toFixed(1)} m opening on the ${o.side} edge` });
  }
  const joinMin = Math.max(JOIN_MIN, JOIN_SHARE * total);
  walk.sizes.forEach((n, region) => {
    if (region === walk.main || n * m2 < joinMin) return;
    const path = walk.main >= 0 ? route(g, open, (i) => walk.label[i] === region, (i) => walk.label[i] === walk.main) : [];
    if (path.length) repairs.push({ kind: 'join', cells: path, radius: 1, note: `join the ${(n * m2).toFixed(0)} m² region (${(path.length * CELL).toFixed(1)} m route)` });
  });
  const gaps = gapCells(sides, g);
  missing.forEach((side, k) => {
    const gap = gaps.filter((x) => x.side === side)[k] ?? gaps.find((x) => x.side === side)!;
    const near = (i: number) => sideOf(i, g) === side && (i < g.cols || i >= (g.rows - 1) * g.cols || i % g.cols === 0 || i % g.cols === g.cols - 1) && dist(i, gap.cell, g) <= Math.max(g.cols, g.rows) * 0.15;
    const path = walk.main >= 0 ? route(g, open, (i) => walk.label[i] === walk.main, near) : [];
    if (path.length) repairs.push({ kind: 'exit', cells: path, radius: 1.4, note: `add a way out on the ${side} edge (${(path.length * CELL).toFixed(1)} m route)` });
  });
  const main = walk.main >= 0 ? walk.sizes[walk.main]! * m2 : 0;
  return { walk, openings, keep, missing, repairs, main, walkable: total, score: missing.length * 10 + repairs.length };
}

export interface RepairContext {
  g: Grid;
  sides: Side[];
  style: string;
  floor: string;
  barrier: string;
  indoor: boolean;
  seed: number;
  /** Least main region (m²) a map must have to pass. */
  minArea: number;
  report: (msg: string) => void;
  /** Saved steps: the map and plan after each round (a resumed build continues from the last). */
  saved?: (round: number) => { png: Buffer; open: Uint8Array } | undefined;
  save?: (round: number, png: Buffer, open: Uint8Array) => void;
}

export interface Repaired {
  png: Buffer;
  open: Uint8Array;
  walk: Walk;
  /** Ways out at the edge (picture px), with their side. */
  exits: Spot[];
  passed: boolean;
  rounds: number;
}

/** Paint one repair in a window around it; returns the new picture and how well the window now agrees with the plan. */
async function paintRepair(png: Buffer, rp: Repair, ctx: RepairContext, k: number): Promise<{ png: Buffer; agree: number; mask: Uint8Array }> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const { g } = ctx, kx = W / g.cols, ky = H / g.rows;
  const mask = new Uint8Array(W * H);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  const R = (rp.radius / CELL) * kx;
  for (const i of rp.cells) {
    const cx = ((i % g.cols) + 0.5) * kx, cy = (Math.floor(i / g.cols) + 0.5) * ky;
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(H, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(W, Math.ceil(cx + R)); x++)
        if (Math.hypot(x - cx, y - cy) <= R) {
          mask[y * W + x] = 1;
          (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
        }
  }
  const ww = Math.min(W, Math.max(512, x1 - x0 + 160)), wh = Math.min(H, Math.max(512, y1 - y0 + 160));
  const left = Math.max(0, Math.min(W - ww, Math.round((x0 + x1) / 2 - ww / 2))), top = Math.max(0, Math.min(H - wh, Math.round((y0 + y1) / 2 - wh / 2)));
  const win = await sharp(png).extract({ left, top, width: ww, height: wh }).png().toBuffer();
  const mk = Buffer.alloc(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) mk[y * ww + x] = mask[(top + y) * W + left + x] ? 255 : 0;
  const mkPng = await sharp(mk, { raw: { width: ww, height: wh, channels: 1 } }).png().toBuffer();
  const lead = `A flat 2D top-down map seen from straight above, ${ctx.style}`;
  const prompt = rp.kind === 'exit'
    ? `${lead} A clear way out of the place here: a wide open passage of ${ctx.floor} running to the edge of the map${ctx.indoor ? ', through an opening or a wide door in the outer wall' : ''}, matching the floor around it, so it plainly leads out.`
    : rp.kind === 'close'
      ? `${lead} The edge of the place is closed off here by ${ctx.barrier}, solid and continuous, matching the barrier around it, with nothing to walk through.`
      : `${lead} A clear walkable passage of ${ctx.floor} joins the two areas here: an open path${ctx.indoor ? ' or doorway through the wall' : ', steps or a small bridge where needed'}, matching the floor around it.`;
  let out: Buffer | undefined, agree = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const painted = await sharp(await kreaContinue(win, mkPng, prompt, ctx.seed + 31 + k + attempt * 100, 24)).resize(ww, wh, { fit: 'fill' }).removeAlpha().png().toBuffer();
    const plan = await walkPlan(painted);
    let n = 0, f = 0;
    for (let i = 0; i < mk.length; i++) if (mk[i]) (n++, plan[i] && f++);
    const a = rp.kind === 'close' ? 1 - f / Math.max(1, n) : f / Math.max(1, n);
    if (!out || a > agree) (out = painted), (agree = a);
    if (agree >= 0.5) break;
  }
  // Paste back only the mask (blurred 2 px): the rest of the map stays exactly as it was.
  const raw = await sharp(out!).raw().toBuffer();
  const soft = await sharp(mk, { raw: { width: ww, height: wh, channels: 1 } }).blur(2).extractChannel(0).raw().toBuffer();
  const base = await sharp(png).removeAlpha().raw().toBuffer();
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const a = soft[y * ww + x]! / 255;
      if (!a) continue;
      const q = ((top + y) * W + left + x) * 3;
      for (let ch = 0; ch < 3; ch++) base[q + ch] = Math.round(base[q + ch]! * (1 - a) + raw[(y * ww + x) * 3 + ch]! * a);
    }
  return { png: await sharp(base, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), agree, mask };
}

/** The plan after a repair, by construction: a passage or way out is open, a closure blocked. */
function applyToPlan(open: Uint8Array, rp: Repair, g: Grid): Uint8Array {
  const out = Uint8Array.from(open), R = rp.radius / CELL;
  for (const i of rp.cells) {
    const r0 = Math.floor(i / g.cols), c0 = i % g.cols;
    for (let dr = -Math.ceil(R); dr <= Math.ceil(R); dr++)
      for (let dc = -Math.ceil(R); dc <= Math.ceil(R); dc++) {
        const rr = r0 + dr, cc = c0 + dc;
        if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols || Math.hypot(dr, dc) > R) continue;
        out[rr * g.cols + cc] = rp.kind === 'close' ? 0 : 1;
      }
  }
  return out;
}

/** Check and repair up to `rounds` times; always returns the best map with its ways out (see the file comment). */
export async function repairMap(png0: Buffer, open0: Uint8Array, ctx: RepairContext, rounds = 4): Promise<Repaired> {
  const { g } = ctx;
  let png = png0, open = open0;
  let check = checkMap(open, g, ctx.sides);
  let round = 0;
  for (; round < rounds; round++) {
    if (!check.repairs.length) break;
    const saved = ctx.saved?.(round + 1);
    let nextPng = png, nextOpen = open;
    if (saved) ({ png: nextPng, open: nextOpen } = saved);
    else {
      for (const [k, rp] of check.repairs.entries()) {
        const r = await paintRepair(nextPng, rp, ctx, round * 50 + k);
        nextPng = r.png;
        nextOpen = applyToPlan(nextOpen, rp, g);
        ctx.report(`${rp.note}: painted, ${Math.round(r.agree * 100)}% as planned`);
      }
      ctx.save?.(round + 1, nextPng, nextOpen);
    }
    const next = checkMap(nextOpen, g, ctx.sides);
    if (next.score > check.score) {
      ctx.report(`repair round ${round + 1} made it worse (${check.score} → ${next.score}), undone`);
      break;
    }
    (png = nextPng), (open = nextOpen), (check = next);
  }
  // The final plan: the border is blocked except at the ways out, so nobody walks off the map elsewhere.
  const final = Uint8Array.from(open);
  const exitCells = new Set(check.keep.flatMap((o) => o.cells));
  for (let i = 0; i < final.length; i++) {
    const r = Math.floor(i / g.cols), c = i % g.cols;
    if ((r === 0 || c === 0 || r === g.rows - 1 || c === g.cols - 1) && !exitCells.has(i)) final[i] = 0;
  }
  const walk = walkOf(final, g);
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const kx = W / g.cols, ky = H / g.rows;
  const at = (i: number) => ({ x: ((i % g.cols) + 0.5) * kx, y: (Math.floor(i / g.cols) + 0.5) * ky });
  const exits: Spot[] = check.keep.map((o) => ({ ...at(o.mid), label: o.side }));
  // Ways out the map still lacks: the main region's ground nearest where the gap was meant to be (the best edge spot).
  const gaps = gapCells(ctx.sides, g);
  check.missing.forEach((side, k) => {
    const gap = gaps.filter((x) => x.side === side)[k] ?? gaps.find((x) => x.side === side)!;
    let best = -1, bd = Infinity;
    for (let i = 0; i < walk.walk.length; i++)
      if (walk.main >= 0 && walk.label[i] === walk.main && dist(i, gap.cell, g) < bd) (bd = dist(i, gap.cell, g)), (best = i);
    if (best >= 0) exits.push({ ...at(best), label: side });
  });
  const passed = !check.repairs.length && check.main >= ctx.minArea;
  return { png, open: final, walk, exits, passed, rounds: round };
}
