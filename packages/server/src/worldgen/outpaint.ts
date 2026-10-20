/**
 * Painting a place: Luna designs the whole place and cuts it into a grid of overlapping parts; Krea 2 paints the
 * middle part from text, and continues outwards part by part (AnyPaint), each part seeing the painted ones.
 *
 * Why it is done this way (see docs/painted-zones.md): centre-out spreads drift both ways; a margin of every window
 * is painted but thrown away on sides more parts will continue from (a picture's outer strip is where the model
 * darkens and closes the scene off); new paint replaces old only by a hard cut just past AnyPaint's own redrawn band,
 * where the two already match, so nothing is ever cross-faded into mud or ghosts.
 */
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service';
import { kreaContinue, kreaPaint } from './comfy';

/** Window size: 1.5 MP, the size AnyPaint and 16 GB of VRAM handle well. */
export const WIN_W = 1728;
export const WIN_H = 864;
/** Painted past what is kept, on sides more parts continue from. */
const MARGIN_X = 360;
const MARGIN_Y = Math.round((MARGIN_X * WIN_H) / WIN_W);
/** AnyPaint redraws this much of the old paint at the boundary; the cut goes just past it. */
const REDRAW = 32;
const CUT = 48;

/** What a place must hold, for its design. */
export interface PlaceBrief {
  world: string;
  artStyle: string;
  name: string;
  kind: string;
  indoor: boolean;
  description: string;
  lore?: string;
  /** Enterable buildings (towns). */
  buildings: { name: string; purpose: string }[];
  /** Ways out: where they lead. */
  exits: string[];
  cols: number;
  rows: number;
}

const PlanSchema = z.object({
  layout: z.string().min(80).max(1200).describe('The whole place as one design: its major structures, rooms or areas, where they sit, and how the routes run through it'),
  style: z.string().min(80).max(900).describe('Shared by every part: art style, light (direction, colour), palette, ground materials'),
  look: z.object({
    ambient: z.number().min(0.15).max(1).describe('How bright the place is: 0.2 a dark cave, 0.5 dim, 0.85 daylight'),
    lightColor: z.string().max(24).describe('Colour of the light, as hex'),
    fogColor: z.string().max(24).describe('A dark colour for unexplored ground that suits the place, as hex'),
    outdoor: z.boolean().describe('Under the open sky'),
    weather: z.enum(['none', 'rain', 'snow', 'ash', 'spores', 'embers', 'dust', 'fireflies']),
  }),
  parts: z.array(z.object({ col: z.number().int(), row: z.number().int(), content: z.string().min(40).max(700) })),
});
export type PaintPlan = z.infer<typeof PlanSchema> & { cols: number; rows: number };

export async function planPlace(b: PlaceBrief): Promise<PaintPlan> {
  const cells = Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => `(col ${c}, row ${r})`).join(' ')).join('\n');
  const ids = new Set(Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => `${c},${r}`)).flat());
  const out = await genai().structured('world.design', {
    system: 'You are the level designer and art director of a 2D isometric RPG. Each place is painted by an image model as one large illustration, part by part, seen from above.',
    prompt: `WORLD: ${b.world}
Art style: ${b.artStyle}
PLACE: ${b.name} (${b.kind}${b.indoor ? ', indoors' : ''}): ${b.description}
${b.lore ? `History: ${b.lore}\n` : ''}${b.buildings.length ? `Buildings that can be entered, each with a clearly visible door on a wall facing the viewer: ${b.buildings.map((x) => `${x.name} (${x.purpose})`).join('; ')}.\n` : ''}${b.exits.length ? `Ways out (each a path, road, corridor, door or stairs that clearly leads out of the picture or into the ground): ${b.exits.join('; ')}.\n` : ''}
The picture is painted as a grid of ${b.cols}×${b.rows} overlapping parts (col 0 is the left of the picture, row 0 the top):
${cells}
Plan the place as one real, believable location, then cut it into the parts:
- layout: the whole place as a single design: its major structures, rooms or areas, where they sit in the picture, and how the routes run through it. Routes follow the logic of the place (a main street with side lanes, a trail winding between clearings, corridors between rooms), never the same grid repeated in every part. About half of the ground is open to walk on.${b.indoor ? ' Indoors: rooms and areas divided by walls with doorways, shown as a cutaway with no ceiling.' : ''}
- style: one paragraph every part shares: art style, light direction and colour, palette, ground materials.
- look: how the place feels to be in, for the game's lighting.
- parts: for each part, 2-4 sentences describing exactly the slice of the layout inside it, in plain spatial words (left, right, upper, lower), naming what carries on into the neighbouring parts. A part can be mostly open ground, mostly building or mostly wall if that is where the layout puts it. Keep the scale close: a door is about a twentieth of a part's height; give counts ("two houses", "a cluster of four cubicles").
Everything is ordinary, physically plausible and reads clearly from above: no surreal effects on the ground, no drifts of loose debris, nothing floating.
The painter is an image model that reads every word literally and paints each word's most common picture. Describe things by what they look like (material, shape, colour, size), never by names that commonly picture something else: write "a packed dirt road", not "a cart track" (it paints a railway); "stone steps", not "a stair passage". Leave out fine marks drawn as long parallel lines (wheel ruts, grooves, tracks in the ground): they turn into rails. Never mention anything that should not appear, not even to exclude it.
The game draws its own people, creatures, chests, loot and signs on top, so describe only the place itself. No text or lettering.`,
    schema: PlanSchema,
    name: 'paint_plan',
    maxTokens: 4000,
    validate: (p) => {
      const got = new Set(p.parts.map((x) => `${x.col},${x.row}`));
      const missing = [...ids].filter((k) => !got.has(k));
      return missing.length ? `Describe every part; missing (col,row): ${missing.join(' ')}.` : null;
    },
  });
  return { ...out, cols: b.cols, rows: b.rows };
}

const CAMERA =
  'An isometric video game level, orthographic 2:1 isometric projection with parallel lines and no perspective, seen from above like a classic isometric RPG, no sky and no horizon. Every wall, building and object follows the isometric grid. A close view from inside the level: it fills the whole frame edge to edge and continues past every edge of the picture, with no background, border or empty space around it. No people, no creatures, no text.';

function partPrompt(plan: PaintPlan, col: number, row: number, first: boolean): string {
  const part = plan.parts.find((p) => p.col === col && p.row === row)?.content ?? '';
  const lead = first ? '' : 'Part of this level is already painted. Continue it seamlessly into the rest of the picture with the same style, light, scale and materials, joining every path, wall and surface across the boundary. ';
  return `${lead}${CAMERA}\n\n${plan.style}\n\nThis part: ${part}`;
}

/** The canvas size a plan paints. */
export function canvasSize(cols: number, rows: number) {
  const span = (n: number, win: number, margin: number) => win + (n - 1) * (win / 2 - margin);
  return { width: span(cols, WIN_W, MARGIN_X), height: span(rows, WIN_H, MARGIN_Y) };
}

/** Centre-out order of 0..n-1: the middle first, then alternately outwards. */
function outward(n: number): number[] {
  const mid = Math.floor((n - 1) / 2);
  const out = [mid];
  for (let d = 1; out.length < n; d++) {
    if (mid - d >= 0) out.push(mid - d);
    if (mid + d < n) out.push(mid + d);
  }
  return out;
}

/** Distance (chamfer, px) from each known pixel to the nearest unknown one; 0 on unknown pixels. */
function distanceToUnknown(known: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = known[i] ? 1e9 : 0;
  const R2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + R2);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + R2);
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
        v = Math.min(v, d[i + w]! + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + R2);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + R2);
      }
      d[i] = v;
    }
  return d;
}

/** Paint a planned place onto one canvas (PNG). `onPart` sees the canvas after each part. */
export async function paintPlace(plan: PaintPlan, seed: number, onPart?: (done: number, total: number) => void): Promise<Buffer> {
  const { width: W, height: H } = canvasSize(plan.cols, plan.rows);
  const xs = Array.from({ length: plan.cols }, (_, c) => c * (WIN_W / 2 - MARGIN_X));
  const ys = Array.from({ length: plan.rows }, (_, r) => r * (WIN_H / 2 - MARGIN_Y));
  const canvas = Buffer.alloc(W * H * 3);
  const done = new Uint8Array(W * H);
  const painted = new Set<string>();
  const pending = (c: number, r: number) => c >= 0 && r >= 0 && c < plan.cols && r < plan.rows && !painted.has(`${c},${r}`);
  const order = outward(plan.rows).flatMap((row) => outward(plan.cols).map((col) => [col, row] as const));
  let i = 0;
  for (const [col, row] of order) {
    const x0 = xs[col]!, y0 = ys[row]!;
    // Kept: the whole window, except the margin on sides facing parts not painted yet.
    const kx0 = pending(col - 1, row) ? MARGIN_X : 0, kx1 = pending(col + 1, row) ? WIN_W - MARGIN_X : WIN_W;
    const ky0 = pending(col, row - 1) ? MARGIN_Y : 0, ky1 = pending(col, row + 1) ? WIN_H - MARGIN_Y : WIN_H;
    painted.add(`${col},${row}`);
    const known = new Uint8Array(WIN_W * WIN_H);
    for (let y = 0; y < WIN_H; y++) for (let x = 0; x < WIN_W; x++) known[y * WIN_W + x] = done[(y0 + y) * W + x0 + x]!;
    const prompt = partPrompt(plan, col, row, i === 0);
    let out: Buffer;
    if (i === 0) out = await kreaPaint(prompt, WIN_W, WIN_H, seed);
    else {
      const win = await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).extract({ left: x0, top: y0, width: WIN_W, height: WIN_H }).png().toBuffer();
      const unknown = Buffer.alloc(WIN_W * WIN_H);
      for (let k = 0; k < unknown.length; k++) unknown[k] = known[k] ? 0 : 255;
      out = await kreaContinue(win, await sharp(unknown, { raw: { width: WIN_W, height: WIN_H, channels: 1 } }).png().toBuffer(), prompt, seed + i, REDRAW);
    }
    const px = await sharp(out).resize(WIN_W, WIN_H).removeAlpha().raw().toBuffer();
    const dist = i === 0 ? null : distanceToUnknown(known, WIN_W, WIN_H);
    for (let y = ky0; y < ky1; y++)
      for (let x = kx0; x < kx1; x++) {
        const k = y * WIN_W + x;
        if (dist && known[k] && dist[k]! > CUT) continue;
        const c = ((y0 + y) * W + x0 + x) * 3;
        canvas[c] = px[k * 3]!;
        canvas[c + 1] = px[k * 3 + 1]!;
        canvas[c + 2] = px[k * 3 + 2]!;
        done[(y0 + y) * W + x0 + x] = 1;
      }
    onPart?.(++i, order.length);
  }
  return sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
