/**
 * Reading a painted place back: Luna names what to look for, SAM 3 finds it, MoGe 2 tells floor from walls, and the
 * masks decide where people can walk and see. Then Luna checks the result and decides where everything goes.
 *
 * Masks are worked at half the painting's resolution. See docs/painted-zones.md for why each rule exists.
 */
import type { ZoneKind } from '@gd/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service';
import { depth, normals, segment } from './comfy';

/** What a place must hold. Ids are the world's own (feature, NPC ids); placement answers per id. */
export interface PlaceNeeds {
  name: string;
  description: string;
  buildings: { id: string; name: string; purpose: string }[];
  /** Ways out. `into`: a way through something in the picture (a cave mouth, stairs down, a room's door), not out across the edge. */
  exits: { id: string; to: string; into?: boolean }[];
  people: { id: string; name: string; title: string; role: string }[];
  things: { id: string; what: string }[];
}

function needsText(n: Pick<PlaceNeeds, 'buildings' | 'exits'>): string {
  const lines: string[] = [];
  if (n.buildings.length) lines.push(`Buildings that can be entered: ${n.buildings.map((b) => `${b.name} (${b.purpose})`).join('; ')}.`);
  if (n.exits.length) lines.push(`Ways out: ${n.exits.map((e) => e.to).join('; ')}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------- Luna reads

const ReadSchema = z.object({
  usable: z.boolean().describe('False only if this picture cannot work as a game level for this kind of place: no clear ground to walk on, not a view from above, a model or diorama rather than a level, or plainly another kind of place (a street for a cave). Details that differ from the description do not matter'),
  problems: z.array(z.string().max(200)).max(5).describe('What stops it working as this place, if anything (not details that differ from the description)'),
  walkable: z.array(z.string().max(40)).min(1).max(5).describe('Short names of the surfaces people walk on, as an object detector would call them: "cobblestone street", "wooden pier", "carpet", "dirt path", "grass"'),
  connectors: z.array(z.string().max(40)).max(4).describe('Sloping surfaces people walk on between levels: "stone stairs", "wooden ramp", "bridge". Empty if none'),
  notWalkable: z.array(z.string().max(40)).max(5).describe('Surfaces that might be mistaken for ground but are not walkable: "water", "roof", "table", "lava"'),
  structure: z.string().max(40).describe('What the enterable buildings or rooms look like from outside, as one short noun: "house", "shop", "hut". Empty if there are none'),
  entrance: z.string().max(40).describe('What the entrances look like, as one short noun: "door", "doorway", "cave mouth". Empty if there are none'),
  scale: z.object({ object: z.string().max(40), metres: z.number().min(0.3).max(12) }).describe('A common object that appears several times with a well-known real height, and that height (door 2.1, office chair 1.0, barrel 1.0)'),
  landmarks: z.array(z.string().max(40)).max(10).describe('Distinctive things worth placing people or features at (a fountain, a forge, a fish stall, a campfire, a reception desk), as short detector names'),
});
export type PaintingRead = z.infer<typeof ReadSchema>;

const view = (png: Buffer) => sharp(png).resize({ width: 1600 }).jpeg({ quality: 86 }).toBuffer();

export async function readPainting(png: Buffer, n: Pick<PlaceNeeds, 'name' | 'description' | 'buildings' | 'exits'>): Promise<PaintingRead> {
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG. Each place is one painting; you work out how the game can use it. Judge only what you see.',
    prompt: `This painting is meant to be ${n.name}: ${n.description}
${needsText(n)}
An object detector (SAM 3) will find things in it from short English names you give. Name things exactly as they look in the picture: start with the main floor or ground people walk on, by its actual material (wooden planks, cobblestones, packed dirt), then every other surface people walk on. Judge it as a level: say whether people could play this place in it. The game adds its own people, creatures and objects, and the painter was told to leave some things out, so a missing or different detail is never a reason to reject it.`,
    schema: ReadSchema,
    name: 'painting_read',
    images: [await view(png)],
    maxTokens: 1500,
  });
}

const CheckSchema = z.object({
  correct: z.boolean().describe('True if the colouring is right everywhere that matters for walking around'),
  mistakes: z.array(z.string().max(200)).max(6).describe('Each wrongly coloured area, in plain words'),
  addWalkable: z.array(z.string().max(40)).max(4).describe('Detector names of flat surfaces people walk on that are not green but should be'),
  addConnectors: z.array(z.string().max(40)).max(4).describe('Detector names of stairs, ramps or bridges that are not green but should be'),
  addBlocked: z.array(z.string().max(40)).max(4).describe('Detector names of things coloured green that people cannot walk on (water, roofs, boats, furniture)'),
  dropBlocked: z.array(z.string().max(40)).max(4).describe('Names from the blocked list whose red covers ground people walk on (the detector matched them to the wrong thing): copy them exactly'),
  dropWalkable: z.array(z.string().max(40)).max(4).describe('Names from the walkable or connector lists whose green covers things nobody walks on: copy them exactly'),
});
export type ReadingCheck = z.infer<typeof CheckSchema>;

/**
 * Luna checks the walkability colouring and names what to look for differently (in detector terms). `model`
 * asks a stronger model instead; `failure` tells it why the game cannot use the reading as it stands.
 */
export async function checkReading(png: Buffer, coloured: Buffer, read: PaintingRead, opts: { model?: string; failure?: string } = {}): Promise<ReadingCheck> {
  const used = new Set([...read.walkable, ...read.connectors, ...read.notWalkable].map((t) => t.toLowerCase()));
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG checking which parts of a painted level the game lets people walk on. Judge only what you see.',
    prompt: `Image 1 is the level. Image 2 is the same level coloured by the game: green = people can walk there; yellow = walkable surface too narrow or cut off from the rest; red = blocked; blue = not flat (walls, slopes, objects); uncoloured = not recognised.
It was found by looking for walkable: ${read.walkable.join(', ')}; connectors: ${read.connectors.join(', ') || 'none'}; blocked: ${read.notWalkable.join(', ')}.
${opts.failure ? `The game cannot use the level as coloured: ${opts.failure}. Find what the detector misses or misreads so that this is fixed.
` : ''}Is the colouring right for walking around this level? Look first at the main floor or ground: if much of it is not green (uncoloured, red or blue), that is the biggest mistake, so name that floor by how it looks (its material and colour). Ignore small fringes along edges and objects. Name only real mistakes: walkable ground that is not green (a street, a stair, a bridge cut off) or green where nobody can walk (water, roofs, boats, furniture).
When a whole surface people walk on is red, the detector took it for one of the blocked names: drop that name (a road read as "puddles" means dropping "puddles"). The same goes for a walkable name whose green spreads over walls or water.
For each mistake name the cause, not the symptom: an area that is yellow (cut off) is usually missing the thing that joins it to the rest, so name that (a doorway, a gap in a wall, the end of a bridge, a ramp), not the area itself. Never suggest a name already in the lists above (the detector already looked for it): if such a surface is still wrong, describe it differently by how it looks. Give short everyday names an object detector would understand ("stone stairs", "wooden boat", "water").`,
    schema: CheckSchema,
    name: 'reading_check',
    images: [await view(png), await view(coloured)],
    maxTokens: 1200,
    model: opts.model,
    validate: (c) => {
      const again = [...c.addWalkable, ...c.addConnectors, ...c.addBlocked].filter((t) => used.has(t.toLowerCase()));
      if (again.length) return `Already looked for: ${again.join(', ')}. Name what joins the cut-off area, or describe the surface differently.`;
      const unknown = [...c.dropBlocked, ...c.dropWalkable].filter((t) => !used.has(t.toLowerCase()));
      return unknown.length ? `Only names from the lists can be dropped; not: ${unknown.join(', ')}.` : null;
    },
  });
}

/** The read with a check's corrections applied. */
export function applyCheck(read: PaintingRead, c: ReadingCheck): PaintingRead {
  const edit = (a: string[], add: string[], drop: string[]) => [...new Set([...a, ...add])].filter((t) => !drop.some((d) => d.toLowerCase() === t.toLowerCase()));
  return {
    ...read,
    walkable: edit(read.walkable, c.addWalkable, c.dropWalkable),
    connectors: edit(read.connectors, c.addConnectors, c.dropWalkable),
    notWalkable: edit(read.notWalkable, c.addBlocked, c.dropBlocked),
  };
}

/** Whether a check changes what the detector looks for. */
export const checkChanges = (c: ReadingCheck) => c.addWalkable.length + c.addConnectors.length + c.addBlocked.length + c.dropBlocked.length + c.dropWalkable.length > 0;

/**
 * How far above the ground around it (in metres' worth of screen pixels of the floor's depth gradient; a scale
 * measured on the saved paintings, not true metres) a surface must be to count as a top: tabletops and counters
 * measure 2–3.3, floors and shores level with their surroundings at most 1.1. Measured in metres at the town
 * scale, whatever the place's own scale.
 */
const TOP_LIFT = 1.5;

/**
 * Krea paints each kind of place at a steady scale, in pixels per metre of height: a town or the wilds seen from
 * afar, a dungeon closer, a single room closest (doors measured 40–43, 90–120 and 87–135 on the saved paintings).
 */
export const TYPICAL_PX_PER_METRE: Record<ZoneKind, number> = { town: 41, wilderness: 41, dungeon: 100, interior: 120 };

// ---------------------------------------------------------------------------------------------- masks

/** A 0/1 raster of w × h. */
export type Mask = Uint8Array;

/**
 * Chamfer distance (px) from each set pixel to the nearest unset one; 0 on unset pixels. With `sy` 2, a vertical
 * pixel counts double: distances on the ground (a ground circle is a 2:1 ellipse in the isometric picture).
 */
function distanceToEdge(m: Mask, w: number, h: number, sy = 1): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? 1e9 : 0;
  const DD = Math.hypot(1, sy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + sy);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + DD);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + DD);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + sy);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + DD);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + DD);
      }
      d[i] = v;
    }
  return d;
}

const invert = (m: Mask) => m.map((v) => (v ? 0 : 1));

/** Opening: shrink by r, then grow by r (removes specks and threads thinner than 2r). */
function openMask(m: Mask, r: number, w: number, h: number): Mask {
  const core = Uint8Array.from(distanceToEdge(m, w, h), (v) => (v > r ? 1 : 0));
  const dOut = distanceToEdge(invert(core), w, h);
  return m.map((v, i) => (core[i] || (dOut[i]! <= r && v) ? 1 : 0));
}

/** Closing: grow by r, then shrink by r (fills gaps narrower than 2r). */
function closeMask(m: Mask, r: number, w: number, h: number): Mask {
  const dOut = distanceToEdge(invert(m), w, h);
  const grown = m.map((v, i) => (v || dOut[i]! <= r ? 1 : 0));
  const dIn = distanceToEdge(grown, w, h);
  return m.map((v, i) => (dIn[i]! > r ? 1 : v));
}

/** Connected components (4-neighbour): labels and sizes (index 0 unused). */
function components(m: Mask, w: number, h: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(w * h);
  const sizes = [0];
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || label[s]) continue;
    const id = sizes.length;
    let n = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && m[q] && !label[q]) {
          label[q] = id;
          stack.push(q);
        }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-9;
    for (let k = c; k < 4; k++) m[c]![k]! /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row) => row[3]!);
}

/**
 * The floor's normal as a smooth field n(x, y) = a + b·x + c·y, fitted over the ground (MoGe assumes a perspective
 * camera, so the floor normal drifts across an isometric picture), refitted without pixels more than 30° off. It
 * starts from the commonest facing on the ground, not the mean: a "ship deck" mask also covering the hull's sides
 * pulled the mean so far off that the deck itself was rejected as not flat.
 */
function floorField(ground: Mask, blocked: Mask, vec: (i: number) => [number, number, number], w: number, h: number) {
  const bins = new Map<number, { n: number; s: [number, number, number] }>();
  for (let i = 0; i < w * h; i += 3) {
    if (!ground[i] || blocked[i]) continue;
    const n = vec(i), key = Math.round(n[0] * 8) * 100 + Math.round(n[1] * 8);
    const b = bins.get(key) ?? { n: 0, s: [0, 0, 0] };
    b.n++, (b.s[0] += n[0]), (b.s[1] += n[1]), (b.s[2] += n[2]);
    bins.set(key, b);
  }
  const mode = [...bins.values()].sort((a, b) => b.n - a.n)[0]?.s ?? [0, 0, 1];
  let coef: number[][] = mode.map((m) => [m, 0, 0]);
  const at = (x: number, y: number): [number, number, number] => {
    const u = x / w - 0.5, v = y / h - 0.5;
    const n = coef.map((c) => c[0]! + c[1]! * u + c[2]! * v) as [number, number, number];
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const cos30 = Math.cos(Math.PI / 6);
  for (let pass = 0; pass < 3; pass++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < w * h; i += 3) {
      if (!ground[i] || blocked[i]) continue;
      const x = i % w, y = (i / w) | 0;
      const n = vec(i);
      const f = at(x, y);
      if (n[0] * f[0] + n[1] * f[1] + n[2] * f[2] < cos30) continue;
      const b = [1, x / w - 0.5, y / h - 0.5];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r]![c]! += b[r]! * b[c]!;
        for (let k = 0; k < 3; k++) B[k]![r]! += n[k]! * b[r]!;
      }
    }
    coef = B.map((rhs) => solve3(A, rhs));
  }
  return at;
}

/**
 * Height above the floor, from MoGe's disparity: what is left after a plane fitted over the walkable detections
 * (refitted without outliers), in screen pixels of the floor's own disparity gradient.
 */
function liftOf(disp: Buffer, floors: { mask: Mask }[], w: number, h: number): Float32Array {
  const N = w * h;
  const on = new Uint8Array(N);
  for (const f of floors) for (let i = 0; i < N; i++) if (f.mask[i]) on[i] = 1;
  let coef = [0, 0, 0];
  const fit = (i: number) => coef[0]! + coef[1]! * (i % w) + coef[2]! * ((i / w) | 0);
  let cut = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    for (let i = 0; i < N; i += 3) {
      if (!on[i] || Math.abs(disp[i]! - fit(i)) > cut) continue;
      const b = [1, i % w, (i / w) | 0];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r]![c]! += b[r]! * b[c]!;
        B[r]! += disp[i]! * b[r]!;
      }
    }
    coef = solve3(A, B);
    const res: number[] = [];
    for (let i = 0; i < N; i += 7) if (on[i]) res.push(Math.abs(disp[i]! - fit(i)));
    res.sort((a, b) => a - b);
    cut = Math.max(2, 2.5 * (res[res.length >> 1] ?? 0));
  }
  const g = Math.hypot(coef[1]!, coef[2]!) || 1e-3;
  return Float32Array.from({ length: N }, (_, i) => (disp[i]! - fit(i)) / g);
}

function maskBox(m: Mask, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

type Box = { x: number; y: number; w: number; h: number; area: number };

/**
 * SAM over the picture. SAM looks at about 1000 px, so a large canvas is read in painting-sized windows overlapping
 * by half: object masks are mapped back onto the analysis raster, duplicate boxes from overlaps merged.
 */
function detector(png: Buffer, W: number, H: number, aw: number, ah: number) {
  const WIN_W = 2400, WIN_H = 1216;
  const starts = (size: number, win: number) => {
    if (size <= win) return [0];
    const out: number[] = [];
    for (let p = 0; p + win < size; p += win / 2) out.push(p);
    out.push(size - win);
    return out;
  };
  const ww = Math.min(W, WIN_W), wh = Math.min(H, WIN_H);
  const wins = starts(H, wh).flatMap((y) => starts(W, ww).map((x) => ({ x, y })));
  const crops = Promise.all(wins.map((r) => (wins.length === 1 ? png : sharp(png).extract({ left: r.x, top: r.y, width: ww, height: wh }).png().toBuffer())));
  const sx = aw / W, sy = ah / H;
  const each = async (term: string, max: number, fn: (raw: Buffer, w: number, h: number, ox: number, oy: number) => void) => {
    const cs = await crops;
    for (let k = 0; k < wins.length; k++) {
      const w = Math.round(ww * sx), h = Math.round(wh * sy), ox = Math.round(wins[k]!.x * sx), oy = Math.round(wins[k]!.y * sy);
      for (const m of await segment(cs[k]!, `${term}:${max}`)) fn(await sharp(m).resize(w, h, { kernel: 'nearest' }).extractChannel(0).raw().toBuffer(), w, h, ox, oy);
    }
  };
  return {
    /** Every detected object as its own mask, with its area. */
    async objects(term: string, max: number): Promise<{ mask: Mask; area: number }[]> {
      const out: { mask: Mask; area: number }[] = [];
      await each(term, max, (raw, w, h, ox, oy) => {
        const m = new Uint8Array(aw * ah);
        let area = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            if (raw[y * w + x]! > 127 && oy + y < ah && ox + x < aw) {
              m[(oy + y) * aw + ox + x] = 1;
              area++;
            }
        if (area) out.push({ mask: m, area });
      });
      return out;
    },
    async boxes(term: string, max: number): Promise<Box[]> {
      const boxes: Box[] = [];
      await each(term, max, (raw, w, h, ox, oy) => {
        let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (raw[y * w + x]! <= 127) continue;
            area++;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        if (x1 >= 0) boxes.push({ x: ox + x0, y: oy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
      });
      boxes.sort((a, b) => b.area - a.area);
      const kept: Box[] = [];
      for (const b of boxes) {
        const dup = kept.some((k) => Math.max(0, Math.min(k.x + k.w, b.x + b.w) - Math.max(k.x, b.x)) * Math.max(0, Math.min(k.y + k.h, b.y + b.h) - Math.max(k.y, b.y)) > 0.5 * b.w * b.h);
        if (!dup) kept.push(b);
      }
      return kept;
    },
  };
}

// ---------------------------------------------------------------------------------------------- analysis

/** A point of interest, in painting pixels. */
export interface Spot {
  x: number;
  y: number;
  label: string;
  /** Entrances: which detected structure the door belongs to. */
  building?: number;
}

export interface Reading {
  read: PaintingRead;
  /** Painting size, analysis raster size. */
  width: number;
  height: number;
  aw: number;
  ah: number;
  /** Where a character's centre may stand (clearance included), joined through doorway portals; largest region only. */
  walk: Mask;
  /** Where one can see across (floor and other flat things). */
  sight: Mask;
  /** Connectors (stairs, ramps, bridges) and the raw ground, blocked and flat masks (for the colouring). */
  link: Mask;
  ground: Mask;
  blocked: Mask;
  flat: Mask;
  doors: Spot[];
  landmarks: Spot[];
  /** Where the walkable ground meets the picture's edge. */
  edges: Spot[];
  portals: number;
  /** Painting pixels per metre of height (from the scale object, or the typical scale when it was not found). */
  pxPerMetre: number;
  /** Walkable ground in square metres (estimated with the scale). */
  area: number;
  /** Why each part came out as it did (for diagnosis: cli/readpeek.ts). */
  trace: ReadingTrace;
}

/** One SAM detection and what became of it. Boxes are on the analysis raster. */
export interface TracedDetection {
  term: string;
  kind: 'walkable' | 'connector' | 'blocked';
  area: number;
  box: { x: number; y: number; w: number; h: number };
  /** scene: a connector covering a quarter of the picture, ignored; top: a blocker's top, never wins; else how much
   * of it won its pixels (0–1). */
  fate: 'scene' | 'top' | number;
  /** Connectors: the share sloping between floor and wall (stairs and ramps have at least a quarter). */
  slope?: number;
}

export interface ReadingTrace {
  detections: TracedDetection[];
  /** Height above the floor, in metres of the reading's own scale (positive is raised). */
  lift: Float32Array;
  /** Stairs and ramps, and the enterable structures' outlines. */
  ramp: Mask;
  structures: Mask;
  /** Entrance boxes and what each joined: a portal from the floor at y1 up to the floor at y0. */
  entrances: { box: { x: number; y: number; w: number; h: number }; portal?: { x: number; y0: number; y1: number } }[];
  /** The scale as measured (0 when not found), before the typical-scale fallback. */
  measuredPxPerMetre: number;
}

export async function analyse(png: Buffer, read: PaintingRead, kind: ZoneKind): Promise<Reading> {
  const meta = await sharp(png).metadata();
  const W = meta.width!, H = meta.height!;
  const aw = Math.round(W / 2), ah = Math.round(H / 2), S = W / aw, N = aw * ah;
  const det = detector(png, W, H, aw, ah);

  // Every detected object votes for its class; where detections overlap the most specific (smallest) one wins: a pier
  // mask spanning the water between its arms loses to the water, a "water" mask spread over a wet street to the street.
  // A walkable detection lying mostly inside a blocker and clearly above the ground around that blocker (MoGe's
  // depth) is its top: a tabletop's planks inside the table never win there. A floor inside a "stone walls" mask
  // spanning the room, or a shore inside a spread "water" mask, is level with its surroundings and still wins. A
  // connector detection covering a quarter of the picture is the detector matching the whole scene (a "stone
  // bridge" that is the whole mine), not a way across something.
  const WALK = 1, LINK = 2, BLOCK = 3;
  const scene = (area: number) => area >= N / 4;
  const found: { mask: Mask; area: number; c: number; t: TracedDetection }[] = [];
  const traced: TracedDetection[] = [];
  const linkTerms = read.connectors;
  for (const [terms, c] of [[read.walkable.filter((t) => !linkTerms.includes(t)), WALK], [linkTerms, LINK], [read.notWalkable, BLOCK]] as const)
    for (const term of terms)
      for (const o of await det.objects(term, 20)) {
        const t: TracedDetection = { term, kind: (['', 'walkable', 'connector', 'blocked'] as const)[c], area: o.area, box: maskBox(o.mask, aw, ah), fate: 0 };
        traced.push(t);
        if (c === LINK && scene(o.area)) t.fate = 'scene';
        else found.push({ ...o, c, t });
      }
  const blockers = found.filter((o) => o.c === BLOCK);
  const lift = liftOf(await sharp(await depth(png)).resize(aw, ah).extractChannel(0).raw().toBuffer(), found.filter((o) => o.c !== BLOCK), aw, ah);
  const median = (pick: (i: number) => boolean) => {
    const v: number[] = [];
    for (let i = 0; i < N; i += 2) if (pick(i)) v.push(lift[i]!);
    return v.length ? v.sort((a, b) => a - b)[v.length >> 1]! : 0;
  };
  const onTop = (o: (typeof found)[number]) => {
    if (o.c !== WALK) return false;
    for (const b of blockers) {
      if (b.area <= o.area) continue;
      let inside = 0;
      for (let i = 0; i < N; i++) if (o.mask[i] && b.mask[i]) inside++;
      if (inside < 0.75 * o.area) continue;
      const around = distanceToEdge(invert(b.mask), aw, ah);
      if (median((i) => !!o.mask[i]) - median((i) => !b.mask[i] && around[i]! <= 12) > TOP_LIFT * (TYPICAL_PX_PER_METRE.town / S)) return true;
    }
    return false;
  };
  const cls = new Uint8Array(N);
  const best = new Float64Array(N).fill(Infinity);
  const winner = new Int32Array(N).fill(-1);
  found.forEach((o, k) => {
    if (onTop(o)) return void (o.t.fate = 'top');
    for (let i = 0; i < N; i++) if (o.mask[i] && o.area < best[i]!) (best[i] = o.area), (cls[i] = o.c), (winner[i] = k);
  });
  const won = new Array<number>(found.length).fill(0);
  for (let i = 0; i < N; i++) if (winner[i]! >= 0) won[winner[i]!]!++;
  found.forEach((o, k) => o.t.fate !== 'top' && (o.t.fate = won[k]! / o.area));
  const linkFound = found.filter((o) => o.c === LINK), links = linkFound.map((o) => o.mask);
  // A connector exists to cross an obstacle: where it overlaps a blocker (a bridge's masonry, the water under it),
  // the connector wins whatever the sizes.
  for (const m of links) for (let i = 0; i < N; i++) if (m[i] && cls[i] === BLOCK) cls[i] = LINK;
  const ground = closeMask(cls.map((c) => (c === WALK || c === LINK ? 1 : 0)), 3, aw, ah);
  const link = cls.map((c) => (c === LINK ? 1 : 0));
  const blocked = cls.map((c) => (c === BLOCK ? 1 : 0));

  // Walkable ground is flat and faces up: MoGe's normals tell floor from walls, trunks and brambles whatever they
  // look like. Rough surfaces have scattered flat pixels (opening removes them); thin seams such as plank joints are
  // closed so they do not slice a street apart.
  const nr = await sharp(await normals(png)).resize(aw, ah).removeAlpha().raw().toBuffer();
  const vec = (i: number): [number, number, number] => {
    const v: [number, number, number] = [nr[i * 3]! / 127.5 - 1, nr[i * 3 + 1]! / 127.5 - 1, nr[i * 3 + 2]! / 127.5 - 1];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const field = floorField(ground, blocked, vec, aw, ah);
  const COS = Math.cos((20 * Math.PI) / 180), STEEP = Math.cos((70 * Math.PI) / 180);
  const flatRaw = new Uint8Array(N), gentleRaw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = vec(i), f = field(i % aw, (i / aw) | 0);
    const d = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    flatRaw[i] = d >= COS ? 1 : 0;
    gentleRaw[i] = d >= STEEP ? 1 : 0;
  }
  const flat = closeMask(openMask(flatRaw, 2, aw, ah), 4, aw, ah);
  // Connectors slope by nature, so they are walkable without being flat; but never as steep as a wall (a connector
  // name the detector matched to a whole building must not make its walls walkable). Stair risers between gentle
  // treads are closed over.
  const gentle = closeMask(gentleRaw, 4, aw, ah);
  const open = Uint8Array.from({ length: N }, (_, i) => (ground[i] && !blocked[i] && (flat[i] || (link[i] && gentle[i])) ? 1 : 0));

  // Scale: the median height of the reference object.
  const heights = (await det.boxes(read.scale.object, 30)).filter((b) => b.area > 8).map((b) => b.h * S).sort((a, b) => a - b);
  const measured = heights.length ? heights[heights.length >> 1]! / read.scale.metres : 0;
  // Krea paints at a steady scale; a measurement far from it means the detector matched something else (a whole
  // archway for a door, the top of a counter for its height), which would change every distance in the place.
  const typical = TYPICAL_PX_PER_METRE[kind];
  const pxPerMetre = measured > typical * 0.75 && measured < typical * 1.33 ? measured : typical;
  const metre = pxPerMetre / S;

  // The approach onto a connector slopes too (a bank rising to a bridge, a stair landing): ground within a metre of a
  // connector is walkable, and so are gaps between a connector and the ground it meets that no detection covers.
  // Blockers thinner than half a metre right by a connector are detection slivers, not obstacles.
  {
    const dLink = distanceToEdge(invert(link), aw, ah);
    const bridged = closeMask(open, Math.ceil(metre), aw, ah);
    const solidBlock = openMask(blocked, Math.max(1, Math.round(metre / 4)), aw, ah);
    for (let i = 0; i < N; i++) {
      if (open[i] || dLink[i]! > metre) continue;
      const sliver = blocked[i] && !solidBlock[i];
      if ((!blocked[i] || sliver) && (ground[i] || bridged[i] || sliver)) open[i] = 1;
    }
  }

  // Within an enterable building only flat floor is walkable: its walls stay solid even where a connector name was
  // matched to them, while a lane the building's outline overlaps stays open (people go in through the doors, which
  // are joined as portals below).
  // Stairs and ramps (connector detections a good share of which slopes between floor and wall) keep their slope
  // inside too: a mine's stairs lie within the "mine tunnel". A doorway or threshold is floor and frame, nearly
  // nothing in between, so it adds only its floor.
  const ramp = new Uint8Array(N);
  for (const { mask: m, t } of linkFound) {
    let n = 0, mid = 0;
    for (let i = 0; i < N; i++) if (m[i]) n++, (mid += gentleRaw[i]! && !flatRaw[i] ? 1 : 0);
    t.slope = mid / (n || 1);
    if (mid >= 0.25 * n) for (let i = 0; i < N; i++) if (m[i]) ramp[i] = 1;
  }
  const structures = read.structure ? await det.objects(read.structure, 40) : [];
  const inStructure = new Uint8Array(N);
  for (const { mask } of structures) for (let i = 0; i < N; i++) if (mask[i]) (inStructure[i] = 1), !flat[i] && !ramp[i] && (open[i] = 0);

  // Clearance: where a character's centre may stand (feet about 0.35 m across from the centre).
  // Measured on the ground: across the picture a ground metre is about as many pixels as a metre of height.
  const radius = Math.max(2, 0.35 * metre);
  const dist = distanceToEdge(open, aw, ah, 2);
  const clear = Uint8Array.from({ length: N }, (_, i) => (dist[i]! >= radius ? 1 : 0));
  const { label, sizes } = components(clear, aw, ah);

  // Portals: a doorway joins the floor at its foot to the floor beyond the wall (looked for straight up, within 4 m;
  // a threshold running off the picture's bottom is looked for inside the doorway's lower half),
  // as in most isometric games where the wall hides the floor running through. The passage is carved into the walk
  // mask so walking and pathfinding use it. A door into a building has no floor beyond it, so nothing is joined.
  const parent = sizes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const passages: { x: number; y0: number; y1: number; half: number }[] = [];
  const entranceBoxes = read.entrance ? await det.boxes(read.entrance, 60) : [];
  const entrances: ReadingTrace['entrances'] = [];
  for (const b of entranceBoxes) {
    const traced = { box: { x: b.x, y: b.y, w: b.w, h: b.h } } as ReadingTrace['entrances'][number];
    entrances.push(traced);
    const cx = Math.round(b.x + b.w / 2);
    const regionAt = (y0: number, dir: 1 | -1, reach = Math.round(4 * metre)): [number, number] => {
      for (let d = 0; d <= reach; d++) {
        const y = y0 + d * dir;
        if (y < 0 || y >= ah) return [0, y];
        const l = label[y * aw + cx]!;
        if (l) return [l, y];
      }
      return [0, 0];
    };
    let [a, ya] = regionAt(b.y + b.h, 1);
    if (!a && ya >= ah) [a, ya] = regionAt(b.y + b.h - 1, -1, Math.round(b.h / 2));
    const [c, yc] = regionAt(b.y, -1);
    if (a && c && find(a) !== find(c)) {
      parent[find(a)] = find(c);
      // As wide as the doorway (at most 2 m): a thin line through it falls between the navigation grid's cells.
      passages.push({ ...(traced.portal = { x: cx, y0: yc, y1: ya }), half: Math.max(radius / 2, Math.min(b.w / 2, metre)) });
    }
  }
  const total = new Map<number, number>();
  for (let l = 1; l < sizes.length; l++) total.set(find(l), (total.get(find(l)) ?? 0) + sizes[l]!);
  const main = [...total.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const walk = Uint8Array.from({ length: N }, (_, i) => (main && label[i] && find(label[i]!) === main ? 1 : 0));
  // Each passage runs on a metre into the floor at both ends (where there is floor): touching the floor at a point
  // is a join in the painting but not once it is sampled onto the navigation grid's half-metre cells.
  for (const p of passages)
    for (let y = Math.max(0, Math.round(p.y0 - metre)); y <= Math.min(ah - 1, p.y1 + metre); y++)
      for (let x = Math.round(p.x - p.half); x <= p.x + p.half; x++) if (x >= 0 && x < aw && ((y >= p.y0 && y <= p.y1) || open[y * aw + x])) walk[y * aw + x] = 1;

  const sight = Uint8Array.from({ length: N }, (_, i) => (flat[i] || ground[i] ? 1 : 0));
  const near = (fx: number, fy: number, r: number) => {
    for (let y = Math.max(0, fy - r); y <= Math.min(ah - 1, fy + r); y++) for (let x = Math.max(0, fx - r); x <= Math.min(aw - 1, fx + r); x++) if (walk[y * aw + x]) return true;
    return false;
  };

  // Entrances whose foot is next to the walkable ground, grouped by the structure they sit on; doors closer than a
  // metre are one entrance seen twice.
  const doors: (Spot & { cx: number; cy: number })[] = [];
  for (const b of entranceBoxes) {
    if (b.area < 6 || !near(Math.round(b.x + b.w / 2), b.y + b.h - 1, Math.ceil(radius * 3))) continue;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (doors.some((d) => Math.hypot(d.cx - cx, d.cy - cy) < metre)) continue;
    doors.push({ x: Math.round(cx * S), y: Math.round((b.y + b.h) * S), label: read.entrance, cx, cy });
  }
  if (structures.length && doors.length) {
    const blds = structures;
    for (const d of doors) {
      const x = Math.round(d.cx), y = Math.round(d.cy);
      let bestB = -1, bd = Infinity;
      blds.forEach((b, j) => {
        for (let r = 0; r <= 12; r += 3)
          for (const [dx, dy] of r ? ([[r, 0], [-r, 0], [0, -r], [0, r]] as const) : ([[0, 0]] as const)) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < aw && yy < ah && b.mask[yy * aw + xx] && r < bd) (bd = r), (bestB = j);
          }
      });
      if (bestB >= 0) d.building = bestB + 1;
    }
  }

  // Landmarks people can reach (walkable ground within a metre of the landmark's foot).
  const landmarks: Spot[] = [];
  for (const term of read.landmarks)
    for (const b of await det.boxes(term, 6)) {
      const fx = Math.round(b.x + b.w / 2), fy = Math.min(ah - 1, b.y + b.h - 1);
      if (b.area >= 6 && near(fx, fy, Math.ceil(metre))) landmarks.push({ x: Math.round(fx * S), y: Math.round((b.y + b.h) * S), label: term });
    }

  // Ways out across the edge: runs of walkable ground along each border.
  const edges: Spot[] = [];
  const edge = (pts: [number, number][], side: string) => {
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length * S >= 48) {
        const m = run[run.length >> 1]!;
        edges.push({ x: Math.round(m[0] * S), y: Math.round(m[1] * S), label: side });
      }
      run = [];
    };
    for (const p of pts) walk[p[1] * aw + p[0]] ? run.push(p) : flush();
    flush();
  };
  edge(Array.from({ length: aw }, (_, x) => [x, 2]), 'top');
  edge(Array.from({ length: aw }, (_, x) => [x, ah - 3]), 'bottom');
  edge(Array.from({ length: ah }, (_, y) => [2, y]), 'left');
  edge(Array.from({ length: ah }, (_, y) => [aw - 3, y]), 'right');

  const walkPx = walk.reduce((s, v) => s + v, 0) * S * S;
  return {
    read, width: W, height: H, aw, ah, walk, sight, link, ground, blocked, flat,
    doors: doors.map(({ cx, cy, ...d }) => (void cx, void cy, d)), landmarks, edges, portals: passages.length,
    pxPerMetre, area: walkPx / Math.pow(pxPerMetre, 2),
    trace: { detections: traced, lift: lift.map((v) => v / metre), ramp, structures: inStructure, entrances, measuredPxPerMetre: measured },
  };
}

/** The painting coloured by the reading: green walkable, yellow cut off, blue not flat, red blocked. */
export async function colouring(png: Buffer, r: Reading, width = 1600): Promise<Buffer> {
  const rgba = Buffer.alloc(r.aw * r.ah * 4);
  for (let i = 0; i < r.aw * r.ah; i++) {
    if (r.walk[i]) rgba.set([40, 255, 90, 95], i * 4);
    else if (r.ground[i] && r.blocked[i]) rgba.set([255, 0, 200, 110], i * 4);
    else if (r.ground[i] && !r.flat[i]) rgba.set([60, 120, 255, 120], i * 4);
    else if (r.ground[i]) rgba.set([255, 210, 0, 90], i * 4);
    else if (r.blocked[i]) rgba.set([255, 40, 40, 80], i * 4);
  }
  const tint = await sharp(rgba, { raw: { width: r.aw, height: r.ah, channels: 4 } }).resize(r.width, r.height).png().toBuffer();
  const base = await sharp(png).composite([{ input: tint }]).png().toBuffer();
  return sharp(base).resize(width).jpeg({ quality: 86 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------- placement

/** A numbered spot Luna can choose: D entrance, E way out, L landmark, P open ground. */
export interface Candidate {
  id: string;
  x: number;
  y: number;
  what: string;
  building?: number;
}

/**
 * The spots: entrances, ways out and reachable landmarks, plus open ground spread evenly over the walkable area
 * (farthest-point sampling, never on stairs). Markers must not cover each other in the view Luna sees.
 */
export function candidates(r: Reading, open = 24): Candidate[] {
  const S = r.width / r.aw;
  const gap = (2.2 * r.width) / 55;
  const out: Candidate[] = [
    ...r.doors.map((d, i) => ({ id: `D${i + 1}`, x: d.x, y: d.y, what: `entrance (${d.label})${d.building ? `, building B${d.building}` : ''}`, building: d.building })),
    ...r.edges.map((e, i) => ({ id: `E${i + 1}`, x: e.x, y: e.y, what: `way out at the ${e.label} edge` })),
  ];
  let ln = 0;
  for (const l of r.landmarks) if (out.every((c) => Math.hypot(c.x - l.x, c.y - l.y) >= gap)) out.push({ id: `L${++ln}`, x: l.x, y: l.y, what: l.label });
  const pts: [number, number][] = [];
  for (let i = 0; i < r.walk.length; i += 37) if (r.walk[i] && !r.link[i]) pts.push([(i % r.aw) * S, ((i / r.aw) | 0) * S]);
  const dist = pts.map(([x, y]) => out.reduce((m, c) => Math.min(m, Math.hypot(x - c.x, y - c.y)), Infinity));
  for (let n = 1; n <= open && pts.length; n++) {
    let k = 0;
    for (let i = 1; i < pts.length; i++) if (dist[i]! > dist[k]!) k = i;
    if (dist[k]! < gap) break;
    const [x, y] = pts[k]!;
    out.push({ id: `P${n}`, x: Math.round(x), y: Math.round(y), what: 'open ground' });
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i]!, Math.hypot(pts[i]![0] - x, pts[i]![1] - y));
  }
  return out;
}

const SPOT_COLOUR: Record<string, string> = { D: '#ffd400', E: '#4db8ff', L: '#ff7ad9', P: '#ffffff' };

/** The painting with every candidate as a large labelled marker (sized for a downscaled view). */
export async function candidateView(png: Buffer, cands: Candidate[], width = 1600): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const k = width / meta.width!, h = Math.round(meta.height! * k), R = width / 55;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${cands
    .map((c) => {
      const fs = c.id.length > 2 ? R * 0.75 : R * 0.9;
      return `<g><circle cx="${c.x * k}" cy="${c.y * k}" r="${R}" fill="${SPOT_COLOUR[c.id[0]!] ?? '#fff'}" stroke="#000" stroke-width="${R / 7}"/><text x="${c.x * k}" y="${c.y * k + fs * 0.36}" font-size="${fs}" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#000">${c.id}</text></g>`;
    })
    .join('')}</svg>`;
  return sharp(png).resize(width).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}

const PlacementSchema = z.object({
  assign: z.array(z.object({ id: z.string(), spot: z.string(), why: z.string().max(160) })),
  problems: z.array(z.string().max(200)).max(5).describe('Anything the place needs that this painting cannot provide'),
});

export interface Placement {
  /** Need id → chosen candidate. */
  spots: Map<string, Candidate>;
  problems: string[];
}

/** Luna looks at the numbered spots and decides where every building, way out, person and thing goes. */
export async function place(png: Buffer, n: PlaceNeeds, cands: Candidate[]): Promise<Placement> {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const kind = (s: string) => s[0];
  const doorCount = cands.filter((c) => kind(c.id) === 'D').length;
  // Where a way out can go: the edge (E), or for a way through something in the picture a doorway or landmark (D, L);
  // when the painting has no such spot, the most fitting open ground will do.
  const has = (k: string) => cands.some((c) => kind(c.id) === k);
  const wayOut = (into?: boolean) => (into ? (has('D') || has('L') ? 'DL' : 'DLP') : has('E') ? 'E' : 'EDLP');
  const list = (title: string, items: { id: string; text: string }[]) => (items.length ? `${title}\n${items.map((i) => `  ${i.id}: ${i.text}`).join('\n')}\n` : '');
  const out = await genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG. Each place is one painting; you decide where the game puts things in it. Judge only what you see.',
    prompt: `This painting is ${n.name}: ${n.description}
The numbered circles are the spots the game can use: D = an entrance into a building or room, E = a way out at the edge of the picture, L = a landmark, P = open ground.
${cands.map((c) => `${c.id}: ${c.what}`).join('\n')}

Assign a spot to each of these, as a level designer would (answer with their ids):
${list('Buildings that can be entered (one D spot each, all different; entrances with the same B number were detected as one structure: use two of them only where the picture clearly shows separate units, never two doors of one house; a big building for an inn, a small one for a home):', n.buildings.map((b) => ({ id: b.id, text: `${b.name} (${b.purpose})` })))}${list('Ways out (all different spots, of the kinds in brackets; an E spot leaves across the edge, a D or L spot is a way in such as a door, a cave mouth or stairs down):', n.exits.map((e) => ({ id: e.id, text: `${e.into ? 'through' : 'to'} ${e.to} [${wayOut(e.into).split('').join('/')}]` })))}${list('People (near their work, home or a fitting landmark; never on a D or E spot; spread them out):', n.people.map((p) => ({ id: p.id, text: `${p.name}, ${p.title} (${p.role})` })))}${list('Things (an L or P spot that suits each):', n.things.map((t) => ({ id: t.id, text: t.what })))}If something cannot be placed sensibly, leave it out and say why in problems.`,
    schema: PlacementSchema,
    name: 'place_placement',
    images: [await candidateView(png, cands)],
    maxTokens: 3000,
    validate: (p) => {
      const errs: string[] = [];
      const need = new Map<string, 'b' | 'x' | 'p' | 't'>([...n.buildings.map((b) => [b.id, 'b'] as const), ...n.exits.map((e) => [e.id, 'x'] as const), ...n.people.map((x) => [x.id, 'p'] as const), ...n.things.map((t) => [t.id, 't'] as const)]);
      const used = new Map<string, string>();
      for (const a of p.assign) {
        const c = byId.get(a.spot), t = need.get(a.id);
        if (!t) errs.push(`${a.id} is not on the list`);
        else if (!c) errs.push(`${a.spot} is not one of the numbered spots`);
        else if (t === 'b' && kind(a.spot) !== 'D') errs.push(`building ${a.id} needs a D spot`);
        else if (t === 'x' && !wayOut(n.exits.find((e) => e.id === a.id)?.into).includes(kind(a.spot)!)) errs.push(`way out ${a.id} needs a ${wayOut(n.exits.find((e) => e.id === a.id)?.into).split('').join(' or ')} spot`);
        else if ((t === 'p' || t === 't') && /[DE]/.test(kind(a.spot)!)) errs.push(`${a.id} cannot stand on an entrance or way out`);
        if ((t === 'b' || t === 'x') && used.has(a.spot)) errs.push(`${a.id} and ${used.get(a.spot)} share ${a.spot}`);
        if (t === 'b' || t === 'x') used.set(a.spot, a.id);
      }
      const placed = new Set(p.assign.map((a) => a.id));
      const exits = n.exits.filter((e) => !placed.has(e.id));
      if (exits.length) errs.push(`every way out needs a spot; missing: ${exits.map((e) => e.id).join(', ')}`);
      const buildings = n.buildings.filter((b) => placed.has(b.id)).length;
      if (buildings < Math.min(n.buildings.length, doorCount)) errs.push(`place every building there is an entrance for (${Math.min(n.buildings.length, doorCount)})`);
      return errs.length ? errs.slice(0, 6).join('; ') : null;
    },
  });
  return { spots: new Map(out.assign.map((a) => [a.id, byId.get(a.spot)!])), problems: out.problems };
}
