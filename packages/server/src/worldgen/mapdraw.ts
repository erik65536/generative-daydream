/**
 * Painting a place as a big top-down 2D map (see docs/places.md):
 * 1. Luna plans the place: the whole-map layout with one dominant area, what each tile of the map holds, its ground,
 *    style, floor and barrier, and what a way out through that barrier looks like.
 * 2. Krea paints the whole place once at its own size, eight times from noise; Luna checks the view and Sol (the
 *    stronger model) whether every area can be reached. The best painting is the place's plan.
 * 3. SeedVR2 enlarges it to the map's size, then Krea adds detail at low strength, window by window, each window
 *    continuing those already done (a soft mask, no cross-fade) and told by Luna what its part shows.
 * 4. Exits: Sol picks where along each planned side a street or path already reaches the edge; Luna's look for a
 *    way out is painted there and blended in.
 * 5. Barrier: a seamless texture of the barrier's surface laid in a band round the edge (except at the exits) and
 *    repainted, fading inward and along the band so it meets the place and itself without seams.
 * 6. Sol checks each exit (a longer path when blocked) and lists unplanned ways off the map; each is closed with a
 *    patch of barrier that ends the road before it (three rounds at most).
 * The map is read as PAINT_PXM pixels per metre: there a character fits the narrowest passages comfortably while
 * looking only a little short (round-2 study, side-session notes tile-outpaint/REPORT_ROUND2.md).
 */
import sharp from 'sharp';
import { z } from 'zod';
import type { ZoneKind } from '@gd/shared';
import { genai } from '../genai/service';
import { seamless } from './atmosphere';
import { kreaMasked, kreaPaint, kreaRepaint, upscale } from './comfy';
import type { Side } from './mapgrid';

/** The map is painted in squares this many pixels across (Krea's working size). */
export const TILE = 1024;
/** Painted pixels per ground metre. */
export const PAINT_PXM = 40;
/** A map's size in tiles (columns, rows). */
export type Tiles = [number, number];
/** The sizes each kind of place may have, in tiles (never more than 4 × 4), and its usual size. */
export const TILE_RANGE: Record<ZoneKind, { min: Tiles; max: Tiles; usual: Tiles }> = {
  town: { min: [2, 2], max: [3, 3], usual: [3, 2] },
  wilderness: { min: [2, 2], max: [4, 4], usual: [3, 3] },
  dungeon: { min: [2, 1], max: [4, 3], usual: [3, 2] },
};
/** A size held to its kind's range. */
export function fitTiles(kind: ZoneKind, t?: readonly number[]): Tiles {
  const r = TILE_RANGE[kind];
  if (!t || t.length < 2) return [...r.usual];
  return [0, 1].map((i) => Math.max(r.min[i]!, Math.min(r.max[i]!, Math.round(t[i]!)))) as Tiles;
}
/** How many whole-place paintings Sol chooses between. */
const WHOLE_SEEDS = 8;
/** Strength of the detail pass over the enlarged painting (0.5 let rooms drift; 0.3 keeps the plan exactly). */
const DETAIL = 0.3;
/** Barrier band, exit gap, way-out width and depth, and soft edges, in painted pixels (about 3 m, 3.6 m, 4 m, 9.6 m). */
const BAND = 128, GAP = 144, PATH = 160, PATH_DEPTH = BAND + 256, FEATHER = 48;
/** The barrier's repaint fades out this far inside the band (finishing what the band cuts) and along it (blending stretches). */
const FADE_IN = 96, FADE_ALONG = 128;
/** Rounds of Sol's review and road-closing repairs. */
const CLOSE_ROUNDS = 3;

/** Picture size and ground (m) of a map of this many tiles. */
export function mapPixels([cols, rows]: Tiles): { W: number; H: number; X: number; Y: number; cols: number; rows: number } {
  const W = cols * TILE, H = rows * TILE;
  return { W, H, X: W / PAINT_PXM, Y: H / PAINT_PXM, cols, rows };
}

/** Where the ways out on one side sit along it when not chosen (fractions): one in the middle, two at thirds. */
export function gapsAlong(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
}

/** What painting a place needs to know. */
export interface MapBrief {
  world: string;
  artStyle: string;
  name: string;
  kind: ZoneKind;
  /** The map's size. */
  tiles: Tiles;
  indoor: boolean;
  description: string;
  lore?: string;
  buildings: { name: string; purpose: string }[];
  /** Ways out across the edge, by side (two on one side are spread along it). */
  sides: Side[];
  /** Ways down or in drawn inside the map (a cave mouth, stairs down, a door). */
  inner: string[];
}

/** A way out across the edge: its side and where along it (0 at the left or top end). */
export interface MapExit {
  side: Side;
  at: number;
}

const PlanSchema = z.object({
  plan: z.string().min(200).max(1400).describe('The whole map at once: where each area and landmark lies (upper left, middle...), how the main routes run between them, with counts'),
  tiles: z.array(z.string().min(40).max(400)).describe('Per tile, row by row from the top-left: the distinct area or set piece it holds'),
  ground: z.string().min(100).max(900).describe('The walkable ground of the place and what is scattered over it, seen from above'),
  style: z.string().min(60).max(500).describe('Art style, light and palette of the painting'),
  floor: z.string().min(3).max(80).describe('The main ground people walk on, in a few plain visual words ("worn grey cobblestones")'),
  floorHex: z.string().max(9).describe("The floor's colour, as hex"),
  barrier: z.string().min(3).max(80).describe('What closes off the edges of this place, in a few plain visual words'),
  barrierLook: z.string().min(30).max(300).describe('How that barrier looks from above and how it meets the ground inside'),
  barrierSurface: z.string().min(20).max(300).describe("Only the barrier's surface material as a close-up texture seen from above"),
  barrierHex: z.string().max(9).describe("The barrier's colour, as hex"),
  exitLook: z.string().min(20).max(300).describe('What a way out through the barrier looks like from above'),
  look: z.object({
    ambient: z.number().min(0.15).max(1).describe('How bright the place is: 0.2 a dark cave, 0.5 dim, 0.85 daylight'),
    lightColor: z.string().max(24).describe('Colour of the light, as hex'),
    fogColor: z.string().max(24).describe('A dark colour for unexplored ground that suits the place, as hex'),
    outdoor: z.boolean().describe('Under the open sky'),
    weather: z.enum(['none', 'rain', 'snow', 'ash', 'spores', 'embers', 'dust', 'fireflies']),
  }),
});
export type MapPlan = z.infer<typeof PlanSchema>;

const KIND_WORDS: Record<ZoneKind, string> = { town: 'a town or settlement', wilderness: 'a stretch of wild country', dungeon: 'a dungeon, cave or other dangerous inner place' };

/** Luna plans the map, knowing how it will be painted. */
export async function planMap(b: MapBrief): Promise<MapPlan> {
  const { cols, rows, X, Y } = mapPixels(b.tiles);
  const n = cols * rows;
  return genai().structured('world.design', {
    system: 'You are the level designer and art director of a 2D top-down RPG. Its places are painted by an image model (Krea 2) as big top-down maps, like tabletop battle maps, and players explore them on foot. Every place should be a memorable, fun level, not a generic one.',
    prompt: `WORLD: ${b.world}
Art style: ${b.artStyle}
PLACE: ${b.name}, ${KIND_WORDS[b.kind]}${b.indoor ? ', indoors' : ''}: ${b.description}
${b.lore ? `History: ${b.lore}\n` : ''}${b.buildings.length ? `Buildings people visit: ${b.buildings.map((x) => `${x.name} (${x.purpose})`).join('; ')}.\n` : ''}${b.inner.length ? `Ways in or down drawn inside the map: ${b.inner.join('; ')}.\n` : ''}
THE GOAL: one big top-down map of this place, about ${Math.round(X)} by ${Math.round(Y)} metres, that players walk around. A fun level to explore: distinct areas with their own character, landmarks, varied routes, and a strong, unmistakable theme, while reading as one coherent place. Most of it walkable, with every path, street or floor in view (nothing walkable hidden behind tall buildings, trees or walls) and passages at least about 1.5 m wide.
HOW IT IS MADE (so you know what each answer is for):
1. The image model first paints the whole place in one small picture from "plan", then the picture is enlarged and repainted in detail square by square (a ${cols} × ${rows} grid), each square reading its entry in "tiles" with "ground" and "style".
2. A narrow barrier is then painted round the outer edge (your "barrier", painted from "barrierSurface"), broken only where ways out leave, each painted from "exitLook". So never describe the edge of the place in "plan", "tiles" or "ground".
3. The painter takes every word literally and paints each word's most common picture: describe things by what they look like (material, shape, colour). The view is from high above, looking almost straight down: describe roofs, ground, floors, paths and the tops of things, never facades, how tall things are, or views.

Write:
- plan: the whole map at once: where each area and landmark lies (upper left, middle, lower right...), how the main routes run between them, with counts ("about thirty houses"). Choose the arrangement that suits this place (winding and organic for caves, ruins or wild country; regular rows for a barracks, a planned district or row houses), but never uniform repetition: areas of different sizes and shapes, joined by clear routes so every area can be reached, with one dominant landmark area much larger than the rest${b.kind === 'dungeon' ? ' (the great chamber where the strongest foe or the secret of the place waits)' : ''}.
- tiles: exactly ${n} entries, row by row from the top-left (${cols} per row): the distinct area or set piece each square holds, with what crosses into neighbouring squares and on which side ("the main street enters from the left and leaves at the bottom"). Each entry is read on its own: never write "tile" or "square" or refer to them by number.
- ground: the walkable ground and what is scattered over it. Go all-in on the theme: every surface and material should say what this place is.
- style: art style, light and palette, bold and true to the theme.
- floor, floorHex; barrier, barrierLook, barrierHex: the main walkable ground, and a natural barrier that suits the place and clearly reads as impassable.
- barrierSurface: only the surface material of the barrier as a close-up texture filling a picture (e.g. "churning dark teal water with white foam streaks"), never banks, edges, buildings or ground.
- exitLook: what a way out through the barrier looks like from above, about 4 m wide (a stone bridge, a gravel path through a gap cut in a hedge, a paved ramp through a cut in a cliff). It must plainly read as open walkable ground all the way: never a tunnel mouth, gate, door, arch, hole or dark opening (the painter draws those as black shapes that look like pits).
- look: how the place feels to be in, for the game's lighting.
The game draws its own people, creatures, chests and signs, so leave them out. No text or lettering anywhere.`,
    schema: PlanSchema,
    name: 'map_plan',
    // Up to sixteen tile entries (a 4×4 wild place) plus reasoning.
    maxTokens: 10000,
    validate: (v) => (v.tiles.length === n ? null : `tiles must have exactly ${n} entries`),
  });
}

// ------------------------------------------------------------------------------------------------------------- prompts

/** The lead of every painting prompt: seen from high above, almost straight down, everything walkable in view. */
const LEAD: Record<ZoneKind, string> = {
  town: 'A top-down game map seen from high above, looking almost straight down like a tabletop battle map: roofs, treetops and the ground between them are in plain view, and every street, path and open space is clearly visible. No horizon.',
  wilderness: 'A top-down game map seen from high above, looking almost straight down like a tabletop battle map: the ground, the tops of trees and rocks are in plain view, and every path and clearing is clearly visible. No horizon.',
  dungeon: 'A top-down dungeon map seen from high above, looking almost straight down like a tabletop battle map: floors and the tops of walls, pillars and objects are in plain view, and every room and passage floor is clearly visible. No horizon.',
};
const TAIL = 'No grid, no text, no labels, no people, no creatures.';

const wholePrompt = (b: MapBrief, p: MapPlan) => {
  const { X, Y } = mapPixels(b.tiles);
  return `${LEAD[b.kind]} The whole of ${b.name} in one picture, the entire place seen at once from high above, about ${Math.round(X)} by ${Math.round(Y)} metres across, so everything in it is small and there are many of each thing: ${p.plan} ${p.ground} Every area is joined to the others by open paths, streets or corridors: one connected network with no cut-off rooms or areas. The painting fills the whole picture edge to edge. Art style: ${p.style}. ${TAIL}`;
};
const detailPrompt = (b: MapBrief, p: MapPlan, note: string) =>
  `${LEAD[b.kind]} ${p.ground} This part of the place: ${note} The painting fills the whole picture edge to edge and the place continues past every edge: no border, no frame, no vignette. Art style: ${p.style}. ${TAIL}`;

// ------------------------------------------------------------------------------------------------------------- raster

/** Raw RGB pixels of a picture, for cutting windows and pasting results back. */
class Raster {
  constructor(public W: number, public H: number, public px: Buffer) {}
  static async of(png: Buffer): Promise<Raster> {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return new Raster(info.width, info.height, Buffer.from(data));
  }
  clone(): Raster {
    return new Raster(this.W, this.H, Buffer.from(this.px));
  }
  png(): Promise<Buffer> {
    return sharp(this.px, { raw: { width: this.W, height: this.H, channels: 3 } }).png().toBuffer();
  }
  crop(x: number, y: number, w: number, h: number): Promise<Buffer> {
    return sharp(this.px, { raw: { width: this.W, height: this.H, channels: 3 } }).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  }
  /** Paste a window's pixels (resized to w × h), blended by `weight(x, y)` (window coordinates, 0 keeps what is there). */
  async paste(win: Buffer, x0: number, y0: number, w: number, h: number, weight: (x: number, y: number) => number) {
    const p = await sharp(win).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, Math.min(1, weight(x, y)));
        if (!a) continue;
        const i = ((y0 + y) * this.W + x0 + x) * 3, j = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) this.px[i + c] = Math.round(p[j + c]! * a + this.px[i + c]! * (1 - a));
      }
  }
}

/** A grey mask PNG (strength 0..1 per pixel). */
const maskOf = (w: number, h: number, v: (x: number, y: number) => number) => {
  const m = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = Math.round(255 * Math.max(0, Math.min(1, v(x, y))));
  return sharp(m, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
};

/** Distance (px, chamfer 1/√2) from each pixel to the nearest set one; Infinity where none is set. */
function distanceTo(m: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < m.length; i++) if (m[i]) d[i] = 0;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + D);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + D);
      }
      d[i] = v;
    }
  return d;
}

const hex = (h: string, fallback: string) => {
  const v = /^#?[0-9a-f]{6}$/i.test(h.trim()) ? h.trim().replace('#', '') : fallback;
  return [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16));
};
const flatPng = (w: number, h: number, rgb: number[]) => {
  const px = Buffer.alloc(w * h * 3);
  let s = 7;
  for (let i = 0; i < w * h; i++) {
    const n = ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 40;
    for (let k = 0; k < 3; k++) px[i * 3 + k] = Math.max(0, Math.min(255, rgb[k]! + n));
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};
const small = (png: Buffer, max = 1024) => sharp(png).resize({ width: max, height: max, fit: 'inside' }).png().toBuffer();
/** Rotate a crop so the given side of the map is at the top of the picture. */
const edgeUp = (png: Buffer, side: Side) => sharp(png).rotate(side === 'top' ? 0 : side === 'right' ? 270 : side === 'bottom' ? 180 : 90).png().toBuffer();

// ------------------------------------------------------------------------------------------------------------- judges

const noul = (a: unknown) => (a && typeof a === 'object' && (a as { type: string }).type === 'noul' ? (a as { noul: number }).noul : 0.5);
const choice = (a: unknown) => (a && typeof a === 'object' && (a as { type: string }).type === 'choice' ? (a as { choice: string }).choice : '?');

/** Sol (the purpose's stronger model; Luna when none is configured) answers with structured output about one picture. */
async function sol<T extends z.ZodType>(prompt: string, img: Buffer, schema: T, name: string): Promise<z.infer<T>> {
  return genai().structured('world.design', { model: genai().strongModel('world.design'), prompt, schema, name, maxTokens: 16000, images: [await small(img)] });
}

/**
 * Luna's view check of a painting. Calibrated on labelled pictures: a painting is too steep only when it shows large
 * building fronts AND walkable ground hidden behind them (either answer alone misjudged good ones).
 */
async function viewCheck(png: Buffer, theme: string) {
  const a = await genai().decide('image.check', {
    state: `A top-down game map of ${theme}. Players walk on its streets, paths and floors, so every walkable place must be in view. A slight viewing angle that shows some sides of buildings, walls or objects is fine, as long as nothing hides the ground behind it.`,
    questions: {
      hidden: { type: 'noul', instructions: 'Because of the viewing angle, is any walkable ground (streets, paths, floors, open ground) hidden behind tall things such as buildings, trees, walls or pillars, so that a person walking there would be out of sight?' },
      front: { type: 'choice', instructions: 'How much of the front or side faces of buildings, walls and large objects can you see, compared with their roofs or tops?', criteria: { none: 'none: only roofs and tops', thin: 'a thin strip of front or side, much smaller than the roof', large: 'large fronts: as much or more front or side face as roof, with doors and windows clearly drawn' } },
      detail: { type: 'noul', instructions: 'Is this a finished, detailed painting with many distinct drawn things (not blank, flat or a crude colour field)?' },
      theme: { type: 'noul', instructions: `Does this look strongly and unmistakably like ${theme}?` },
    },
    images: [await small(png)],
  });
  const steep = choice(a.front) === 'large' && noul(a.hidden) > 0.5;
  return { steep, detailed: noul(a.detail) > 0.5, theme: +noul(a.theme).toFixed(2), hidden: +noul(a.hidden).toFixed(2), front: choice(a.front) };
}

const Connect = z.object({ connected: z.boolean(), cutOff: z.number().int().min(0).max(30), reason: z.string().max(400) });

// ------------------------------------------------------------------------------------------------------------- make

/** Where making a map keeps its steps (a resumed build picks up where it stopped). */
export interface MapDraft {
  json<T>(name: string): T | undefined;
  saveJson(name: string, v: unknown): void;
  png(name: string): Buffer | undefined;
  savePng(name: string, b: Buffer): void;
}

/** What making a map runs with: the GPU queue (Krea and SeedVR2 calls take their turn), its draft and progress. */
export interface MapRun {
  gpu: <T>(model: 'krea' | 'seedvr2', fn: () => Promise<T>) => Promise<T>;
  draft: MapDraft;
  report: (msg: string) => void;
  /** Steps done of MAP_STEPS. */
  step?: (done: number) => void;
}
export const MAP_STEPS = 6;

export interface MadeMap {
  png: Buffer;
  exits: MapExit[];
  /** Sol's last word on the whole map. */
  review: Review;
  /** Whether the chosen whole-place painting was judged connected and seen from above. */
  sound: boolean;
}

const ReviewSchema = z.object({
  usable: z.boolean(),
  fun: z.number().min(1).max(10),
  coherence: z.number().min(1).max(10),
  theme: z.number().min(1).max(10),
  problems: z.string().max(700),
  extraOpenings: z.array(z.object({ side: z.enum(['top', 'right', 'bottom', 'left']), at: z.number().min(0).max(1) })).max(8),
});
type Review = z.infer<typeof ReviewSchema>;

/** Paint a place's map from its plan (every step saved in the draft). */
export async function makeMap(b: MapBrief, p: MapPlan, seed: number, io: MapRun): Promise<MadeMap> {
  const theme = `${b.name}, ${KIND_WORDS[b.kind]}: ${b.description.slice(0, 200)}`;
  const whole = await chooseWhole(b, p, theme, seed, io);
  io.step?.(1);
  const guide = await enlarge(b, whole.png, seed, io);
  io.step?.(2);
  let map = io.draft.png('detailed') ?? (await detail(b, p, guide, seed, io));
  io.draft.savePng('detailed', map);
  io.step?.(3);
  const exits = await placeExits(b, p, map, io);
  map = io.draft.png('exits') ?? (await paintExits(b, p, map, exits, seed, io));
  io.draft.savePng('exits', map);
  io.step?.(4);
  map = io.draft.png('barrier') ?? (await paintBarrier(b, p, map, exits, seed, io));
  io.draft.savePng('barrier', map);
  io.step?.(5);
  const done = io.draft.json<{ review: Review }>('final');
  if (done && io.draft.png('final')) return { png: io.draft.png('final')!, exits, review: done.review, sound: whole.sound };
  const checked = await checkAndClose(b, p, map, exits, theme, seed, io);
  io.draft.savePng('final', checked.png);
  io.draft.saveJson('final', { review: checked.review, log: checked.log });
  io.step?.(6);
  return { png: checked.png, exits, review: checked.review, sound: whole.sound };
}

/**
 * Eight whole-place paintings from noise; the best connected, top-down, on-theme one. The GPU paints them one after
 * another while Luna and Sol judge those already painted.
 */
async function chooseWhole(b: MapBrief, p: MapPlan, theme: string, seed: number, io: MapRun): Promise<{ png: Buffer; sound: boolean }> {
  const { W, H } = mapPixels(b.tiles);
  const tw = Math.round(Math.sqrt((1.5e6 * W) / H) / 16) * 16, th = Math.round(tw / (W / H) / 16) * 16;
  const prompt = wholePrompt(b, p);
  type Judged = Awaited<ReturnType<typeof viewCheck>> & z.infer<typeof Connect>;
  const judge = async (name: string, png: Buffer): Promise<Judged> => {
    const saved = io.draft.json<Judged>(name);
    if (saved) return saved;
    const [view, connect] = await Promise.all([
      viewCheck(png, theme),
      sol(`A small painting of a whole top-down RPG level, ${theme}, seen from high above. Players walk on its open floors, streets, paths and corridors. Can a person walk from every room or area to every other one along open ground, without crossing walls, solid rock, buildings or deep water? Count the rooms or areas that are cut off from the main connected part.`, png, Connect, 'connected'),
    ]);
    const j = { ...view, ...connect };
    io.draft.saveJson(name, j);
    return j;
  };
  const judged: Promise<{ t: number; png: Buffer; j: Judged }>[] = [];
  for (let t = 0; t < WHOLE_SEEDS; t++) {
    const name = `whole_${seed + t}`;
    const png = io.draft.png(name) ?? (await io.gpu('krea', () => kreaPaint(prompt, tw, th, seed + t)));
    io.draft.savePng(name, png);
    const out = judge(name, png).then((j) => ({ t, png, j }));
    out.catch(() => undefined);
    judged.push(out);
  }
  let best: { s: number; png: Buffer; sound: boolean } | undefined;
  const tries: unknown[] = [];
  for (const { t, png, j } of await Promise.all(judged)) {
    const sound = j.connected && !j.steep && j.detailed;
    const s = (sound ? 10 : 0) + (j.connected ? 5 : -2 * j.cutOff) + 2 * j.theme - (j.steep ? 5 : 0);
    tries.push({ seed: seed + t, connected: j.connected, cutOff: j.cutOff, steep: j.steep, theme: j.theme });
    if (!best || s > best.s) best = { s, png, sound };
  }
  io.report(`${b.name}: ${tries.filter((x) => (x as { connected: boolean }).connected).length} of ${WHOLE_SEEDS} whole-place paintings connected${best!.sound ? '' : ' (none fully sound: kept the best)'}`);
  return { png: best!.png, sound: best!.sound };
}

/** The chosen painting enlarged to the map's size by SeedVR2 (whole factor, then resized). */
async function enlarge(b: MapBrief, whole: Buffer, seed: number, io: MapRun): Promise<Buffer> {
  const saved = io.draft.png('enlarged');
  if (saved) return saved;
  const { W, H } = mapPixels(b.tiles);
  const meta = await sharp(whole).metadata();
  const factor = Math.max(2, Math.round(Math.max(W / meta.width!, H / meta.height!)));
  const big = await io.gpu('seedvr2', () => upscale(whole, factor, seed));
  const out = await sharp(big).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer();
  io.draft.savePng('enlarged', out);
  return out;
}

const NotesSchema = z.object({ tiles: z.array(z.string().min(40).max(400)) });

/**
 * Detail over the enlarged painting: overlapping 1024 px windows (stride 768, centre outward), each Krea at DETAIL
 * with a soft mask (nothing over pixels already detailed, ramping up across the overlap), told by Luna what that part
 * of the painting shows.
 */
async function detail(b: MapBrief, p: MapPlan, guide: Buffer, seed: number, io: MapRun): Promise<Buffer> {
  const { W, H, cols, rows } = mapPixels(b.tiles);
  const notes = io.draft.json<string[]>('notes') ?? (await partNotes(b, p, guide, cols, rows));
  io.draft.saveJson('notes', notes);
  const S = TILE, ST = 768, R = (S - ST) / 2;
  const starts = (n: number) => {
    const o: number[] = [];
    for (let v = 0; ; v += ST) {
      o.push(Math.max(0, Math.min(v, n - S)));
      if (v + S >= n) break;
    }
    return o;
  };
  const wins = starts(H).flatMap((y0) => starts(W).map((x0) => [x0, y0] as const))
    .sort((a, c) => Math.hypot(a[0] + S / 2 - W / 2, a[1] + S / 2 - H / 2) - Math.hypot(c[0] + S / 2 - W / 2, c[1] + S / 2 - H / 2));
  const cv = await Raster.of(guide);
  const done = new Uint8Array(W * H);
  for (const [k, [x0, y0]] of wins.entries()) {
    const fresh = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (!done[(y0 + y) * W + x0 + x]) fresh[y * S + x] = 1;
    const d = distanceTo(fresh, S, S);
    const strength = (i: number) => (fresh[i] ? 1 : d[i]! <= R ? 1 - d[i]! / R : 0);
    const c = Math.min(cols - 1, Math.floor((x0 + S / 2) / TILE)), r = Math.min(rows - 1, Math.floor((y0 + S / 2) / TILE));
    const out = await io.gpu('krea', async () => kreaMasked(await cv.crop(x0, y0, S, S), await maskOf(S, S, (x, y) => strength(y * S + x)), detailPrompt(b, p, notes[r * cols + c] ?? p.tiles[r * cols + c] ?? ''), seed + 300 + k, DETAIL));
    await cv.paste(out, x0, y0, S, S, (x, y) => strength(y * S + x));
    for (let y = 0; y < S; y++) done.fill(1, (y0 + y) * W + x0, (y0 + y) * W + x0 + S);
  }
  return cv.png();
}

/** Luna writes what each tile of the painting shows (the grid drawn on it), so the detail pass keeps its layout. */
async function partNotes(b: MapBrief, p: MapPlan, guide: Buffer, cols: number, rows: number): Promise<string[]> {
  const view = await sharp(guide).resize({ width: 1536 }).png().toBuffer();
  const vm = await sharp(view).metadata(), k = vm.width! / (cols * TILE);
  const lines = [...Array(cols + 1).keys()].map((i) => `<line x1="${i * TILE * k}" y1="0" x2="${i * TILE * k}" y2="${vm.height}" stroke="white" stroke-width="3"/>`).join('')
    + [...Array(rows + 1).keys()].map((j) => `<line x1="0" y1="${j * TILE * k}" x2="${vm.width}" y2="${j * TILE * k}" stroke="white" stroke-width="3"/>`).join('')
    + [...Array(cols * rows).keys()].map((n) => `<text x="${(n % cols) * TILE * k + 12}" y="${Math.floor(n / cols) * TILE * k + 40}" font-size="34" font-family="Arial" font-weight="bold" fill="white" stroke="black" stroke-width="4" paint-order="stroke">${n + 1}</text>`).join('');
  const img = await sharp(view).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${vm.width}" height="${vm.height}">${lines}</svg>`), left: 0, top: 0 }]).png().toBuffer();
  const n = cols * rows;
  const out = await genai().structured('world.design', {
    system: 'You are the level designer of a 2D top-down RPG whose places are painted by an image model.',
    prompt: `This is a small painting of a whole place: ${b.name}. It will be repainted at full size and full detail square by square; the white grid and numbers 1–${n} (row by row from the top-left) mark the squares. The painter repaints each square seeing only its neighbours and one short description, so for each square write what this painting shows in it, so the full-size version keeps this layout: the areas, landmarks, buildings, routes and their materials, where they sit in the square (left, upper right, middle...), and which routes, rivers or walls cross into neighbouring squares and on which side. Describe things by what they look like, seen from high above. Never mention squares, numbers, grid or tiles in the descriptions; never mention people or text. Place style for reference: ${p.style}`,
    schema: NotesSchema,
    name: 'part_notes',
    // One description per tile plus the model's reasoning (5000 ran out on a 3×2 town).
    maxTokens: 12000,
    images: [img],
    validate: (v) => (v.tiles.length === n ? null : `tiles must have exactly ${n} entries`),
  });
  return out.tiles;
}

// ------------------------------------------------------------------------------------------------------------- exits

const along = (side: Side, W: number, H: number) => (side === 'top' || side === 'bottom' ? W : H);
/** The planned exits: each side's ways out spread along it before Sol moves them. */
const plannedExits = (sides: Side[]): MapExit[] => {
  const out: MapExit[] = [];
  for (const s of new Set(sides)) for (const at of gapsAlong(sides.filter((x) => x === s).length)) out.push({ side: s, at });
  return out;
};

/** Sol picks, for each planned exit, the spot along its side (within ±20%) where a street or path already reaches the edge. */
async function placeExits(b: MapBrief, p: MapPlan, map: Buffer, io: MapRun): Promise<MapExit[]> {
  const saved = io.draft.json<MapExit[]>('exitspots');
  if (saved) return saved;
  const { W, H } = mapPixels(b.tiles);
  const cv = await Raster.of(map);
  const out = await Promise.all(plannedExits(b.sides).map(async (e): Promise<MapExit> => {
    const n = along(e.side, W, H);
    const cands = Array.from({ length: 7 }, (_, j) => Math.max(0.1, Math.min(0.9, e.at + (j - 3) * 0.067)));
    const a0 = Math.max(0, Math.round(cands[0]! * n - 256)), a1 = Math.min(n, Math.round(cands[6]! * n + 256)), D = 448;
    const win = e.side === 'top' ? { x: a0, y: 0, w: a1 - a0, h: D } : e.side === 'bottom' ? { x: a0, y: H - D, w: a1 - a0, h: D } : e.side === 'left' ? { x: 0, y: a0, w: D, h: a1 - a0 } : { x: W - D, y: a0, w: D, h: a1 - a0 };
    const crop = await edgeUp(await cv.crop(win.x, win.y, win.w, win.h), e.side);
    const meta = await sharp(crop).metadata(), cw = meta.width!;
    // Bottom and left crops are turned, so their spots run the other way along the picture's top edge.
    const fr = cands.map((c) => (c * n - a0) / (a1 - a0)).map((t) => (e.side === 'bottom' || e.side === 'left' ? 1 - t : t));
    const marks = fr.map((t, j) => `<circle cx="${t * cw}" cy="34" r="22" fill="white" fill-opacity="0.9" stroke="black" stroke-width="3"/><text x="${t * cw}" y="45" font-size="30" font-family="Arial" font-weight="bold" text-anchor="middle" fill="black">${j + 1}</text>`).join('');
    const img = await sharp(crop).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${meta.height}">${marks}</svg>`), left: 0, top: 0 }]).png().toBuffer();
    const pick = await sol(`A strip along the edge of a top-down game map of ${b.name}; the top edge of this picture is the outer edge of the map. A way out of the map will be made at one of the numbered spots (1–7): a path about 4 m wide from that spot straight down into the place for about 8 m, then joining it. Pick the number where such a path would join the place most naturally and need the least change: where a street, path, clearing or open floor already reaches closest to the edge, with no building, water, wall or large object in the way.`, img, z.object({ spot: z.number().int().min(1).max(7), reason: z.string().max(300) }), 'exit_spot');
    return { side: e.side, at: +cands[pick.spot - 1]!.toFixed(3) };
  }));
  io.draft.saveJson('exitspots', out);
  return out;
}

/** An exit's gap in the band, and its way-out strip `depth` px in from the edge (picture px). */
function exitRect(e: MapExit, W: number, H: number, width: number, depth: number) {
  const c = Math.round(e.at * along(e.side, W, H));
  return e.side === 'top' ? { x0: c - width / 2, x1: c + width / 2, y0: 0, y1: depth } : e.side === 'bottom' ? { x0: c - width / 2, x1: c + width / 2, y0: H - depth, y1: H } : e.side === 'left' ? { x0: 0, x1: depth, y0: c - width / 2, y1: c + width / 2 } : { x0: W - depth, x1: W, y0: c - width / 2, y1: c + width / 2 };
}
const inside = (r: { x0: number; x1: number; y0: number; y1: number }, x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;

/** Luna's look for a way out, painted as a strip running up the picture (its top end is the map edge). */
async function exitTexture(b: MapBrief, p: MapPlan, seed: number, io: MapRun): Promise<Buffer> {
  const saved = io.draft.png('exit_texture');
  if (saved) return saved;
  const png = await io.gpu('krea', () => kreaPaint(`Seen from directly above, a flat top-down view: ${p.exitLook} It runs straight up the middle of the picture from the bottom edge to the top edge and fills the width of the picture. Painted game art, in this style: ${p.style}. ${TAIL}`, 448, 1088, seed + 35));
  io.draft.savePng('exit_texture', png);
  return png;
}

/** Paint a way out at an exit: the exit texture laid in its strip, then repainted with a soft edge so it blends. */
async function wayOut(cv: Raster, b: MapBrief, p: MapPlan, e: MapExit, depth: number, seed: number, io: MapRun) {
  const { W, H } = cv;
  const r = exitRect(e, W, H, PATH, depth);
  const rx = Math.round(r.x0), ry = Math.round(r.y0), rw = Math.round(r.x1) - rx, rh = Math.round(r.y1) - ry;
  const S = 768, wx = Math.max(0, Math.min(W - S, Math.round((r.x0 + r.x1) / 2 - S / 2))), wy = Math.max(0, Math.min(H - S, Math.round((r.y0 + r.y1) / 2 - S / 2)));
  const src = cv.clone();
  const turned = await sharp(await exitTexture(b, p, seed, io)).rotate(e.side === 'top' ? 0 : e.side === 'bottom' ? 180 : e.side === 'left' ? 270 : 90).resize(rw, rh, { fit: 'fill' }).png().toBuffer();
  await src.paste(turned, rx, ry, rw, rh, () => 1);
  const strength = (x: number, y: number) => {
    const dx = Math.max(r.x0 - x, x - (r.x1 - 1), 0), dy = Math.max(r.y0 - y, y - (r.y1 - 1), 0), d = Math.hypot(dx, dy);
    return d === 0 ? 1 : d < FEATHER ? 1 - d / FEATHER : 0;
  };
  const prompt = `${LEAD[b.kind]} A way out: ${p.exitLook} It leads straight from the place to the ${e.side} edge of the picture and off the map, open so anyone can walk along it, joining the streets and open ground of the place. Art style: ${p.style}. ${TAIL}`;
  const out = await io.gpu('krea', async () => kreaMasked(await src.crop(wx, wy, S, S), await maskOf(S, S, (x, y) => strength(x + wx, y + wy)), prompt, seed, 0.75));
  await cv.paste(out, wx, wy, S, S, (x, y) => strength(x + wx, y + wy));
}

async function paintExits(b: MapBrief, p: MapPlan, map: Buffer, exits: MapExit[], seed: number, io: MapRun): Promise<Buffer> {
  const cv = await Raster.of(map);
  for (const [k, e] of exits.entries()) await wayOut(cv, b, p, e, PATH_DEPTH, seed + 400 + k, io);
  return cv.png();
}

// ------------------------------------------------------------------------------------------------------------- barrier

/** The barrier's surface as a seamless texture (Luna checks it shows the barrier alone; up to four tries). */
async function barrierTexture(p: MapPlan, seed: number, io: MapRun): Promise<Raster> {
  const saved = io.draft.png('barrier_texture');
  if (saved) return Raster.of(saved);
  const flat = await flatPng(TILE, TILE, hex(p.barrierHex, '303030'));
  let best: { v: number; png: Buffer } | undefined;
  for (let t = 0; t < 4; t++) {
    const png = await io.gpu('krea', () => kreaRepaint(flat, `A seamless texture seen from directly above, filling the whole picture edge to edge: ${p.barrierSurface} Nothing else at all. Painted game art, in this style: ${p.style}.`, TILE, TILE, seed + 30 + t, 0.75));
    const a = await genai().decide('image.check', { state: 'A texture for the barrier round the edge of a top-down game map.', questions: { only: { type: 'noul', instructions: `Is the whole picture filled edge to edge with ${p.barrier} only, with no ground, banks, buildings, paths or anything else, and no border?` } }, images: [await small(png)] });
    if (!best || noul(a.only) > best.v) best = { v: noul(a.only), png };
    if (best.v > 0.8) break;
  }
  // Repeated every TILE px along the band, so its edges must meet: rolled by half and the cross repainted.
  const raw = await io.gpu('krea', () => seamless(best!.png, `A seamless texture seen from directly above, filling the whole picture: ${p.barrierSurface} Nothing else.`, seed + 36));
  const png = await sharp(raw, { raw: { width: TILE, height: TILE, channels: 3 } }).png().toBuffer();
  io.draft.savePng('barrier_texture', png);
  return Raster.of(png);
}

/** The barrier band round the edge, painted in windows round the perimeter (see the file comment). */
async function paintBarrier(b: MapBrief, p: MapPlan, map: Buffer, exits: MapExit[], seed: number, io: MapRun): Promise<Buffer> {
  const cv = await Raster.of(map);
  const { W, H } = cv;
  const tex = await barrierTexture(p, seed, io);
  const inBand = (x: number, y: number) => x < BAND || y < BAND || x >= W - BAND || y >= H - BAND;
  const gaps = exits.map((e) => exitRect(e, W, H, GAP, BAND));
  const inGap = (x: number, y: number) => gaps.some((r) => inside(r, x, y));
  const pastBand = (x: number, y: number) => Math.min(x - BAND, y - BAND, W - BAND - 1 - x, H - BAND - 1 - y);
  const D = 512, L = 1024, ST = 768;
  const starts = (n: number) => {
    const o: number[] = [];
    for (let v = 0; ; v += ST) {
      o.push(Math.max(0, Math.min(v, n - L)));
      if (v + L >= n) break;
    }
    return o;
  };
  const segs = [
    ...starts(W).map((x) => ({ side: 'top' as Side, x, y: 0, w: L, h: D })),
    ...starts(H).map((y) => ({ side: 'right' as Side, x: W - D, y, w: D, h: L })),
    ...starts(W).reverse().map((x) => ({ side: 'bottom' as Side, x, y: H - D, w: L, h: D })),
    ...starts(H).reverse().map((y) => ({ side: 'left' as Side, x: 0, y, w: D, h: L })),
  ];
  const painted = new Uint8Array(W * H);
  for (const [k, s] of segs.entries()) {
    const fresh = (x: number, y: number) => inBand(x, y) && !painted[y * W + x] && !inGap(x, y);
    const freshM = new Uint8Array(s.w * s.h);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (fresh(s.x + x, s.y + y)) freshM[y * s.w + x] = 1;
    const near = distanceTo(freshM, s.w, s.h);
    const strength = (x: number, y: number) => {
      const X = s.x + x, Y = s.y + y;
      if (inGap(X, Y)) return 0;
      if (freshM[y * s.w + x]) return 1;
      if (inBand(X, Y)) return painted[Y * W + X] && near[y * s.w + x]! <= FADE_ALONG ? 1 - near[y * s.w + x]! / FADE_ALONG : 0;
      const d = pastBand(X, Y);
      return d < FADE_IN ? 1 - d / FADE_IN : 0;
    };
    const src = cv.clone();
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) if (fresh(x, y)) tex.px.copy(src.px, (y * W + x) * 3, ((y % TILE) * TILE + (x % TILE)) * 3, ((y % TILE) * TILE + (x % TILE)) * 3 + 3);
    const edges = [s.y === 0 && 'top', s.x + s.w === W && 'right', s.y + s.h === H && 'bottom', s.x === 0 && 'left'].filter(Boolean) as Side[];
    const here = exits.filter((e, i) => { const r = gaps[i]!; return r.x0 < s.x + s.w && r.x1 > s.x && r.y0 < s.y + s.h && r.y1 > s.y; });
    const prompt = `${LEAD[b.kind]} Along the ${edges.join(' and ')} edge${edges.length > 1 ? 's' : ''} of this picture runs the outer edge of the place: a solid, continuous belt of ${p.barrier} about four metres wide, ${p.barrierLook} It closes the place off so nobody can pass through it.${here.length ? ` The belt is broken by exactly ${here.length === 1 ? 'one opening' : `${here.length} openings`}, where the way out runs straight through it and off the edge of the picture.` : ' The belt is unbroken: no gap, path, gate or opening anywhere along it.'} Inside the belt the place continues as already painted; anything cut by the belt is finished off neatly or removed. Art style: ${p.style}. ${TAIL}`;
    const out = await io.gpu('krea', async () => kreaMasked(await src.crop(s.x, s.y, s.w, s.h), await maskOf(s.w, s.h, strength), prompt, seed + 500 + k, 0.75));
    await cv.paste(out, s.x, s.y, s.w, s.h, strength);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (freshM[y * s.w + x]) painted[(s.y + y) * W + s.x + x] = 1;
  }
  return cv.png();
}

// ------------------------------------------------------------------------------------------------------------- check

/** Sol checks each exit (a longer way out when blocked, twice at most), then closes unplanned ways off the map. */
async function checkAndClose(b: MapBrief, p: MapPlan, map: Buffer, exits: MapExit[], theme: string, seed: number, io: MapRun) {
  const cv = await Raster.of(map);
  const { W, H } = cv;
  const log: unknown[] = [];
  const CROP = 640;
  const exitCrop = (e: MapExit) => {
    const r = exitRect(e, W, H, GAP, BAND), cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    return cv.crop(Math.max(0, Math.min(W - CROP, Math.round(cx - CROP / 2))), Math.max(0, Math.min(H - CROP, Math.round(cy - CROP / 2))), CROP, CROP).then((c) => edgeUp(c, e.side));
  };
  const isOpen = async (e: MapExit, t: number) => {
    const open = await sol(`A piece of a top-down game map of ${theme}, seen from high above. The top edge of this picture is the outer edge of the map, closed off by ${p.barrier}. Near the middle of the top edge there must be a way out: can a person walk on open ground from the place (the lower part of the picture) up through the barrier and off the top edge, without crossing ${p.barrier}, buildings, water, walls or other obstacles? Answer true only if they clearly can.`, await exitCrop(e), z.object({ answer: z.boolean(), reason: z.string().max(400) }), 'exit_open');
    log.push({ exit: e, try: t, open: open.answer, why: open.reason });
    return open.answer;
  };
  const first = await Promise.all(exits.map((e) => isOpen(e, 0)));
  for (const [k, e] of exits.entries())
    for (let t = 1, open = first[k]; !open && t <= 2; t++) {
      await wayOut(cv, b, p, e, BAND + 14 * 32, seed + 900 + 10 * k + t - 1, io);
      open = await isOpen(e, t);
    }
  const tex = await barrierTexture(p, seed, io);
  const review = async () => sol(`You are a senior level designer reviewing an AI-painted top-down RPG level: ${theme}. It is closed round its edge by ${p.barrier} with ways out only at: ${exits.map((e) => `${e.side} edge at ${Math.round(e.at * 100)}%`).join('; ')}. A slight viewing angle is fine as long as no walkable ground is hidden behind tall things. Judge it as a playable level: usable (true if a game could ship it as is: coherent, seamless, closed except at the planned exits, walkable ground in view), and score 1–10 how fun and interesting it would be to explore, how coherent its overall layout is, and how strongly it shows its theme. In "problems", name the worst problems and where they are. In "extraOpenings", list every place OTHER than the planned exits where a person could walk off the map through or around the barrier (a road, street, passage, path or gap reaching the edge): its side, and its position along that side from 0 (left or top end) to 1 (right or bottom end).`, await cv.png(), ReviewSchema, 'level_review');
  let rv = await review();
  log.push({ round: 0, openings: rv.extraOpenings });
  for (let round = 1; rv.extraOpenings.length && round <= CLOSE_ROUNDS; round++) {
    for (const [j, o] of rv.extraOpenings.entries()) {
      const n = along(o.side, W, H), a = o.at * n;
      if (exits.some((e) => e.side === o.side && Math.abs(e.at * n - a) < 120)) continue;
      await closeOpening(cv, b, p, o, tex, seed + 700 + 10 * round + j, io);
    }
    rv = await review();
    log.push({ round, openings: rv.extraOpenings });
  }
  if (rv.extraOpenings.length) io.report(`${b.name}: ${rv.extraOpenings.length} unplanned way(s) off the map remain after ${CLOSE_ROUNDS} rounds`);
  return { png: await cv.png(), review: rv, log };
}

/** Close an unplanned way off the map: barrier texture in the band and a soft patch 6 m deep, where the ground ends before the barrier. */
async function closeOpening(cv: Raster, b: MapBrief, p: MapPlan, o: MapExit, tex: Raster, seed: number, io: MapRun) {
  const { W, H } = cv;
  const HALF = 128, DEEP = BAND + 192, F = 64;
  const a = o.at * along(o.side, W, H);
  const r = o.side === 'top' ? { x0: a - HALF, x1: a + HALF, y0: 0, y1: DEEP } : o.side === 'bottom' ? { x0: a - HALF, x1: a + HALF, y0: H - DEEP, y1: H } : o.side === 'left' ? { x0: 0, x1: DEEP, y0: a - HALF, y1: a + HALF } : { x0: W - DEEP, x1: W, y0: a - HALF, y1: a + HALF };
  const depth = (x: number, y: number) => (o.side === 'top' ? y : o.side === 'bottom' ? H - 1 - y : o.side === 'left' ? x : W - 1 - x);
  const S = 768, wx = Math.max(0, Math.min(W - S, Math.round((r.x0 + r.x1) / 2 - S / 2))), wy = Math.max(0, Math.min(H - S, Math.round((r.y0 + r.y1) / 2 - S / 2)));
  const strength = (x: number, y: number) => {
    const dx = Math.max(r.x0 - x, x - (r.x1 - 1), 0), dy = Math.max(r.y0 - y, y - (r.y1 - 1), 0), d = Math.hypot(dx, dy);
    return d === 0 ? 1 : d < F ? 1 - d / F : 0;
  };
  const src = cv.clone();
  for (let y = wy; y < wy + S; y++) for (let x = wx; x < wx + S; x++) if (strength(x, y) > 0 && depth(x, y) < BAND) tex.px.copy(src.px, (y * W + x) * 3, ((y % TILE) * TILE + (x % TILE)) * 3, ((y % TILE) * TILE + (x % TILE)) * 3 + 3);
  const prompt = `${LEAD[b.kind]} Along the ${o.side} edge of the map runs a solid, unbroken belt of ${p.barrier}: ${p.barrierLook} Nothing can pass through it. Just inside it, the ground of the place (${p.floor}) ends naturally before the barrier: no road, path or street continues into the barrier or off the map here. Art style: ${p.style}. ${TAIL}`;
  const out = await io.gpu('krea', async () => kreaMasked(await src.crop(wx, wy, S, S), await maskOf(S, S, (x, y) => strength(x + wx, y + wy)), prompt, seed, 0.85));
  await cv.paste(out, wx, wy, S, S, (x, y) => strength(x + wx, y + wy));
}

/** The barrier band's depth in metres (the walk plan blocks it except at the exits). */
export const BARRIER_DEPTH_M = BAND / PAINT_PXM;
/** An exit's gap width in metres. */
export const EXIT_GAP_M = GAP / PAINT_PXM;
