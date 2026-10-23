/**
 * Painting a place as a top-down 2D map (see docs/places.md):
 * 1. Luna plans the map: the place described as only a map seen straight from above shows it (no heights, facades or
 *    views, which pull the painter into a three-quarter view), its style, its floor and the barrier closing its edge.
 * 2. A crude frame guide: a band of the barrier's colour round the edge with floor-coloured gaps where the ways out
 *    go, flat floor colour inside.
 * 3. Krea 2 Turbo repaints the guide at denoise 0.6: the frame's composition survives (a true top-down view, an edge
 *    closed all round, gaps at the ways out) while the content is new.
 * 4. Luna checks the view on the decision API: seen straight down (no building fronts), and a finished, detailed
 *    painting (a bare guide reads as "straight down" too).
 */
import sharp from 'sharp';
import { z } from 'zod';
import type { ZoneKind } from '@gd/shared';
import { genai } from '../genai/service';
import { kreaRepaint } from './comfy';
import type { Side } from './mapgrid';

/** Ground size in metres per kind of place (about 1.4 MP of painting each, so closer views for smaller places). */
export const MAP_SIZE: Record<ZoneKind, [number, number]> = { town: [44, 36], wilderness: [52, 40], dungeon: [28, 22], interior: [14, 11] };
/** Pixels of painting per map (the size Krea paints best at). */
const PAINT_PIXELS = 1.4e6;
/** How much of the guide is repainted: low enough that its frame survives, high enough that everything is new. */
const GUIDE_DENOISE = 0.6;

/** What painting a place needs to know. */
export interface MapBrief {
  world: string;
  artStyle: string;
  name: string;
  kind: ZoneKind;
  indoor: boolean;
  description: string;
  lore?: string;
  buildings: { name: string; purpose: string }[];
  /** Ways out across the edge, by side (two on one side are spread along it). */
  sides: Side[];
  /** Ways down or in drawn inside the map (a cave mouth, stairs down, a door). */
  inner: string[];
}

const PlanSchema = z.object({
  plan: z.string().min(200).max(1100).describe('The place as a map seen straight from above shows it: its ground plan, roofs, paths, open spaces and where things are'),
  style: z.string().min(60).max(500).describe('Art style, light and palette of the painting'),
  floor: z.string().min(3).max(80).describe('The main ground people walk on, in a few plain visual words ("worn grey cobblestones")'),
  barrier: z.string().min(3).max(80).describe('What closes off the edges of this place, in a few plain visual words ("dense dark pine forest", "solid black rock", "thick stone outer walls")'),
  floorHex: z.string().max(9).describe('The floor\'s colour, as hex'),
  barrierHex: z.string().max(9).describe('The barrier\'s colour, as hex'),
  look: z.object({
    ambient: z.number().min(0.15).max(1).describe('How bright the place is: 0.2 a dark cave, 0.5 dim, 0.85 daylight'),
    lightColor: z.string().max(24).describe('Colour of the light, as hex'),
    fogColor: z.string().max(24).describe('A dark colour for unexplored ground that suits the place, as hex'),
    outdoor: z.boolean().describe('Under the open sky'),
    weather: z.enum(['none', 'rain', 'snow', 'ash', 'spores', 'embers', 'dust', 'fireflies']),
  }),
});
export type MapPlan = z.infer<typeof PlanSchema>;

const KIND_WORDS: Record<ZoneKind, string> = { town: 'a town or settlement', wilderness: 'a stretch of wild country', dungeon: 'a dungeon, cave or other dangerous inner place', interior: 'the inside of one building' };

/** Luna plans the map: what the painter is told, and the colours of the guide. */
export async function planMap(b: MapBrief): Promise<MapPlan> {
  return genai().structured('world.design', {
    system: 'You are the level designer and art director of a 2D top-down RPG. Each place is painted by an image model as one top-down map, like a tabletop battle map.',
    prompt: `WORLD: ${b.world}
Art style: ${b.artStyle}
PLACE: ${b.name}, ${KIND_WORDS[b.kind]}${b.indoor ? ', indoors' : ''}: ${b.description}
${b.lore ? `History: ${b.lore}\n` : ''}${b.buildings.length ? `Buildings people can enter: ${b.buildings.map((x) => `${x.name} (${x.purpose})`).join('; ')}.\n` : ''}${b.inner.length ? `Ways in or down drawn inside the map: ${b.inner.join('; ')}.\n` : ''}
Plan how this place is painted as a top-down map seen straight from above:
- plan: describe only what a map seen straight down shows: the ground plan, roofs, paths, open spaces and rooms, and where things are (left, right, upper, lower, middle). Never write about height, slopes, views, facades, balconies, how tall things are or anything seen from the side: those words make the painter tilt the view. Terraces and levels become areas joined by stairs. Keep the place's character, materials and colours. Give counts ("four cottages around a square"), and leave plenty of open ground to walk: wide streets, paths and floors, never a maze of narrow gaps.${b.kind === 'interior' ? ' Indoors: the rooms of this one building seen from above with the roof taken away: floors, furniture and the walls between rooms, closed all round by its outer walls.' : ''}
- style: the art style, light and palette for the painting.
- floor and barrier: the main walkable ground, and what closes off the place's edges (only where its ways out leave is the edge open).
- look: how the place feels to be in, for the game's lighting.
The painter reads every word literally and paints each word's most common picture: describe things by what they look like (material, shape, colour), never by names that commonly picture something else, and never mention anything that should not appear. The game draws its own people, creatures, chests and signs, so leave them out. No text or lettering.`,
    schema: PlanSchema,
    name: 'map_plan',
    maxTokens: 2500,
  });
}

/** Picture size for a place (multiples of 16, about PAINT_PIXELS). */
export function mapPixels(kind: ZoneKind): { W: number; H: number; X: number; Y: number } {
  const [X, Y] = MAP_SIZE[kind];
  const f = Math.sqrt(PAINT_PIXELS / (X * Y));
  return { W: Math.round((X * f) / 16) * 16, H: Math.round((Y * f) / 16) * 16, X, Y };
}

const hex = (h: string, fallback: string) => {
  const v = /^#?[0-9a-f]{6}$/i.test(h.trim()) ? h.trim().replace('#', '') : fallback;
  return [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16));
};

/** Where the ways out on one side sit along it (fractions): one in the middle, two at a third and two thirds. */
export function gapsAlong(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
}

/**
 * The crude frame guide: a band of barrier colour 2.5 m wide round the edge, floor-coloured gaps 4 m wide where the
 * ways out leave (running 6 m in), and flat floor colour inside (a little noise, so the painter has grain to work).
 */
export async function frameGuide(plan: MapPlan, sides: Side[], kind: ZoneKind): Promise<Buffer> {
  const { W, H, X } = mapPixels(kind);
  const pxm = W / X, band = Math.round(2.5 * pxm), gw = Math.round(2 * pxm), run = Math.round(6 * pxm);
  const B = hex(plan.barrierHex, '303030'), F = hex(plan.floorHex, '8a8070'), M = F.map((v, i) => (v * 2 + B[i]!) / 3);
  const gaps: { side: Side; at: number }[] = [];
  for (const s of new Set(sides)) {
    const n = sides.filter((x) => x === s).length;
    for (const f of gapsAlong(n)) gaps.push({ side: s, at: f });
  }
  const img = Buffer.alloc(W * H * 3);
  let rnd = 7;
  const nz = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 30;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inBand = x < band || y < band || x >= W - band || y >= H - band;
      const gap = gaps.some(({ side, at }) =>
        side === 'top' ? y < run && Math.abs(x - at * W) < gw
          : side === 'bottom' ? y >= H - run && Math.abs(x - at * W) < gw
            : side === 'left' ? x < run && Math.abs(y - at * H) < gw
              : x >= W - run && Math.abs(y - at * H) < gw);
      const c = gap ? F : inBand ? B : M, n = nz();
      for (let k = 0; k < 3; k++) img[(y * W + x) * 3 + k] = Math.max(0, Math.min(255, c[k]! + n));
    }
  return sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** The lead of every map prompt: what kind of picture it is (it keeps the painter looking straight down). */
function lead(kind: ZoneKind): string {
  return kind === 'interior'
    ? 'A flat 2D top-down floor plan of the inside of one building, seen from straight above with the roof taken away, painted as a tabletop battle map: floors, furniture and the tops of the walls between rooms, no wall faces visible, no perspective, no tilt.'
    : 'A flat 2D top-down game map seen from straight above, like a site plan painted as a tabletop battle map: every building is drawn only as the shape of its roof, no walls, doors or windows are visible from the side, no perspective, no tilt, no horizon.';
}

/** The painter's prompt: the lead, the plan, and the edge with its ways out. */
export function mapPrompt(b: MapBrief, plan: MapPlan): string {
  const { X, Y } = mapPixels(b.kind);
  const ways = b.sides.length
    ? `The whole edge of the map is closed off by ${plan.barrier}, solid and continuous, except for ${b.sides.length === 1 ? 'one way out' : `${b.sides.length} ways out`}: ${b.sides.map((s) => `one on the ${s} edge`).join(', ')}, where a wide path of ${plan.floor} runs off the edge of the map. Nowhere else can anyone walk off the map.`
    : `The whole edge of the map is closed off by ${plan.barrier}, solid and continuous.`;
  return `${lead(b.kind)} A top-down map of ${b.name}. The map covers ${X} by ${Y} metres; a door is about one metre wide. ${plan.plan} ${ways} Art style: ${plan.style}. Clear, readable level design with wide open walkable space, distinct areas and routes between them. No grid, no text, no labels, no people, no creatures.`;
}

/** Paint the map from its guide. */
export async function paintMap(guide: Buffer, prompt: string, kind: ZoneKind, seed: number): Promise<Buffer> {
  const { W, H } = mapPixels(kind);
  return kreaRepaint(guide, prompt, W, H, seed, GUIDE_DENOISE);
}

export interface ViewCheck {
  /** Seen straight down (or nearly). */
  top: boolean;
  /** Luna's probability that it is straight down. */
  pTop: number;
  angle: string;
  /** A finished, detailed painting (not a bare guide). */
  detailed: boolean;
  pass: boolean;
}

/** Luna (decision API) checks the view: straight down with no building fronts, and a finished painting. */
export async function checkView(png: Buffer): Promise<ViewCheck> {
  const img = await sharp(png).resize({ width: 1024, height: 1024, fit: 'inside' }).png().toBuffer();
  const a = await genai().decide('image.check', {
    state: 'A game needs finished top-down 2D maps: painted in detail and seen from directly overhead like a tabletop battle map or a floor plan, so every building shows only its roof or wall tops and no side of any building, wall or object is visible.',
    questions: {
      angle: { type: 'choice', instructions: 'How is this map viewed? Look at the buildings, walls and objects: can you see their front or side faces (doors and windows seen from the side)?', criteria: { top: 'straight down, orthographic: only roofs and wall tops, no fronts', slight: 'nearly straight down but a few walls lean slightly', three_quarter: 'three-quarter or oblique view showing building fronts', isometric: 'isometric', perspective: 'perspective with a horizon or vanishing point' } },
      detail: { type: 'noul', instructions: 'Is this a finished, detailed painting of a place, with many distinct drawn things (structures, objects, textures of floors and walls)? Answer no if it is blank, flat or nearly uniform: plain colour fields, a crude coloured frame or blocks, noise, a gradient, or a sketch with almost nothing drawn.' },
    },
    images: [img],
  });
  const c = a.angle?.type === 'choice' ? a.angle : null;
  const angle = c?.choice ?? '?';
  const pTop = +(c?.probabilities.top ?? 0).toFixed(2);
  const detailed = (a.detail?.type === 'noul' ? a.detail.noul : 0.5) > 0.5;
  const top = angle === 'top' || angle === 'slight';
  return { top, pTop, angle, detailed, pass: top && detailed };
}
