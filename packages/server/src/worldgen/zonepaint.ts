/**
 * Painted zones (prototype): Qwen paints a whole place from a prompt over an invisible isometric grid, then the
 * place is read back from the painting. Luna names what to look for, SAM 3 finds it (walkable ground, entrances,
 * landmarks, a scale reference), and the masks decide where people can walk. No tile grid anywhere.
 */
import sharp from 'sharp';
import { z } from 'zod';
import type { WorldDefinition, ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { edit, freeGpu, geometry, segment } from './comfy';

/** Painting size (multiples of 32, about 2.9 MP) and the analysis size (half). */
export const PW = 2400;
export const PH = 1216;
// The picture being analysed (a single painting or a whole outpainted canvas) and its analysis size (half).
let IW = PW;
let IH = PH;
let AW = PW / 2;
let AH = PH / 2;
function useSize(w: number, h: number) {
  IW = w;
  IH = h;
  AW = Math.round(w / 2);
  AH = Math.round(h / 2);
}
/** Game pixels per metre: characters are drawn 82 px tall (about 1.75 m). */
const GAME_PX_PER_M = 82 / 1.75;

// ---------------------------------------------------------------------------------------------- what a place needs

export interface ZoneNeeds {
  buildings: { name: string; purpose: string }[];
  exits: { to: string; dir?: string }[];
  npcs: { name: string; role: string; title: string }[];
  features: string[];
}

export function needsOf(w: WorldDefinition, z: ZoneDef): ZoneNeeds {
  const zoneName = (id?: string) => w.zones.find((x) => x.id === id)?.name ?? 'elsewhere';
  const interiors = w.zones.filter((x) => x.parentZoneId === z.id);
  return {
    buildings: interiors.map((i) => ({ name: i.name, purpose: i.buildingPurpose ?? i.description.slice(0, 80) })),
    exits: z.features.filter((f) => f.kind === 'exit').map((f) => ({ to: zoneName(f.targetZoneId), dir: (f as { dir?: string }).dir })),
    npcs: w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ name: n.name, role: n.role, title: n.title })),
    features: z.features.filter((f) => !['exit', 'door', 'gate', 'trap'].includes(f.kind)).map((f) => (f.name ? `${f.kind} "${f.name}"` : f.kind)),
  };
}

function needsText(n: ZoneNeeds): string {
  const lines: string[] = [];
  if (n.buildings.length) lines.push(`Buildings that can be entered (each needs its own clearly visible door): ${n.buildings.map((b) => `${b.name} (${b.purpose})`).join('; ')}.`);
  if (n.exits.length) lines.push(`Ways out of this place: ${n.exits.map((e) => `to ${e.to}`).join('; ')}.`);
  if (n.npcs.length) lines.push(`People who live or work here: ${n.npcs.map((p) => `${p.name}, ${p.title}`).join('; ')}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------- 1. the prompt

const CAMERA =
  'Paint a complete isometric video game level that sits exactly on the isometric floor grid in image 1: every wall, building and object follows the grid\'s diagonal directions. The grid is only a guide and must not be visible in the result. Orthographic 2:1 isometric projection with parallel lines and no perspective, seen from above like a classic isometric RPG, no sky and no horizon, the level fills the whole frame edge to edge. No people, no creatures, no text.';

const PromptSchema = z.object({
  prompt: z.string().min(300).max(2400),
});

export async function writeZonePrompt(w: WorldDefinition, z: ZoneDef, guidance?: string): Promise<string> {
  const n = needsOf(w, z);
  const out = await genai().structured('world.design', {
    system: 'You are the art director and level designer of a 2D isometric RPG whose places are each painted as one large hand-painted illustration by an image model. You write the image model\'s prompt.',
    prompt: `WORLD: ${w.concept.title}. ${w.concept.pitch}
Art style: ${w.concept.artStyle}

PLACE: ${z.name} (${z.kind}${z.indoor ? ', indoors' : ''}): ${z.description}
${z.lore ? `History: ${z.lore}\n` : ''}${needsText(n)}
${guidance ? `\nTHE OWNER'S DIRECTION: ${guidance}\n` : ''}
Write the prompt (150-260 words) for one painting of this whole place, seen from above as an isometric game level. It must:
- Describe it as a level the player walks around: name the walkable ground (its material) and make it a large, connected network (about half the picture), with routes reaching the picture's edges where the ways out are.
- Give the scale with counts, close enough that a door is about a twentieth of the picture's height: e.g. "about 8 houses", "four clusters of cubicles", "a dozen trees in loose groves". Never "endless" or "rows stretching away".
- Lay it out in plain spatial words (left, right, upper, lower, centre). Buildings or rooms that can be entered show their doors on the walls facing the viewer (the lower-left or lower-right faces).
- Close the place in naturally along the picture's border with something that fits (dense forest, cliffs, a wall, deep water, office walls) except where the ways out are.
- If the place is one interior, show it as a cutaway with no ceiling.
- Name the light (direction and colour) and a palette of 3-5 colours; describe materials and small story details.
Write only the scene: the camera and the grid are handled separately. The game draws its own people, creatures, chests, loot, shrines and signs on top, so never paint them. No people or creatures, no text or signs with words, no fog over the ground.`,
    schema: PromptSchema,
    name: 'zone_prompt',
    maxTokens: 1500,
  });
  return out.prompt.trim();
}

// ---------------------------------------------------------------------------------------------- 2. the painting

export async function isoGrid(width: number, height: number, cell: number): Promise<Buffer> {
  const lines: string[] = [];
  for (let k = -height * 2; k < width + height * 2; k += cell) {
    lines.push(`<line x1="${k}" y1="0" x2="${k + height * 2}" y2="${height}" />`, `<line x1="${k}" y1="0" x2="${k - height * 2}" y2="${height}" />`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#8a8578"/><g stroke="#5e5a50" stroke-width="2">${lines.join('')}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function paintZoneImage(prompt: string, seed: number): Promise<Buffer> {
  // The grid only conveys the angles, so a half-size reference is enough (and keeps the edit within VRAM).
  const grid = await isoGrid(PW / 2, PH / 2, 32);
  await freeGpu();
  return edit([grid], `${CAMERA}\n\n${prompt}`, PW, PH, seed);
}

// ---------------------------------------------------------------------------------------------- 3. reading it back

const ReadSchema = z.object({
  usable: z.boolean().describe('False if this picture cannot work as the place (wrong place, no clear walkable ground, not a top-down isometric view, a picture of a building rather than a level)'),
  problems: z.array(z.string().max(200)).max(5),
  walkable: z.array(z.string().max(40)).min(1).max(5).describe('Short names of the surfaces people walk on, as an object detector would call them: "cobblestone street", "wooden pier", "carpet", "dirt path", "grass"'),
  connectors: z.array(z.string().max(40)).max(4).describe('Sloping surfaces people walk on to get between levels: "stone stairs", "wooden ramp", "bridge". Empty if none'),
  notWalkable: z.array(z.string().max(40)).max(5).describe('Surfaces that might be mistaken for ground but are not walkable: "water", "roof", "table", "lava"'),
  structure: z.string().max(40).describe('What the enterable buildings or rooms look like from outside, as one short noun: "house", "shop", "office room", "hut". Empty if there are none'),
  entrance: z.string().max(40).describe('What the entrances to buildings or rooms look like, as one short noun: "door", "doorway", "cave mouth", "glass door". Empty if there are none'),
  scale: z.object({ object: z.string().max(40), metres: z.number().min(0.3).max(12) }).describe('A common object that appears several times with a well-known real height, and that height (e.g. door 2.1, office chair 1.0, barrel 1.0)'),
  landmarks: z.array(z.object({ term: z.string().max(40), why: z.string().max(120) })).max(10).describe('Distinctive things worth placing people or features at (a fountain, a forge, a fish stall, a campfire, a reception desk), as short detector names'),
});
export type PaintingRead = z.infer<typeof ReadSchema>;

export async function readPainting(w: WorldDefinition, z: ZoneDef, png: Buffer): Promise<PaintingRead> {
  const view = await sharp(png).resize({ width: 1600 }).jpeg({ quality: 88 }).toBuffer();
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG. Each place is one painting; you work out how the game can use it. Judge only what you see.',
    prompt: `This painting is meant to be ${z.name}: ${z.description}
${needsText(needsOf(w, z))}
An object detector (SAM 3) will find things in it from short English names you give. Name things exactly as they look in the picture. Say whether the picture can work as this place.`,
    schema: ReadSchema,
    name: 'painting_read',
    images: [view],
    maxTokens: 1500,
  });
}

const CheckSchema = z.object({
  correct: z.boolean().describe('True if the colouring is right everywhere that matters for walking around'),
  mistakes: z.array(z.string().max(200)).max(6).describe('Each wrongly coloured area, in plain words'),
  addWalkable: z.array(z.string().max(40)).max(4).describe('Detector names of flat surfaces people walk on that are not green but should be'),
  addConnectors: z.array(z.string().max(40)).max(4).describe('Detector names of stairs, ramps or bridges that are not green but should be'),
  addBlocked: z.array(z.string().max(40)).max(4).describe('Detector names of things coloured green that people cannot walk on (water, roofs, boats, furniture)'),
});
export type ReadingCheck = z.infer<typeof CheckSchema>;

/**
 * Luna checks the walkability colouring against the painting and names what to look for differently. She answers
 * in detector terms, so a correction is just another read (SAM results are cached).
 */
export async function checkReading(png: Buffer, overlayJpg: Buffer, read: PaintingRead): Promise<ReadingCheck> {
  const view = await sharp(png).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
  const marked = await sharp(overlayJpg).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG checking which parts of a painted level the game lets people walk on. Judge only what you see.',
    prompt: `Image 1 is the level. Image 2 is the same level coloured by the game: green = people can walk there; yellow = walkable surface too narrow or cut off from the rest; red = blocked; blue = not flat (walls, roofs' slopes, objects); uncoloured = not recognised.
It was found by looking for walkable: ${read.walkable.join(', ')}; connectors: ${(read.connectors ?? []).join(', ') || 'none'}; blocked: ${read.notWalkable.join(', ')}.
Is the colouring right for walking around this level? Ignore small fringes along edges and objects. Name only real mistakes: walkable ground that is not green (a street, a stair, a bridge cut off) or green where nobody can walk (water, roofs, boats, furniture).
For each mistake, name the cause, not the symptom. An area that is yellow (cut off) is usually missing the thing that joins it to the rest: name that (a doorway, a gap in a wall, the end of a bridge, a ramp), not the area itself. Never suggest a name that is already in the lists above: the detector already looked for it, so if such a surface is still wrongly coloured, describe it differently by how it looks. For each, give the short everyday name of the thing as an object detector would call it ("stone stairs", "wooden boat", "water"), never a label or code.`,
    schema: CheckSchema,
    name: 'reading_check',
    images: [view, marked],
    maxTokens: 1200,
    validate: (c) => {
      const used = new Set([...read.walkable, ...(read.connectors ?? []), ...read.notWalkable].map((t) => t.toLowerCase()));
      const again = [...c.addWalkable, ...c.addConnectors, ...c.addBlocked].filter((t) => used.has(t.toLowerCase()));
      return again.length ? `Already looked for: ${again.join(', ')}. Name what joins the cut-off area or describe the surface differently.` : null;
    },
  });
}

/** The read with a check's corrections applied. */
export function applyCheck(read: PaintingRead, c: ReadingCheck): PaintingRead {
  const add = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return { ...read, walkable: add(read.walkable, c.addWalkable), connectors: add(read.connectors ?? [], c.addConnectors), notWalkable: add(read.notWalkable, c.addBlocked) };
}

// ---------------------------------------------------------------------------------------------- masks

export type Mask = Uint8Array; // AW*AH, 0/1

const union = (ms: Mask[]) => {
  const o = new Uint8Array(AW * AH);
  for (const m of ms) for (let i = 0; i < o.length; i++) o[i] = o[i]! | m[i]!;
  return o;
};

type Box = { x: number; y: number; w: number; h: number; area: number };

/**
 * SAM over the picture. SAM looks at about 1000 px, so a canvas larger than one painting is read window by window
 * (painting-sized, half overlapping): unions are OR-ed together, objects are kept as boxes (in analysis pixels)
 * with duplicates from overlapping windows merged.
 */
async function segmenter(png: Buffer) {
  const wins: { x: number; y: number; w: number; h: number }[] = [];
  const starts = (size: number, win: number) => {
    if (size <= win) return [0];
    const out: number[] = [];
    for (let p = 0; p + win < size; p += win / 2) out.push(p);
    out.push(size - win);
    return out;
  };
  const ww = Math.min(IW, PW), wh = Math.min(IH, PH);
  for (const y of starts(IH, wh)) for (const x of starts(IW, ww)) wins.push({ x, y, w: ww, h: wh });
  const crops = await Promise.all(wins.map((r) => (wins.length === 1 ? png : sharp(png).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toBuffer())));
  const each = async (term: string, max: number, fn: (raw: Buffer, aw: number, ah: number, ax: number, ay: number) => void) => {
    for (let k = 0; k < wins.length; k++) {
      const r = wins[k]!;
      const aw = Math.round(r.w / 2), ah = Math.round(r.h / 2), ax = Math.round(r.x / 2), ay = Math.round(r.y / 2);
      for (const m of await segment(crops[k]!, `${term}:${max}`, 0.35)) fn(await sharp(m).resize(aw, ah, { kernel: 'nearest' }).extractChannel(0).raw().toBuffer(), aw, ah, ax, ay);
    }
  };
  return {
    /** Every detected object as its own mask (analysis size) with its area. */
    segInstances: async (term: string, max: number): Promise<{ mask: Mask; area: number }[]> => {
      const out: { mask: Mask; area: number }[] = [];
      await each(term, max, (raw, aw, ah, ax, ay) => {
        const m = new Uint8Array(AW * AH);
        let area = 0;
        for (let y = 0; y < ah; y++)
          for (let x = 0; x < aw; x++)
            if (raw[y * aw + x]! > 127 && ay + y < AH && ax + x < AW) {
              m[(ay + y) * AW + ax + x] = 1;
              area++;
            }
        if (area) out.push({ mask: m, area });
      });
      return out;
    },
    segUnion: async (term: string, max: number): Promise<Mask> => {
      const out = new Uint8Array(AW * AH);
      await each(term, max, (raw, aw, ah, ax, ay) => {
        for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) if (raw[y * aw + x]! > 127 && ay + y < AH && ax + x < AW) out[(ay + y) * AW + ax + x] = 1;
      });
      return out;
    },
    segBoxes: async (term: string, max: number): Promise<Box[]> => {
      const boxes: Box[] = [];
      await each(term, max, (raw, aw, ah, ax, ay) => {
        let x0 = aw, y0 = ah, x1 = -1, y1 = -1, area = 0;
        for (let y = 0; y < ah; y++)
          for (let x = 0; x < aw; x++) {
            if (raw[y * aw + x]! <= 127) continue;
            area++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        if (x1 >= 0) boxes.push({ x: ax + x0, y: ay + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
      });
      // Merge duplicates (the same object seen by two windows): keep the larger of two boxes that overlap a lot.
      boxes.sort((a, b) => b.area - a.area);
      const kept: Box[] = [];
      for (const b of boxes) {
        const dup = kept.some((k) => {
          const ix = Math.max(0, Math.min(k.x + k.w, b.x + b.w) - Math.max(k.x, b.x));
          const iy = Math.max(0, Math.min(k.y + k.h, b.y + b.h) - Math.max(k.y, b.y));
          return ix * iy > 0.5 * b.w * b.h;
        });
        if (!dup) kept.push(b);
      }
      return kept;
    },
  };
}

/** Connected components (4-neighbour); returns labels and sizes (index 0 unused). */
function components(m: Mask): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(AW * AH);
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
      const x = p % AW, y = (p / AW) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < AW - 1 ? p + 1 : -1, y > 0 ? p - AW : -1, y < AH - 1 ? p + AW : -1]) {
        if (q >= 0 && m[q] && !label[q]) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

/** Squared distance (in analysis pixels) from each pixel to the nearest 0 pixel, via two-pass chamfer. */
function distanceToEdge(m: Mask): Float32Array {
  const d = new Float32Array(AW * AH);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? INF : 0;
  const D = 1, DD = Math.SQRT2;
  for (let y = 0; y < AH; y++)
    for (let x = 0; x < AW; x++) {
      const i = y * AW + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + D);
      if (y > 0) {
        v = Math.min(v, d[i - AW]! + D);
        if (x > 0) v = Math.min(v, d[i - AW - 1]! + DD);
        if (x < AW - 1) v = Math.min(v, d[i - AW + 1]! + DD);
      }
      d[i] = v;
    }
  for (let y = AH - 1; y >= 0; y--)
    for (let x = AW - 1; x >= 0; x--) {
      const i = y * AW + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x < AW - 1) v = Math.min(v, d[i + 1]! + D);
      if (y < AH - 1) {
        v = Math.min(v, d[i + AW]! + D);
        if (x < AW - 1) v = Math.min(v, d[i + AW + 1]! + DD);
        if (x > 0) v = Math.min(v, d[i + AW - 1]! + DD);
      }
      d[i] = v;
    }
  return d;
}

/**
 * The floor's normal as a smooth field n(x, y) = a + b·x + c·y (per component, least squares over the ground),
 * refitted twice without the pixels more than 30° off the fit (walls and objects inside the ground masks).
 */
function fitNormalField(ground: Mask, blocked: Mask, vec: (i: number) => [number, number, number]): (x: number, y: number) => [number, number, number] {
  let coef: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 1]];
  const at = (x: number, y: number): [number, number, number] => {
    const u = x / AW - 0.5, w = y / AH - 0.5;
    const v = coef.map((c) => c[0]! + c[1]! * u + c[2]! * w) as [number, number, number];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  for (let pass = 0; pass < 3; pass++) {
    // Normal equations for [1, u, w].
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // B[component][basis]
    const cos30 = Math.cos(Math.PI / 6);
    for (let i = 0; i < AW * AH; i += 3) {
      if (!ground[i] || blocked[i]) continue;
      const x = i % AW, y = (i / AW) | 0;
      const v = vec(i);
      if (pass > 0) {
        const f = at(x, y);
        if (v[0] * f[0] + v[1] * f[1] + v[2] * f[2] < cos30) continue;
      }
      const b = [1, x / AW - 0.5, y / AH - 0.5];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r]![c]! += b[r]! * b[c]!;
        for (let k = 0; k < 3; k++) B[k]![r]! += v[k]! * b[r]!;
      }
    }
    coef = B.map((rhs) => solve3(A, rhs));
  }
  return at;
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

/** Morphological opening: shrink by r, then grow by r (removes specks and threads thinner than 2r). */
function openMask(m: Mask, r: number): Mask {
  const dIn = distanceToEdge(m);
  const core = new Uint8Array(AW * AH);
  for (let i = 0; i < core.length; i++) core[i] = dIn[i]! > r ? 1 : 0;
  const inv = new Uint8Array(AW * AH);
  for (let i = 0; i < inv.length; i++) inv[i] = core[i] ? 0 : 1;
  const dOut = distanceToEdge(inv);
  const out = new Uint8Array(AW * AH);
  for (let i = 0; i < out.length; i++) out[i] = core[i] || (dOut[i]! <= r && m[i]) ? 1 : 0;
  return out;
}

/** Morphological closing: grow by r, then shrink by r. */
function close(m: Mask, r: number): Mask {
  const inv = new Uint8Array(AW * AH);
  for (let i = 0; i < inv.length; i++) inv[i] = m[i] ? 0 : 1;
  const dOut = distanceToEdge(inv); // distance from each empty pixel to the mask
  const grown = new Uint8Array(AW * AH);
  for (let i = 0; i < grown.length; i++) grown[i] = m[i] || dOut[i]! <= r ? 1 : 0;
  const dIn = distanceToEdge(grown);
  const out = new Uint8Array(AW * AH);
  for (let i = 0; i < out.length; i++) out[i] = dIn[i]! > r ? 1 : m[i]!;
  return out;
}

// ---------------------------------------------------------------------------------------------- 4. analysis

export interface Spot {
  n: number;
  x: number; // painting pixels
  y: number;
  label: string;
  /** Entrances: the building (structure detection) it belongs to, and its centre in analysis pixels. */
  building?: number;
  cx?: number;
  cy?: number;
}

export interface ZoneReading {
  read: PaintingRead;
  walkable: Mask; // after clearance, largest region only
  ground: Mask; // raw walkable surfaces
  blocked: Mask; // not-walkable surfaces
  flat: Mask; // flat, upward-facing surfaces (MoGe)
  link: Mask; // connectors (stairs, ramps, bridges)
  portals: { x: number; y: number; a: number; b: number }[]; // doorways joining floors on both sides of a wall (painting px)
  walkableShare: number;
  regions: number[]; // sizes of the walkable regions (share of the picture) before keeping the largest
  doors: Spot[]; // entrances whose foot touches the walkable ground
  doorsRejected: number;
  landmarks: Spot[];
  exits: Spot[]; // where the walkable ground meets the picture's edge
  pxPerMetre: number | null; // in painting pixels
  upscale: number | null; // painting -> game resolution
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function analyseZone(png: Buffer, read: PaintingRead, opts: { report?: (m: string) => void; needDoors?: number } = {}): Promise<ZoneReading> {
  const say = opts.report ?? (() => {});
  const meta = await sharp(png).metadata();
  useSize(meta.width!, meta.height!);
  const S = IW / AW; // painting px per analysis px
  const { segInstances, segBoxes } = await segmenter(png);
  // Every detected object votes for its class (walkable ground, connector, blocker). Where detections overlap, the
  // most specific one (the smallest object) wins: a pier mask that spans the water between its arms loses to the
  // water, a "water" mask spread over a whole wet street loses to the street.
  const WALK = 1, LINK = 2, BLOCK = 3;
  const cls = new Uint8Array(AW * AH);
  const best = new Float64Array(AW * AH).fill(Infinity);
  const vote = (list: { mask: Mask; area: number }[], c: number) => {
    for (const { mask, area } of list) for (let i = 0; i < mask.length; i++) if (mask[i] && area < best[i]!) (best[i] = area), (cls[i] = c);
  };
  let n = 0;
  // A surface named both as ground and as a connector is a connector (it may slope).
  const linkTerms = read.connectors ?? [];
  const walkTerms = read.walkable.filter((t) => !linkTerms.includes(t));
  const links: { mask: Mask; area: number }[] = [];
  for (const [terms, c] of [[walkTerms, WALK], [linkTerms, LINK], [read.notWalkable, BLOCK]] as const)
    for (const t of terms) {
      const inst = await segInstances(t, 20);
      n += inst.length;
      vote(inst, c);
      if (c === LINK) links.push(...inst);
    }
  // A connector exists to cross an obstacle: where it overlaps a blocker (a bridge's own masonry read as a wall,
  // the water under it), the connector wins whatever the sizes.
  for (const { mask } of links) for (let i = 0; i < mask.length; i++) if (mask[i] && cls[i] === BLOCK) cls[i] = LINK;
  // Close hairline gaps where masks of different surfaces meet (pier against quay, path against grass).
  const ground = close(cls.map((c) => (c === WALK || c === LINK ? 1 : 0)), 3);
  const link = cls.map((c) => (c === LINK ? 1 : 0));
  const blocked = cls.map((c) => (c === BLOCK ? 1 : 0));
  if (process.env.ZP_DEBUG) {
    const rgb = Buffer.alloc(AW * AH * 3);
    const col = [[0, 0, 0], [40, 200, 70], [240, 220, 0], [220, 40, 40]];
    for (let i = 0; i < cls.length; i++) rgb.set(col[cls[i]!]!, i * 3);
    await sharp(rgb, { raw: { width: AW, height: AH, channels: 3 } }).png().toFile(`${process.env.ZP_DEBUG}_cls.png`);
  }
  say(`${n} detections: ground ${ground.reduce((a, b) => a + b, 0)} px, connectors ${link.reduce((a, b) => a + b, 0)} px, blocked ${blocked.reduce((a, b) => a + b, 0)} px`);

  // Geometry: walkable ground is flat and faces up. MoGe's normals tell floor from walls, partitions, trunks and
  // brambles whatever they look like. MoGe assumes a perspective camera, so the floor's normal drifts across the
  // picture: fit it as a smooth field (linear in x and y) over the ground SAM found, rejecting walls as outliers.
  const { normal } = await geometry(png);
  const nr = await sharp(normal).resize(AW, AH).removeAlpha().raw().toBuffer();
  const vec = (i: number): [number, number, number] => {
    const v: [number, number, number] = [nr[i * 3]! / 127.5 - 1, nr[i * 3 + 1]! / 127.5 - 1, nr[i * 3 + 2]! / 127.5 - 1];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const field = fitNormalField(ground, blocked, vec);
  const COS = Math.cos((20 * Math.PI) / 180);
  const flatRaw = new Uint8Array(AW * AH);
  for (let i = 0; i < flatRaw.length; i++) {
    const v = vec(i);
    const f = field(i % AW, (i / AW) | 0);
    flatRaw[i] = v[0] * f[0] + v[1] * f[1] + v[2] * f[2] >= COS ? 1 : 0;
  }
  // Rough surfaces (brambles, rubble) have scattered flat pixels: opening keeps only coherent floor. Then closing
  // fills thin seams (plank joints, cobble edges) that would otherwise slice a street apart; walls are far wider.
  const flat = close(openMask(flatRaw, 2), 4);
  if (process.env.ZP_DEBUG) {
    const dump = (m: Mask, n: string) => sharp(Buffer.from(m.map((v) => v * 255)), { raw: { width: AW, height: AH, channels: 1 } }).png().toFile(`${process.env.ZP_DEBUG}_${n}.png`);
    await dump(ground, 'ground');
    await dump(blocked, 'blocked');
  }
  const open = new Uint8Array(AW * AH);
  // Connectors (stairs, ramps, bridges) slope by nature: they are walkable without being flat.
  for (let i = 0; i < open.length; i++) open[i] = ground[i]! && !blocked[i] && (flat[i] || link[i]) ? 1 : 0;

  // Scale: the median height of the reference object.
  const heights = (await segBoxes(read.scale.object, 30)).filter((b) => b.area > 8).map((b) => b.h * S).sort((a, b) => a - b);
  const pxPerMetre = heights.length ? heights[heights.length >> 1]! / read.scale.metres : null;
  const upscale = pxPerMetre ? GAME_PX_PER_M / pxPerMetre : null;
  say(`scale: ${heights.length} × ${read.scale.object}, ${pxPerMetre?.toFixed(1)} px/m, upscale ${upscale?.toFixed(2)}`);

  // The approach onto a connector slopes too (the bank rising to a bridge, the landing of a stair): ground within a
  // metre of a connector that is ground (even sloping) is walkable, so stairs and bridges meet the ground they lead to.
  {
    const notLink = link.map((v) => (v ? 0 : 1));
    const dLink = distanceToEdge(notLink);
    const metre = (pxPerMetre ?? 25) / S;
    // Gaps between a connector and the ground it meets (a seam neither detection covers) are closed too, but only
    // gaps: an unrecognised object beside a stair stays out.
    const bridged = close(open, Math.ceil(metre));
    // Blockers thinner than half a metre right by a connector are detection slivers (a rock edge across a bridge
    // head), not obstacles: ignore them there. Thin walls elsewhere are untouched.
    const solidBlock = openMask(blocked, Math.max(1, Math.round(metre / 4)));
    for (let i = 0; i < open.length; i++) {
      if (open[i] || dLink[i]! > metre) continue;
      const sliver = blocked[i] && !solidBlock[i];
      if ((!blocked[i] || sliver) && (ground[i] || bridged[i] || sliver)) open[i] = 1;
    }
  }
  // Clearance: a character's feet (about 0.35 m radius) must fit; then keep the largest region.
  const radius = Math.max(2, ((pxPerMetre ?? 25) * 0.35) / S);
  const dist = distanceToEdge(open);
  const clear = new Uint8Array(AW * AH);
  for (let i = 0; i < clear.length; i++) clear[i] = dist[i]! >= radius ? 1 : 0;
  if (process.env.ZP_DEBUG) {
    const dump = (m: Mask, n: string) => sharp(Buffer.from(m.map((v) => v * 255)), { raw: { width: AW, height: AH, channels: 1 } }).png().toFile(`${process.env.ZP_DEBUG}_${n}.png`);
    await dump(open, "open");
    await dump(clear, "clear");
    await dump(link, "link");
    await dump(flat, "flat");
  }
  // The walkable mask is where a character's centre may stand (so collision is a plain lookup).
  const { label, sizes } = components(clear);
  // Portals: a doorway in a wall joins the floor at its foot to the floor beyond the wall, as in most isometric
  // games (the wall hides the floor running through it). For each detected entrance, look straight down from its
  // foot and straight up past the wall (up to 4 m) for walkable regions; two different ones are joined. Where a door
  // leads into a building (a town) there is no floor beyond it, so nothing is joined.
  const parent = sizes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const portals: { x: number; y: number; a: number; b: number }[] = [];
  if (read.entrance) {
    const reachPx = Math.round((4 * (pxPerMetre ?? 25)) / S);
    for (const bx of await segBoxes(read.entrance, 60)) {
      const cx = Math.round(bx.x + bx.w / 2);
      const regionAt = (y0: number, dir: 1 | -1) => {
        for (let d = 0; d <= reachPx; d++) {
          const y = y0 + d * dir;
          if (y < 0 || y >= AH) return 0;
          for (const dx of [0, -2, 2]) {
            const l = label[y * AW + Math.min(AW - 1, Math.max(0, cx + dx))]!;
            if (l) return l;
          }
        }
        return 0;
      };
      const a = regionAt(bx.y + bx.h, 1), b = regionAt(bx.y, -1);
      if (a && b && find(a) !== find(b)) {
        parent[find(a)] = find(b);
        portals.push({ x: Math.round(cx * S), y: Math.round((bx.y + bx.h) * S), a, b });
      }
    }
  }
  const joined = new Map<number, number>();
  for (let l = 1; l < sizes.length; l++) joined.set(find(l), (joined.get(find(l)) ?? 0) + sizes[l]!);
  const order = [...joined.entries()].map(([root, s]) => [s, root] as const).sort((a, b) => b[0] - a[0]);
  const main = order[0]?.[1] ?? 0;
  const walkable = new Uint8Array(AW * AH);
  for (let i = 0; i < walkable.length; i++) walkable[i] = main && label[i] && find(label[i]!) === main ? 1 : 0;
  say(`${portals.length} doorway portals join separate floors`);
  const total = AW * AH;
  const walkableShare = walkable.reduce((a, b) => a + b, 0) / total;
  const regions = order.slice(0, 6).map(([s]) => s / total);

  // Entrances: keep those whose foot (bottom edge) is next to the walkable ground.
  const doors: Spot[] = [];
  let doorsRejected = 0;
  if (read.entrance) {
    const reach = Math.ceil(radius * 3);
    for (const b of await segBoxes(read.entrance, 60)) {
      if (b.area < 6) continue;
      const fy = b.y + b.h - 1;
      let near = false;
      for (let y = fy; y <= Math.min(AH - 1, fy + reach) && !near; y++)
        for (let x = Math.max(0, b.x - reach); x <= Math.min(AW - 1, b.x + b.w + reach) && !near; x++) if (walkable[y * AW + x]) near = true;
      if (near) doors.push({ n: doors.length + 1, x: Math.round((b.x + b.w / 2) * S), y: Math.round((b.y + b.h) * S), label: read.entrance, cy: b.y + b.h / 2, cx: b.x + b.w / 2 });
      else doorsRejected++;
    }
  }
  // Which building each entrance belongs to: the structure detection that contains the middle of the door (or the
  // nearest one), so two doors in one facade read as one building.
  if (read.structure && doors.length) {
    const blds = await segInstances(read.structure, 40);
    for (const d of doors) {
      const x = Math.round(d.cx!), y = Math.round(d.cy!);
      let best = -1, bd = Infinity;
      blds.forEach((b, j) => {
        if (b.mask[y * AW + x]) (best = j), (bd = 0);
        if (bd === 0) return;
        for (let r = 1; r <= 12; r += 3)
          for (const [dx, dy] of [[r, 0], [-r, 0], [0, -r], [0, r]] as const) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < AW && yy < AH && b.mask[yy * AW + xx] && r < bd) (bd = r), (best = j);
          }
      });
      if (best >= 0) d.building = best + 1;
    }
  }
  // Doors closer than a metre are one entrance seen twice.
  const metre = (pxPerMetre ?? 25) / S;
  for (let i = doors.length - 1; i >= 0; i--)
    if (doors.slice(0, i).some((o) => Math.hypot(o.cx! - doors[i]!.cx!, o.cy! - doors[i]!.cy!) < metre)) doors.splice(i, 1);
  doors.forEach((d, i) => (d.n = i + 1));
  say(`entrances: ${doors.length} usable, ${doorsRejected} not reachable, in ${new Set(doors.map((d) => d.building ?? -d.n)).size} buildings`);

  const landmarks: Spot[] = [];
  for (const l of read.landmarks) {
    for (const b of await segBoxes(l.term, 6)) {
      if (b.area < 6) continue;
      // Only landmarks people can reach: walkable ground within a metre of the landmark's foot (nothing is placed in
      // areas cut off from the rest).
      const fx = Math.round(b.x + b.w / 2), fy = Math.min(AH - 1, b.y + b.h - 1), m = Math.ceil((pxPerMetre ?? 25) / S);
      let reach = false;
      for (let y = Math.max(0, fy - m); y <= Math.min(AH - 1, fy + m) && !reach; y++)
        for (let x = Math.max(0, fx - m); x <= Math.min(AW - 1, fx + m) && !reach; x++) if (walkable[y * AW + x]) reach = true;
      if (reach) landmarks.push({ n: landmarks.length + 1, x: Math.round(fx * S), y: Math.round((b.y + b.h) * S), label: l.term });
    }
  }

  // Exits: runs of walkable pixels along each border.
  const exits: Spot[] = [];
  const edge = (pts: [number, number][], side: string) => {
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length * S >= 48) {
        const mid = run[run.length >> 1]!;
        exits.push({ n: exits.length + 1, x: Math.round(mid[0] * S), y: Math.round(mid[1] * S), label: side });
      }
      run = [];
    };
    for (const p of pts) {
      if (walkable[p[1] * AW + p[0]]) run.push(p);
      else flush();
    }
    flush();
  };
  const inset = 2;
  edge(Array.from({ length: AW }, (_, x) => [x, inset] as [number, number]), 'top');
  edge(Array.from({ length: AW }, (_, x) => [x, AH - 1 - inset] as [number, number]), 'bottom');
  edge(Array.from({ length: AH }, (_, y) => [inset, y] as [number, number]), 'left');
  edge(Array.from({ length: AH }, (_, y) => [AW - 1 - inset, y] as [number, number]), 'right');

  // Walkable ground in square metres (a 50×50 tile zone today has roughly 1,200-1,800 m² of it).
  const walkableM2 = (walkableShare * IW * IH) / Math.pow(pxPerMetre ?? 25, 2);
  const checks = [
    { name: 'usable', ok: read.usable, detail: read.problems.join('; ') || 'ok' },
    { name: 'walkable area', ok: walkableM2 >= 900, detail: `${Math.round(walkableM2)} m² (${(walkableShare * 100).toFixed(0)}% of the picture (largest of ${regions.length} regions: ${regions.map((r) => (r * 100).toFixed(0) + '%').join(', ')})` },
    { name: 'scale', ok: !!upscale && upscale >= 1.2 && upscale <= 3, detail: upscale ? `needs ×${upscale.toFixed(2)} to reach game scale` : 'no scale object found' },
    { name: 'entrances', ok: doors.length >= (opts.needDoors ?? 0), detail: `${doors.length} reachable (need ${opts.needDoors ?? 0})` },
    { name: 'exits', ok: exits.length >= 1, detail: `${exits.length} openings at the edges (${exits.map((e) => e.label).join(', ')})` },
  ];
  return { read, walkable, ground, blocked, flat, link, portals, walkableShare, regions, doors, doorsRejected, landmarks, exits, pxPerMetre, upscale, checks };
}

// ---------------------------------------------------------------------------------------------- overlay

/** The painting with walkable ground in green, blocked surfaces in red and numbered markers. */
export async function overlay(png: Buffer, r: ZoneReading, width = 1600, markers = true): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  useSize(meta.width!, meta.height!);
  const rgba = Buffer.alloc(AW * AH * 4);
  for (let i = 0; i < AW * AH; i++) {
    if (r.walkable[i]) rgba.set([40, 255, 90, 95], i * 4);
    else if (r.ground[i] && r.blocked[i]) rgba.set([255, 0, 200, 110], i * 4); // ground removed by a blocker
    else if (r.ground[i] && !r.flat[i]) rgba.set([60, 120, 255, 120], i * 4); // ground that is not flat (walls, partitions)
    else if (r.ground[i]) rgba.set([255, 210, 0, 90], i * 4); // ground too narrow or cut off
    else if (r.blocked[i]) rgba.set([255, 40, 40, 80], i * 4);
  }
  const tint = await sharp(rgba, { raw: { width: AW, height: AH, channels: 4 } }).resize(IW, IH).png().toBuffer();
  const k = width / IW;
  // Markers sized to the output, so labels sit inside their circles and stay readable on a downscaled view.
  const R = Math.max(14, width / 70), F = R * 0.8;
  const mark = (s: Spot, color: string, prefix: string) =>
    `<g><circle cx="${s.x * k}" cy="${s.y * k}" r="${R}" fill="${color}" stroke="#000" stroke-width="${R / 7}"/><text x="${s.x * k}" y="${s.y * k + F * 0.36}" font-size="${(prefix + s.n).length > 2 ? F * 0.8 : F}" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#000">${prefix}${s.n}</text></g>`;
  const h = Math.round(IH * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${!markers ? "" : r.doors.map((d) => mark(d, '#ffd400', 'D')).join('')}${!markers ? "" : r.landmarks.map((d) => mark(d, '#ff7ad9', 'L')).join('')}${!markers ? "" : r.exits.map((d) => mark(d, '#4db8ff', 'E')).join('')}${r.portals.map((p) => `<rect x="${p.x * k - R * 0.35}" y="${p.y * k - R * 0.35}" width="${R * 0.7}" height="${R * 0.7}" transform="rotate(45 ${p.x * k} ${p.y * k})" fill="#00ffff" stroke="#000" stroke-width="2"/>`).join('')}</svg>`;
  const base = await sharp(png).composite([{ input: tint }]).png().toBuffer();
  return sharp(base).resize(width).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 86 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------- placement

export interface Candidate {
  id: string; // D1 (entrance), E1 (way out), L1 (landmark), P1 (open ground)
  x: number; // painting pixels
  y: number;
  what: string;
  building?: number;
}

/**
 * Numbered spots Luna can choose from: entrances, ways out and landmarks found in the painting, plus open ground
 * spread evenly over the walkable area (farthest-point sampling), so there is always somewhere for everyone.
 */
export function candidates(r: ZoneReading, open = 24): Candidate[] {
  const S = IW / AW;
  // Markers must not cover each other in the view Luna sees (a marker's radius is IW/55): entrances and ways out
  // always stay; a landmark that would sit on another marker is dropped, and landmarks are renumbered.
  const gap = (2.2 * IW) / 55;
  const out: Candidate[] = [
    ...r.doors.map((d) => ({ id: `D${d.n}`, x: d.x, y: d.y, what: `entrance (${d.label})${d.building ? `, building B${d.building}` : ''}`, building: d.building })),
    ...r.exits.map((e) => ({ id: `E${e.n}`, x: e.x, y: e.y, what: `way out at the ${e.label} edge` })),
  ];
  let ln = 0;
  for (const l of r.landmarks) if (out.every((c) => Math.hypot(c.x - l.x, c.y - l.y) >= gap)) out.push({ id: `L${++ln}`, x: l.x, y: l.y, what: l.label });
  const pts: [number, number][] = [];
  // Open ground only: never on stairs, ramps or bridges.
  for (let i = 0; i < r.walkable.length; i += 37) if (r.walkable[i] && !r.link[i]) pts.push([(i % AW) * S, ((i / AW) | 0) * S]);
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

/** The painting with every candidate as a large, labelled marker (sized for a downscaled view). */
export async function candidateView(png: Buffer, cands: Candidate[], width = 1600): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const k = width / meta.width!;
  const h = Math.round(meta.height! * k);
  const R = width / 55;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${cands
    .map((c) => {
      const fs = c.id.length > 2 ? R * 0.75 : R * 0.9;
      return `<g><circle cx="${c.x * k}" cy="${c.y * k}" r="${R}" fill="${SPOT_COLOUR[c.id[0]!] ?? '#fff'}" stroke="#000" stroke-width="${R / 7}"/><text x="${c.x * k}" y="${c.y * k + fs * 0.36}" font-size="${fs}" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#000">${c.id}</text></g>`;
    })
    .join('')}</svg>`;
  return sharp(png).resize(width).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}

const PlacementSchema = z.object({
  buildings: z.array(z.object({ name: z.string(), spot: z.string().describe('A D spot: the entrance that leads inside it'), why: z.string().max(160) })),
  exits: z.array(z.object({ to: z.string(), spot: z.string().describe('An E spot'), why: z.string().max(160) })),
  people: z.array(z.object({ name: z.string(), spot: z.string(), why: z.string().max(160) })),
  features: z.array(z.object({ feature: z.string(), spot: z.string(), why: z.string().max(160) })),
  problems: z.array(z.string().max(200)).max(5).describe('Anything the place needs that this painting cannot provide'),
});
export type Placement = z.infer<typeof PlacementSchema>;

/** Luna looks at the numbered spots and decides where every building, way out, person and feature goes. */
export async function placeInZone(w: WorldDefinition, z: ZoneDef, png: Buffer, cands: Candidate[]): Promise<Placement> {
  const n = needsOf(w, z);
  const ids = new Set(cands.map((c) => c.id));
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D isometric RPG. Each place is one painting; you decide where the game puts things in it. Judge only what you see.',
    prompt: `This painting is ${z.name}: ${z.description}
The numbered circles are the spots the game can use: D = an entrance into a building or room, E = a way out at the edge of the picture, L = a landmark, P = open ground.
${cands.map((c) => `${c.id}: ${c.what}`).join('\n')}

Place everything this place needs, each at the spot that suits it best, as a level designer would:
- Buildings that can be entered, one D spot each (different spots). Entrances with the same B number were detected as one structure: use two of them only where the picture clearly shows separate units (a terrace of homes, a row of shops), never two doors of one house: ${n.buildings.map((b) => `${b.name} (${b.purpose})`).join('; ') || 'none'}.
- Ways out, one E spot each: ${n.exits.map((e) => `to ${e.to}`).join('; ') || 'none'}.
- People (near their work, home or a fitting landmark; never on a D or E spot): ${n.npcs.map((p) => `${p.name}, ${p.title} (${p.role})`).join('; ') || 'none'}.
- Features (chests, shrines, signs and so on; L or P spots): ${n.features.join('; ') || 'none'}.
Match buildings to entrances whose building looks right for them (a big building for an inn, a small one for a home). Spread people out. If something cannot be placed sensibly, say so in problems.`,
    schema: PlacementSchema,
    name: 'zone_placement',
    images: [await candidateView(png, cands)],
    maxTokens: 2500,
    validate: (p) => {
      const all = [...p.buildings.map((b) => b.spot), ...p.exits.map((e) => e.spot), ...p.people.map((x) => x.spot), ...p.features.map((f) => f.spot)];
      const bad = all.filter((s) => !ids.has(s));
      if (bad.length) return `Unknown spots: ${bad.join(', ')}. Use only the listed ids.`;
      const doors = p.buildings.map((b) => b.spot);
      if (new Set(doors).size !== doors.length) return 'Each building needs its own entrance (D spot).';
      return null;
    },
  });
}

/** The painting with the placement drawn on it: names next to their spots. */
export async function placementView(png: Buffer, cands: Candidate[], p: Placement, width = 2400): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const k = width / meta.width!;
  const h = Math.round(meta.height! * k);
  const at = new Map(cands.map((c) => [c.id, c]));
  const items = [
    ...p.buildings.map((b) => [b.spot, b.name, '#ffd400'] as const),
    ...p.exits.map((e) => [e.spot, `to ${e.to}`, '#4db8ff'] as const),
    ...p.people.map((x) => [x.spot, x.name, '#7dff7d'] as const),
    ...p.features.map((f) => [f.spot, f.feature, '#ff7ad9'] as const),
  ];
  const F = width / 90;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">${items
    .map(([id, label, col], i) => {
      const c = at.get(id);
      if (!c) return '';
      const x = c.x * k, y = c.y * k, dy = (i % 3) * F * 1.1;
      return `<circle cx="${x}" cy="${y}" r="${F * 0.5}" fill="${col}" stroke="#000" stroke-width="2"/><text x="${x + F * 0.7}" y="${y - F * 0.4 + dy}" font-size="${F}" font-family="Arial" font-weight="bold" fill="${col}" stroke="#000" stroke-width="${F / 6}" paint-order="stroke">${esc(label)}</text>`;
    })
    .join('')}</svg>`;
  return sharp(png).resize(width).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}
