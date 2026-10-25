/**
 * Reading a big top-down map (see docs/places.md): where people can walk, where its buildings are (for sight) and
 * what blocks sight; the spots things are placed on (entrances, named landmarks) are found in mapspots.ts. Studied
 * in October 2026 against 400 hand-labelled points on five maps.
 *
 * 1. Qwen-Image 2.1 edit redraws the whole map (at about 1.4 or 2.4 MP: tiles lose the context that tells a roof
 *    from a floor) as flat plans, three ways (WALK_READINGS): white walkable, black solid (filled, not outlined),
 *    blue water, pits and the outside. A fourth plan also paints buildings red (BUILDING_PLAN). Each reading alone is
 *    right at 85-87% of the points; they share their mistakes (small things blurred into floor), so a vote gains
 *    little, but where they split is where the map is uncertain.
 * 2. Luna settles the split cells (decision API, the place's description in the prompt): a patch of up to 20 m² in
 *    one look with the patch outlined; a bigger one sampled every 2 m, each sample a close-up with a ring at the point
 *    ("what is under the ring?"), each cell taking its nearest sample. Patches under 2 m² take the majority. Right at
 *    92% of the points after the walkability fixes (mapfix.ts), for about a cent of Luna per map.
 * 3. Water is judged by the place: each patch most readings painted blue gets one look ("can the character walk
 *    across it here?"), so a shallow puddle or ice meant to be walked on opens and a canal or marsh stays a barrier.
 *
 * SAM 3 with Luna's names (the earlier reader) was weaker here: its names drift ("frozen runnel" took the snow
 * trails) and it read a dungeon almost wholly wrong. Sol on crops was no better than Luna at forty times the price.
 */
import sharp from 'sharp';
import { genai } from '../genai/service';
import { qwenEdit } from './comfy';
import { CELL, cellsOf, components, type Grid } from './mapgrid';
import type { Spot } from './mapspots';

/** Qwen prompts for the walk readings, and the megapixels each map is read at. */
export const WALK_READINGS: { prompt: string; mp: number }[] = [
  {
    mp: 2.4,
    prompt: 'Convert this top-down map into a flat three-colour plan with exactly the same layout, shapes and positions. Paint pure white every open floor area where a person can walk: floors, corridors, paths, streets, plazas, lawns, carpet, bridges and stairs. Paint pure blue all water (sea, rivers, pools, channels), pits and the empty darkness, fog or land outside the place. Paint pure black everything solid that blocks walking: walls, buildings and roofs, furniture, desks, cars, machines, statues, rocks, cliffs, trees, hedges and bushes. Only white, blue and black, no texture, no outlines.',
  },
  {
    mp: 1.4,
    prompt: 'Convert this top-down game map into a flat walkability mask for the game, with exactly the same layout, shapes and positions. Paint pure white all ground the player can walk on: floors, streets, paths, plazas, decks, bridges, stairs, grass, snow and sand, including patterns, rugs and decorations lying flat on the ground. Paint pure black, filled solid, everything the player cannot walk through: buildings and roofs, walls, fences, hedges, furniture, tables, crates, carts, statues, rocks, trees, bushes and unlit dark areas. Paint pure blue all water, pits and the area outside the place. Fill every shape completely: no outlines, no texture, no grey.',
  },
  {
    mp: 1.4,
    prompt: 'Convert this top-down view into a game pathing mask with exactly the same layout. Fill areas the player is allowed to stand in white. Fill areas the player is blocked from standing in black. Fill all water, pits and the area outside the place with blue. Fill all objects, buildings, trees, rocks and tables with black rather than outlining them. Only flat white, black and blue.',
  },
];

/** The plan that marks buildings (red), for sight. */
export const BUILDING_PLAN = {
  mp: 1.4,
  prompt: 'Convert this top-down game map into a flat four-colour plan for the game, with exactly the same layout, shapes and positions. Paint pure white all ground the player can walk on: floors, streets, paths, plazas, decks, bridges, stairs, grass, snow and sand, including patterns, rugs and decorations lying flat on the ground. Paint pure red every building and roof. Paint pure black, filled solid, everything else the player cannot walk through: walls, fences, hedges, furniture, tables, crates, carts, statues, rocks, trees, bushes and unlit dark areas. Paint pure blue all water, pits and the area outside the place. Fill every shape completely: no outlines, no texture, no grey.',
};

/** A plan read back as cells: walkable (near white), water (blue) and building (red). */
export interface PlanCells {
  walk: Uint8Array;
  water: Uint8Array;
  building: Uint8Array;
}

/** Qwen's plan of the whole map, read at about `mp` megapixels, as cells. */
export async function readPlan(png: Buffer, g: Grid, plan: { prompt: string; mp: number }, seed = 1): Promise<PlanCells> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const k = Math.sqrt((plan.mp * 1e6) / (W * H));
  const ref = await sharp(png).resize(Math.round((W * k) / 16) * 16, Math.round((H * k) / 16) * 16).png().toBuffer();
  const { data, info } = await sharp(await qwenEdit(ref, plan.prompt, seed)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, walk = new Uint8Array(n), water = new Uint8Array(n), building = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]!, gr = data[i * 3 + 1]!, b = data[i * 3 + 2]!;
    walk[i] = r > 150 && gr > 150 && b > 150 ? 1 : 0;
    water[i] = b > 140 && r < 110 ? 1 : 0;
    building[i] = r > 150 && gr < 100 && b < 100 ? 1 : 0;
  }
  return { walk: cellsOf(walk, info.width, info.height, g), water: cellsOf(water, info.width, info.height, g), building: cellsOf(building, info.width, info.height, g) };
}

/** What Luna is told about the place she judges. */
export interface PlaceBrief {
  name: string;
  description: string;
}

const CONTEXT = (p: PlaceBrief) => `We are turning a painted top-down map into the walkability mask of a 2D top-down RPG. The game draws this painting as the place, and lets the player character (about half a metre across, seen from above) walk only where the mask allows; everything else blocks movement like a wall.
The place: ${p.name}. As designed: ${p.description.slice(0, 1400)}`;

/** Images for Luna: the whole map with a box round the close-up, and the close-up (`S` map px square, shown at `C`). */
async function views(png: Buffer, W: number, H: number, cx: number, cy: number, S: number, C: number, overlay: (s: number, left: number, top: number) => string) {
  const left = Math.round(Math.max(0, Math.min(W - S, cx - S / 2))), top = Math.round(Math.max(0, Math.min(H - S, cy - S / 2)));
  const s = C / S;
  const crop = await sharp(png).extract({ left, top, width: S, height: S }).resize(C, C).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}">${overlay(s, left, top)}</svg>`) }]).png().toBuffer();
  const o = 1024 / W;
  const box = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="${Math.round(H * o)}"><rect x="${left * o}" y="${top * o}" width="${S * o}" height="${S * o}" fill="none" stroke="#ff00ff" stroke-width="3"/></svg>`;
  const overview = await sharp(png).resize(1024).composite([{ input: Buffer.from(box) }]).jpeg({ quality: 85 }).toBuffer();
  return [overview, crop];
}

const yesNo = (yes: string, no: string) => ({ yes, no });
const probYes = (a: Record<string, { type: string; probabilities?: Record<string, number> }>, q: string) => a[q]?.probabilities?.yes ?? 0.5;

/** What can lie under a point; only ground is walkable. */
const WHAT = {
  ground: 'open ground: floor, street, path, plaza, deck or boardwalk, bridge, stairs, grass, snow, sand, or something flat painted or lying on the ground (tiles, rugs, patterns, shadows, puddles)',
  building: 'a roof or building',
  wall: 'a wall, its top, a fence, hedge, railing or pillar',
  plant: 'a tree or bush',
  object: 'furniture, a crate, barrel, cart, boat, statue, rock or other solid object',
  water: 'water or ice',
  void: 'darkness, a pit, a cliff, or the land outside the place',
};

/** Luna's probability that the point (picture px) is ground the character can stand on. */
export async function groundAt(png: Buffer, W: number, H: number, x: number, y: number, pxm: number, p: PlaceBrief): Promise<number> {
  const S = Math.round(12 * pxm), C = 512;
  const ring = (s: number, left: number, top: number) => {
    const cx = (x - left) * s, cy = (y - top) * s;
    const l = (a: number, b: number, c: number, d: number) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="#ff00ff" stroke-width="4"/>`;
    return `<circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="#ff00ff" stroke-width="3"/>${l(cx - 30, cy, cx - 14, cy)}${l(cx + 14, cy, cx + 30, cy)}${l(cx, cy - 30, cx, cy - 14)}${l(cx, cy + 14, cx, cy + 30)}`;
  };
  const a = await genai().decide('image.check', {
    state: `${CONTEXT(p)}\nImage 1 is the whole map; the magenta box marks where image 2 is. Image 2 is a close-up of about 12 metres; the point asked about is the centre of the small magenta ring.`,
    questions: { what: { type: 'choice', instructions: 'What is directly under the centre of the ring, as the painter meant it? Answer for that point only. Flat things on the ground (patterns, tiles, rugs, shadows, puddles, fallen leaves) count as ground. Water and ice count as ground only if this place clearly means people to walk on them; otherwise answer water.', criteria: WHAT } },
    images: await views(png, W, H, x, y, Math.min(S, W, H), C, ring),
  });
  const w = a.what;
  return w?.type === 'choice' ? (w.probabilities.ground ?? (w.choice === 'ground' ? 1 : 0)) : 0.5;
}

/** The questions Luna answers about an outlined area. */
const AREA = {
  patch: {
    note: 'a magenta outline marks an area our readers disagree about.',
    instructions: 'Is most of the outlined area ground the character can stand on (floor, street, path, deck, bridge, stairs, grass, snow, or flat things lying on the ground such as patterns, rugs, shadows and puddles)? Answer no if most of it is a roof or building, a wall, fence or hedge, furniture or another solid object, a tree or bush, a rock, deep water, unlit darkness, or the land outside the place. Water and ice count as ground only if this place clearly means people to walk on them.',
    criteria: yesNo('mostly ground the character can stand on', 'mostly blocked'),
  },
  water: {
    note: 'a magenta outline marks an area our reader painted as water or ice.',
    instructions: 'In this place, can the character walk across the outlined area? Answer yes only if it is a shallow puddle, wet ground, or ice this place means people to walk on; answer no if it is a barrier such as a pond, pool, river, canal, lake, sea, marsh water, a pit, unlit darkness or the land outside the place. Judge by the place as designed and how the painting shows it.',
    criteria: yesNo('the character can walk across it', 'a barrier'),
  },
  reach: {
    note: 'a magenta outline marks an area the mask reads as walkable but cut off from the rest of the walkable ground.',
    instructions: 'Is the outlined area open ground (floor, street, path, deck, yard, garden, room) that the player should be able to walk to? Answer no if it is mostly a roof, the top of a wall or rock, water, darkness, or the land outside the place.',
    criteria: yesNo('open ground the player should reach', 'not ground the player should reach'),
  },
};

/** Luna's probability of yes to an area question about some cells, outlined (just outside them) on a close-up. */
export async function judgeArea(png: Buffer, W: number, H: number, cells: number[], g: Grid, p: PlaceBrief, kind: keyof typeof AREA): Promise<number> {
  const kx = W / g.cols, ky = H / g.rows;
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const i of cells) {
    const c = i % g.cols, r = Math.floor(i / g.cols);
    (c0 = Math.min(c0, c)), (c1 = Math.max(c1, c)), (r0 = Math.min(r0, r)), (r1 = Math.max(r1, r));
  }
  const pxm = kx / CELL;
  const S = Math.min(Math.max(Math.round(8 * pxm), Math.round(Math.max((c1 - c0 + 1) * kx, (r1 - r0 + 1) * ky) + 6 * pxm)), W, H);
  const set = new Set(cells), ring = new Set<number>();
  for (const i of cells) for (const j of [i - 1, i + 1, i - g.cols, i + g.cols]) if (j >= 0 && j < g.cols * g.rows && !set.has(j)) ring.add(j);
  const outline = (s: number, left: number, top: number) => [...ring].map((i) => `<rect x="${((i % g.cols) * kx - left) * s}" y="${(Math.floor(i / g.cols) * ky - top) * s}" width="${Math.max(2, kx * s)}" height="${Math.max(2, ky * s)}" fill="#ff00ff"/>`).join('');
  const q = AREA[kind];
  const a = await genai().decide('image.check', {
    state: `${CONTEXT(p)}\nImage 1 is the whole map (the magenta box marks image 2). In image 2, about ${Math.round(S / pxm)} metres across, ${q.note}`,
    questions: { a: { type: 'choice', instructions: q.instructions, criteria: q.criteria } },
    images: await views(png, W, H, ((c0 + c1 + 1) / 2) * kx, ((r0 + r1 + 1) / 2) * ky, S, 768, outline),
  });
  return probYes(a, 'a');
}

/** Run tasks a few at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

const PATCH_MIN = 2, PATCH_ONE_LOOK = 20, SAMPLE_SPACING = 2;

export interface Settled {
  open: Uint8Array;
  /** Share of cells the readings agreed on, and Luna's looks. */
  agree: number;
  looks: number;
}

/** Where the walk readings split, Luna decides (see the file comment). */
export async function settle(png: Buffer, readings: Uint8Array[], g: Grid, p: PlaceBrief): Promise<Settled> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const n = g.cols * g.rows, kx = W / g.cols, ky = H / g.rows;
  const votes = new Uint8Array(n);
  for (const m of readings) for (let i = 0; i < n; i++) votes[i]! += m[i]!;
  const open = Uint8Array.from(votes, (v) => (2 * v > readings.length ? 1 : 0));
  const split = (i: number) => votes[i]! > 0 && votes[i]! < readings.length;
  const patches = components(g, split).filter((q) => q.length * CELL * CELL >= PATCH_MIN);
  let agree = 0;
  for (let i = 0; i < n; i++) if (!split(i)) agree++;
  const col = (i: number) => i % g.cols, row = (i: number) => Math.floor(i / g.cols);
  const whole = patches.filter((q) => q.length * CELL * CELL <= PATCH_ONE_LOOK);
  const sampled = patches.filter((q) => q.length * CELL * CELL > PATCH_ONE_LOOK).map((q) => ({ cells: q, at: spread(q, g, SAMPLE_SPACING / CELL) }));
  const [areaVotes, pointVotes] = await Promise.all([
    pool(whole, 16, (q) => judgeArea(png, W, H, q, g, p, 'patch').catch(() => -1)),
    pool(sampled.flatMap((s) => s.at), 16, (i) => groundAt(png, W, H, (col(i) + 0.5) * kx, (row(i) + 0.5) * ky, kx / CELL, p).catch(() => -1)),
  ]);
  whole.forEach((q, j) => { if (areaVotes[j]! >= 0) for (const c of q) open[c] = areaVotes[j]! > 0.5 ? 1 : 0; });
  let k = 0;
  for (const s of sampled) {
    const v = pointVotes.slice(k, (k += s.at.length));
    for (const c of s.cells) {
      let bi = 0, bd = Infinity;
      s.at.forEach((q, i) => {
        const d = Math.hypot(col(c) - col(q), row(c) - row(q));
        if (d < bd) (bd = d), (bi = i);
      });
      if (v[bi]! >= 0) open[c] = v[bi]! > 0.5 ? 1 : 0;
    }
  }
  return { open, agree: agree / n, looks: whole.length + pointVotes.length };
}

/** Cells spread over a patch about `gap` cells apart (farthest-point from the one nearest its middle). */
function spread(q: number[], g: Grid, gap: number): number[] {
  const col = (i: number) => i % g.cols, row = (i: number) => Math.floor(i / g.cols);
  let sx = 0, sy = 0;
  for (const c of q) (sx += col(c)), (sy += row(c));
  const mx = sx / q.length, my = sy / q.length;
  const pts = [q.reduce((b, c) => (Math.hypot(col(c) - mx, row(c) - my) < Math.hypot(col(b) - mx, row(b) - my) ? c : b), q[0]!)];
  const want = Math.min(200, Math.round(q.length / (gap * gap)));
  const dmin = new Float64Array(q.length).fill(Infinity);
  while (pts.length < want) {
    const last = pts[pts.length - 1]!;
    let bk = -1, bd = -1;
    q.forEach((c, i) => {
      dmin[i] = Math.min(dmin[i]!, Math.hypot(col(c) - col(last), row(c) - row(last)));
      if (dmin[i]! > bd) (bd = dmin[i]!), (bk = c);
    });
    if (bd < gap * 0.75) break;
    pts.push(bk);
  }
  return pts;
}

/**
 * Water judged by the place: every patch most readings painted blue, inside the place (not touching the barrier band)
 * and at least 1 m², gets one look; walkable ones open. Returns how many opened.
 */
export async function judgeWater(png: Buffer, open: Uint8Array, waters: Uint8Array[], g: Grid, band: number, p: PlaceBrief): Promise<number> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const water = (i: number) => 2 * waters.reduce((a, m) => a + m[i]!, 0) > waters.length;
  const inside = (i: number) => Math.min(Math.floor(i / g.cols), i % g.cols, g.rows - 1 - Math.floor(i / g.cols), g.cols - 1 - (i % g.cols)) > band;
  const patches = components(g, water).filter((q) => q.length * CELL * CELL >= 1 && q.every(inside));
  const votes = await pool(patches, 12, (q) => judgeArea(png, W, H, q, g, p, 'water').catch(() => 0));
  let opened = 0;
  patches.forEach((q, i) => {
    if (votes[i]! <= 0.5) return;
    opened++;
    for (const c of q) open[c] = 1;
  });
  return opened;
}

/** The walkable cell nearest a grid point, within `max` cells. */
function nearestWalk(walk: Uint8Array, g: Grid, cx: number, cy: number, max: number): [number, number] | null {
  let best: [number, number] | null = null, bd = Infinity;
  for (let r = Math.max(0, Math.floor(cy - max)); r <= Math.min(g.rows - 1, Math.ceil(cy + max)); r++)
    for (let c = Math.max(0, Math.floor(cx - max)); c <= Math.min(g.cols - 1, Math.ceil(cx + max)); c++) {
      if (!walk[r * g.cols + c]) continue;
      const d = Math.hypot(c - cx, r - cy);
      if (d < bd && d <= max) (bd = d), (best = [c, r]);
    }
  return best;
}

/** Unnamed landmarks, when Sol names none: the largest solid things (not buildings or water, 0.5 to 40 m²) standing in walkable ground, each at the walkable ground beside it. */
export function landmarks(open: Uint8Array, walk: Uint8Array, building: Uint8Array, water: Uint8Array, g: Grid, W: number, H: number, max = 10): Spot[] {
  const kx = W / g.cols, ky = H / g.rows, out: { spot: Spot; size: number }[] = [];
  for (const q of components(g, (i) => !open[i] && !building[i] && !water[i])) {
    const m2 = q.length * CELL * CELL;
    if (m2 < 0.5 || m2 > 40) continue;
    let sx = 0, sy = 0;
    for (const i of q) (sx += i % g.cols), (sy += Math.floor(i / g.cols));
    const mx = sx / q.length, my = sy / q.length;
    const at = nearestWalk(walk, g, mx, my, 1.5 / CELL + Math.sqrt(q.length / Math.PI));
    if (at) out.push({ spot: { x: (at[0] + 0.5) * kx, y: (at[1] + 0.5) * ky, label: 'a landmark' }, size: q.length });
  }
  return out.sort((a, b) => b.size - a.size).slice(0, max).map((o) => o.spot);
}
