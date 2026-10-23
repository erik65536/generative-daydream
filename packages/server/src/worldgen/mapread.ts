/**
 * Reading a top-down map (see docs/places.md): where people can walk, what blocks sight, the buildings and their
 * doors, and landmarks. Two readers that make different mistakes, and Luna where they disagree:
 *
 * 1. SAM: Luna names what the map shows as an object detector would (floors, stairs, walls, buildings, water, props,
 *    trees, doors); SAM 3 finds each name in overlapping 1024 px tiles (it sees about 1000 px); the most specific
 *    (smallest) detection wins each pixel. A wall mask whose inside is mostly floor keeps only its rim (the detector
 *    filled in a walled area); a detection covering over a third of the map is ignored (a scene-sized blob). Cells
 *    take their majority class; Luna checks the colouring once, beside the map, and her better names are read again.
 *    Strong on clutter (desks, cars), weak where names drift (a dark temple read almost no floor).
 * 2. Qwen-Image 2.1 edit redraws the map as a three-colour plan: white walkable, blue water and the outside, black
 *    solid. Strong on structure and the outside, weak on clutter. (Two colours flipped the sea to walkable.)
 * 3. Where they agree (about 70% of a map, right 94% of the time) the cell is settled. Every joined patch where they
 *    disagree is settled by Luna on the decision API: a zoomed crop with a crosshair every metre over the patch ("can
 *    a person stand here?"), each cell taking its nearest sample's answer; patches under 1 m² take Qwen's answer.
 *    91% right at hand-labelled points, against 85% (SAM) and 80% (Qwen).
 */
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service';
import { qwenEdit, segment } from './comfy';
import { CELL, cellsOf, components, type Grid } from './mapgrid';

export const WALK_PLAN = 'Convert this top-down map into a flat three-colour plan with exactly the same layout, shapes and positions. Paint pure white every open floor area where a person can walk: floors, corridors, paths, streets, plazas, lawns, carpet, bridges and stairs. Paint pure blue all water (sea, rivers, pools, channels), pits and the empty darkness, fog or land outside the place. Paint pure black everything solid that blocks walking: walls, buildings and roofs, furniture, desks, cars, machines, statues, rocks, cliffs, trees, hedges and bushes. Only white, blue and black, no texture, no outlines.';

const ReadSchema = z.object({
  floors: z.array(z.string().max(40)).min(1).max(5).describe('Surfaces people walk on, as an object detector would name them by material and colour: "grey cobblestone street", "wooden plank floor", "green grass lawn"'),
  stairs: z.array(z.string().max(40)).max(3).describe('Stairs or ramps; empty if none'),
  walls: z.array(z.string().max(40)).max(4).describe('Walls, rock masses, hedges, fences, partitions, cliffs: things standing up that block walking (not buildings)'),
  buildings: z.array(z.string().max(40)).max(3).describe('Roofed buildings seen from above, by the look of their roofs ("red tiled roof"); empty for indoor places'),
  water: z.array(z.string().max(40)).max(3).describe('Water, pits, lava or the void around the place'),
  props: z.array(z.string().max(40)).max(6).describe('Solid things standing on the floor: furniture, cars, crates, statues, fountains, tables'),
  trees: z.array(z.string().max(40)).max(3).describe('Trees, bushes, giant mushrooms: crowns seen from above'),
  door: z.string().max(40).describe('What doors and entrances look like from above, as a detector name ("wooden door"); empty if none'),
});
export type MapRead = z.infer<typeof ReadSchema>;
type Kind = 'floor' | 'stairs' | 'wall' | 'building' | 'water' | 'prop' | 'tree';
const KINDS: [keyof MapRead, Kind][] = [['floors', 'floor'], ['stairs', 'stairs'], ['walls', 'wall'], ['buildings', 'building'], ['water', 'water'], ['props', 'prop'], ['trees', 'tree']];
/** Kinds people walk on, and kinds that block sight. */
const OPEN = new Set<Kind>(['floor', 'stairs']);
const TALL = new Set<Kind>(['wall', 'building', 'tree']);

export interface Detected {
  /** Each cell's class (index into `classes`, -1 unknown). */
  cls: Int16Array;
  classes: { kind: Kind; term: string }[];
  /** Door detections' centres (picture px). */
  doors: { x: number; y: number }[];
}

/** Luna names what the map shows, as an object detector would. */
export async function nameThings(png: Buffer, name: string, description: string): Promise<MapRead> {
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D top-down RPG. You read top-down maps so the game can use them. Judge only what you see.',
    prompt: `This top-down map is ${name}: ${description}\nAn object detector (SAM 3) will find things in it from short English names you give. Name each kind of surface and object exactly as it looks in this map, by material, shape and colour.`,
    schema: ReadSchema,
    name: 'map_read',
    images: [await sharp(png).resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer()],
    maxTokens: 2000,
  });
}

/** SAM 3 over the map in overlapping tiles: every detection of `term`, as a picture-sized mask. */
async function detect(png: Buffer, W: number, H: number, term: string, many: boolean): Promise<Uint8Array[]> {
  const TILE = 1024, OVER = 128;
  const starts = (n: number) => {
    if (n <= TILE + OVER) return [0];
    const out: number[] = [];
    for (let v = 0; ; v += TILE - OVER) {
      out.push(Math.min(v, n - TILE));
      if (v + TILE >= n) break;
    }
    return out;
  };
  const out: Uint8Array[] = [];
  for (const top of starts(H))
    for (const left of starts(W)) {
      const tw = Math.min(TILE, W), th = Math.min(TILE, H);
      const tile = tw === W && th === H ? png : await sharp(png).extract({ left, top, width: tw, height: th }).png().toBuffer();
      for (const m of await segment(tile, `${term}:${many ? 200 : 60}`)) {
        const raw = await sharp(m).greyscale().resize(tw, th, { fit: 'fill' }).raw().toBuffer();
        const full = new Uint8Array(W * H);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (raw[y * tw + x]! > 127) full[(top + y) * W + left + x] = 1;
        out.push(full);
      }
    }
  return out;
}

/** Chamfer distance (px) from each set pixel to the nearest unset one. */
function inside(m: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i]!, x > 0 ? d[i - 1]! + 1 : 1, y > 0 ? d[i - W]! + 1 : 1);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i]!, x < W - 1 ? d[i + 1]! + 1 : 1, y < H - 1 ? d[i + W]! + 1 : 1);
  }
  return d;
}

/** SAM's reading of the map with the given names, as cell classes. */
export async function detectAll(png: Buffer, read: MapRead, g: Grid, pxm: number): Promise<Detected> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const classes: Detected['classes'] = [];
  for (const [key, kind] of KINDS) for (const term of read[key] as string[]) if (term.trim()) classes.push({ kind, term: term.trim() });
  const floorSeen = new Uint8Array(W * H);
  const owner = new Int16Array(W * H).fill(-1), best = new Float64Array(W * H).fill(Infinity);
  // Floors first, so a wall's inside can be tested against them.
  const order = [...classes.keys()].sort((a, b) => Number(!OPEN.has(classes[a]!.kind)) - Number(!OPEN.has(classes[b]!.kind)));
  for (const ci of order) {
    const c = classes[ci]!;
    for (const m of await detect(png, W, H, c.term, c.kind === 'prop' || c.kind === 'tree')) {
      let area = 0;
      for (const v of m) area += v;
      if (area < 50 || (!OPEN.has(c.kind) && area > (W * H) / 3)) continue;
      if (OPEN.has(c.kind)) for (let i = 0; i < m.length; i++) if (m[i]) floorSeen[i] = 1;
      if (c.kind === 'wall') {
        const d = inside(m, W, H);
        let core = 0, onFloor = 0;
        for (let i = 0; i < m.length; i++) if (d[i]! > pxm) (core++, floorSeen[i] && onFloor++);
        if (core > 0 && onFloor / core > 0.5) {
          area = 0;
          for (let i = 0; i < m.length; i++) if (d[i]! > pxm) m[i] = 0;
            else area += m[i]!;
        }
      }
      for (let i = 0; i < m.length; i++) if (m[i] && area < best[i]!) (best[i] = area), (owner[i] = ci);
    }
  }
  const doors: Detected['doors'] = [];
  if (read.door.trim())
    for (const m of await detect(png, W, H, read.door.trim(), true)) {
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < m.length; i++) if (m[i]) (sx += i % W), (sy += Math.floor(i / W)), n++;
      if (n > 20 && n < (W * H) / 50) doors.push({ x: sx / n, y: sy / n });
    }
  // Cells take the class at their centre, then a majority filter (radius 2 cells) removes speckle.
  const cls = new Int16Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) cls[r * g.cols + c] = owner[Math.min(H - 1, Math.floor(((r + 0.5) * H) / g.rows)) * W + Math.min(W - 1, Math.floor(((c + 0.5) * W) / g.cols))]!;
  for (let pass = 0; pass < 2; pass++) {
    const prev = Int16Array.from(cls);
    for (let r = 0; r < g.rows; r++)
      for (let c = 0; c < g.cols; c++) {
        const votes = new Map<number, number>();
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
          const v = prev[rr * g.cols + cc]!;
          if (v >= 0) votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        let top = -1, n = 0;
        for (const [k, v] of votes) if (v > n) (top = k), (n = v);
        const cur = prev[r * g.cols + c]!;
        if (cur < 0 || (votes.get(cur) ?? 0) < 8) cls[r * g.cols + c] = top;
      }
  }
  return { cls, classes, doors };
}

const PALETTE = [[230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255], [170, 110, 40], [255, 250, 200], [128, 0, 0], [170, 255, 195], [128, 128, 0], [0, 0, 128]];

/** The map beside its class colouring, with the legend in a strip of its own (never over the map). */
export async function classView(png: Buffer, d: Detected, g: Grid): Promise<Buffer> {
  const k = 4, LW = g.cols * k, LH = g.rows * k;
  const rgb = Buffer.alloc(g.cols * g.rows * 3);
  const counts = new Map<number, number>();
  for (let i = 0; i < d.cls.length; i++) {
    const c = d.cls[i]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
    if (c >= 0) rgb.set(PALETTE[c % PALETTE.length]!, i * 3);
  }
  const legendH = Math.max(LH, 22 * d.classes.length + 16), LGW = 420;
  const legend = d.classes.map((c, i) => `<rect x="8" y="${8 + i * 22}" width="16" height="16" fill="rgb(${PALETTE[i % PALETTE.length]!.join(',')})"/><text x="30" y="${21 + i * 22}" font-size="15" font-family="Arial" fill="#fff">${c.kind}: ${c.term.replace(/[<&>]/g, '')} (${((counts.get(i) ?? 0) * CELL * CELL).toFixed(0)} m²)</text>`).join('');
  const classes = await sharp(rgb, { raw: { width: g.cols, height: g.rows, channels: 3 } }).resize(LW, LH, { kernel: 'nearest' }).png().toBuffer();
  return sharp({ create: { width: LW * 2 + LGW + 32, height: legendH, channels: 3, background: '#000' } })
    .composite([
      { input: await sharp(png).resize(LW, LH, { fit: 'fill' }).png().toBuffer(), left: 0, top: 0 },
      { input: classes, left: LW + 16, top: 0 },
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${LGW}" height="${legendH}">${legend}</svg>`), left: LW * 2 + 32, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
}

const CheckSchema = z.object({
  correct: z.boolean().describe('True if every area is coloured as the right kind of thing everywhere that matters for walking'),
  mistakes: z.array(z.string().max(200)).max(6).describe('Each wrongly coloured area, in plain words'),
  drop: z.array(z.string().max(40)).max(5).describe('Names from the legend whose colour covers things that are not that (copy the name after the colon exactly)'),
  floors: z.array(z.string().max(40)).max(3).describe('New detector names for walkable surfaces left uncoloured or wrongly coloured'),
  obstacles: z.array(z.string().max(40)).max(3).describe('New detector names for solid things people cannot walk through that are coloured as floor'),
});

/** Luna checks SAM's colouring once: names that grabbed the wrong thing are dropped, better ones added (null: it is right). */
export async function checkNames(view: Buffer, name: string, read: MapRead): Promise<{ read: MapRead; mistakes: string[] } | null> {
  const chk = await genai().structured('world.design', {
    system: 'You check how a game reads a top-down map. Judge only what you see.',
    prompt: `Left: a top-down map of ${name}. Middle: how the game read it, each colour one detector name. Right: the legend (kind: name; floor and stairs are walkable, everything else is not). Is everything coloured as the right kind of thing? Name each wrongly coloured area, drop names that grabbed the wrong thing (for example a puddle name that covered a whole road), and give better detector names for what was missed. Names are short English phrases as an object detector would use them, describing what the thing looks like by material and colour ("dark grey asphalt driving lane", never just "floor").`,
    schema: CheckSchema,
    name: 'map_read_check',
    images: [view],
    maxTokens: 2000,
  });
  if (chk.correct || !(chk.drop.length || chk.floors.length || chk.obstacles.length)) return null;
  const dropped = new Set(chk.drop.map((d) => d.replace(/^[a-z]+:\s*/i, '').trim().toLowerCase()));
  const keep = (t: string) => !dropped.has(t.trim().toLowerCase());
  const next: MapRead = {
    floors: [...read.floors.filter(keep), ...chk.floors].slice(0, 6),
    stairs: read.stairs.filter(keep),
    walls: read.walls.filter(keep),
    buildings: read.buildings.filter(keep),
    water: read.water.filter(keep),
    props: [...read.props.filter(keep), ...chk.obstacles].slice(0, 8),
    trees: read.trees.filter(keep),
    door: read.door,
  };
  if (!next.floors.length) next.floors = read.floors;
  return { read: next, mistakes: chk.mistakes };
}

/** Open cells (people may stand) and see-through cells from SAM's classes. */
export function samCells(d: Detected): { open: Uint8Array; sight: Uint8Array } {
  const n = d.cls.length, open = new Uint8Array(n), sight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = d.classes[d.cls[i]!];
    if (c && OPEN.has(c.kind)) open[i] = 1;
    if (!c || !TALL.has(c.kind)) sight[i] = 1;
  }
  return { open, sight };
}

/** Qwen's three-colour plan of a picture: walkable where it painted near white (a picture-sized mask). */
export async function walkPlan(png: Buffer, seed = 1): Promise<Uint8Array> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const out = await qwenEdit(png, WALK_PLAN, seed);
  const { data } = await sharp(out).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = data[i * 3]! > 150 && data[i * 3 + 1]! > 150 && data[i * 3 + 2]! > 150 ? 1 : 0;
  return m;
}

/** Qwen's plan of the map as open cells. */
export async function qwenCells(png: Buffer, g: Grid): Promise<Uint8Array> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  return cellsOf(await walkPlan(png), W, H, g);
}

/** Luna's answer on whether a person can stand at a picture point (a zoomed crop with a crosshair, the map beside it). */
async function standHere(png: Buffer, overview: Buffer, x: number, y: number, W: number, H: number): Promise<number> {
  const R = Math.min(90, Math.floor(Math.min(W, H) / 2) - 1), C = 384;
  const left = Math.max(0, Math.min(W - 2 * R, Math.round(x) - R)), top = Math.max(0, Math.min(H - 2 * R, Math.round(y) - R));
  const cx = ((x - left) * C) / (2 * R), cy = ((y - top) * C) / (2 * R);
  const line = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ff00ff" stroke-width="4"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}"><circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#ff00ff" stroke-width="4"/>${line(cx - 24, cy, cx - 13, cy)}${line(cx + 13, cy, cx + 24, cy)}${line(cx, cy - 24, cx, cy - 13)}${line(cx, cy + 13, cx, cy + 24)}</svg>`;
  const crop = await sharp(png).extract({ left, top, width: 2 * R, height: 2 * R }).resize(C, C).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  const a = await genai().decide('image.check', {
    state: 'A top-down game map; the first image is the whole map, the second a close-up with a magenta crosshair.',
    questions: { stand: { type: 'noul', instructions: 'Is the exact centre of the magenta crosshair on open ground where a person could stand and walk (floor, path, street, lawn, stairs), rather than on a wall, building, roof, furniture, vehicle, plant, rock, water, a pit or the darkness outside?' } },
    images: [overview, crop],
  });
  return a.stand?.type === 'noul' ? a.stand.noul : 0.5;
}

/** Metres between Luna's samples inside a disagreement patch. */
const SAMPLE_SPACING = 1;

export interface Arbitrated {
  open: Uint8Array;
  /** Share of cells the readers agreed on, patches settled by Luna, her calls. */
  agree: number;
  patches: number;
  calls: number;
}

/** Settle where SAM and Qwen disagree (see the file comment). */
export async function arbitrate(png: Buffer, sam: Uint8Array, qwen: Uint8Array, g: Grid): Promise<Arbitrated> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const overview = await sharp(png).resize({ width: 512 }).png().toBuffer();
  const out = Uint8Array.from(sam);
  let agree = 0;
  for (let i = 0; i < sam.length; i++) if (sam[i] === qwen[i]) agree++;
  const patches = components(g, (i) => sam[i] !== qwen[i]);
  let calls = 0, settled = 0;
  const col = (i: number) => i % g.cols, row = (i: number) => Math.floor(i / g.cols);
  await Promise.all(patches.map(async (p) => {
    if (p.length * CELL * CELL < 1) {
      for (const k of p) out[k] = qwen[k]!;
      return;
    }
    settled++;
    // Samples spread over the patch (farthest-point from the cell nearest its centroid), one per SPACING².
    let sx = 0, sy = 0;
    for (const k of p) (sx += col(k)), (sy += row(k));
    const mx = sx / p.length, my = sy / p.length;
    const pts = [p.reduce((b, k) => (Math.hypot(col(k) - mx, row(k) - my) < Math.hypot(col(b) - mx, row(b) - my) ? k : b), p[0]!)];
    const want = Math.max(1, Math.min(400, Math.round((p.length * CELL * CELL) / (SAMPLE_SPACING * SAMPLE_SPACING))));
    const dmin = new Float64Array(p.length).fill(Infinity);
    while (pts.length < want) {
      const q = pts[pts.length - 1]!;
      let bestK = -1, bd = -1;
      p.forEach((k, i) => {
        dmin[i] = Math.min(dmin[i]!, Math.hypot(col(k) - col(q), row(k) - row(q)));
        if (dmin[i]! > bd) (bd = dmin[i]!), (bestK = k);
      });
      if (bd < 1) break;
      pts.push(bestK);
    }
    const votes = await Promise.all(pts.map((k) => standHere(png, overview, ((col(k) + 0.5) * W) / g.cols, ((row(k) + 0.5) * H) / g.rows, W, H)));
    calls += votes.length;
    for (const k of p) {
      let bi = 0, bd = Infinity;
      pts.forEach((q, i) => {
        const d = Math.hypot(col(k) - col(q), row(k) - row(q));
        if (d < bd) (bd = d), (bi = i);
      });
      out[k] = votes[bi]! > 0.5 ? 1 : 0;
    }
  }));
  return { open: out, agree: agree / sam.length, patches: settled, calls };
}

/** A picture point and what is there. */
export interface Spot {
  x: number;
  y: number;
  label: string;
  /** The building it belongs to (1-based), for entrances. */
  building?: number;
}

/**
 * Buildings (SAM's building pieces of 6 m² or more) and an entrance for each: a detected door on or by it, else the
 * open ground nearest the middle of its lower side (the side facing the viewer). Spots are picture px.
 */
export function entrances(d: Detected, walk: Uint8Array, g: Grid, W: number, H: number): Spot[] {
  const kx = W / g.cols, ky = H / g.rows;
  const isBuilding = (i: number) => d.classes[d.cls[i]!]?.kind === 'building';
  const pieces = components(g, isBuilding).filter((p) => p.length * CELL * CELL >= 6);
  const nearestWalk = (cx: number, cy: number, maxCells: number): [number, number] | null => {
    let best: [number, number] | null = null, bd = Infinity;
    for (let r = Math.max(0, Math.floor(cy - maxCells)); r <= Math.min(g.rows - 1, Math.ceil(cy + maxCells)); r++)
      for (let c = Math.max(0, Math.floor(cx - maxCells)); c <= Math.min(g.cols - 1, Math.ceil(cx + maxCells)); c++) {
        if (!walk[r * g.cols + c]) continue;
        const dd = Math.hypot(c - cx, r - cy);
        if (dd < bd && dd <= maxCells) (bd = dd), (best = [c, r]);
      }
    return best;
  };
  const out: Spot[] = [];
  pieces.forEach((p, bi) => {
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const k of p) (c0 = Math.min(c0, k % g.cols)), (c1 = Math.max(c1, k % g.cols)), (r0 = Math.min(r0, Math.floor(k / g.cols))), (r1 = Math.max(r1, Math.floor(k / g.cols)));
    const margin = 1 / CELL;
    const doors = d.doors.filter((q) => q.x / kx >= c0 - margin && q.x / kx <= c1 + 1 + margin && q.y / ky >= r0 - margin && q.y / ky <= r1 + 1 + margin);
    const tries = doors.length ? doors.map((q) => [q.x / kx, q.y / ky] as const) : [[(c0 + c1) / 2, r1 + 1] as const];
    for (const [cx, cy] of tries) {
      const at = nearestWalk(cx, cy, 3 / CELL);
      if (!at) continue;
      const x = (at[0] + 0.5) * kx, y = (at[1] + 0.5) * ky;
      if (out.some((o) => o.building === bi + 1 && Math.hypot(o.x - x, o.y - y) < kx / CELL)) continue;
      out.push({ x, y, label: doors.length ? 'door' : 'front of a building', building: bi + 1 });
    }
  });
  return out;
}

/** Landmarks: the largest props and trees with walkable ground within 1.5 m (the spot is on that ground). */
export function landmarks(d: Detected, walk: Uint8Array, g: Grid, W: number, H: number, max = 10): Spot[] {
  const kx = W / g.cols, ky = H / g.rows;
  const out: { spot: Spot; size: number }[] = [];
  d.classes.forEach((c, ci) => {
    if (c.kind !== 'prop' && c.kind !== 'tree' && c.kind !== 'water') return;
    for (const p of components(g, (i) => d.cls[i] === ci)) {
      if (p.length * CELL * CELL < 0.5) continue;
      let sx = 0, sy = 0;
      for (const k of p) (sx += k % g.cols), (sy += Math.floor(k / g.cols));
      const mx = sx / p.length, my = sy / p.length, R = 1.5 / CELL + Math.sqrt(p.length / Math.PI);
      let best: [number, number] | null = null, bd = Infinity;
      for (let r = Math.max(0, Math.floor(my - R)); r <= Math.min(g.rows - 1, Math.ceil(my + R)); r++)
        for (let col = Math.max(0, Math.floor(mx - R)); col <= Math.min(g.cols - 1, Math.ceil(mx + R)); col++) {
          if (!walk[r * g.cols + col]) continue;
          const dd = Math.hypot(col - mx, r - my);
          if (dd < bd && dd <= R) (bd = dd), (best = [col, r]);
        }
      if (best) out.push({ spot: { x: (best[0] + 0.5) * kx, y: (best[1] + 0.5) * ky, label: c.term }, size: p.length });
    }
  });
  return out.sort((a, b) => b.size - a.size).slice(0, max).map((o) => o.spot);
}
