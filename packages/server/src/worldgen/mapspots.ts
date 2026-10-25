/**
 * The spots the game places things on in a read map (see docs/places.md): building entrances and named landmarks.
 * Studied in October 2026 against hand labels on five towns, a mushroom village and a canyon of tents and caves
 * among them (side-session notes, entrances/REPORT.md).
 *
 * Entrances:
 * 1. Luna (low reasoning) looks at the map in full-size crops of 24 m with a lettered grid of 2 m cells, beside the
 *    whole map, and lists every building whose entrance is in the crop (a house, shop, stall, tent, hut, cave
 *    dwelling...), with the cell of the ground in front of it and a few words on the building. A building in a joined
 *    row is listed once per door. Overlapping crops each keep only the spots nearest their own middle.
 * 2. Qwen's door plan marks each door with a yellow square: right at the door, but almost always on a building's lower
 *    side, so it misses buildings that face up. Each Luna spot moves to the nearest unclaimed mark within 3 m, which
 *    puts more spots at the painted door (Brinewake: 66% to 77% of buildings with a spot at their door). Marks she
 *    missed are kept where Qwen painted a building beside them (elsewhere they were rocks).
 * 3. Spots closer than 4.5 m are shown to Luna as a pair: one building or two, and if one, which stands nearer its
 *    door (keeping the first instead lost good spots).
 * All of it found 61-97% of the labelled buildings per town (91% of a mushroom village's); the earlier reader (a red
 * building plan, one entrance in the middle of each red patch's lower side, a joined block one building) found
 * 35-80%. Sol finding entrances was better only on the dense city, at about seventeen times the price.
 *
 * Landmarks: Sol looks once at the whole map with a grid of 4 m cells and names up to 12 landmarks (and ways in or
 * down), each at its cell; Luna placed them less well (on the city 3 of 8 against 6 of 7).
 */
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service';
import { qwenEdit } from './comfy';
import { CELL, components, type Grid } from './mapgrid';
import type { PlaceBrief } from './mapread';

/** A picture point and what is there. */
export interface Spot {
  x: number;
  y: number;
  /** What it is: the building ("a large inn with a porch") or the landmark's name. */
  label: string;
  /** Landmarks: what kind of thing (monument, feature, open space, water, natural, way in). */
  kind?: string;
}

/** Qwen's door plan: buildings red, every door marked by a yellow square on the ground just outside it. */
export const DOOR_PLAN = {
  mp: 1.4,
  prompt: 'Convert this top-down game map into a flat colour plan with exactly the same layout, shapes and positions. Paint pure white all ground people can walk on. Paint pure red every building, house, shop, tent, hut and roof. Paint pure black everything else that is solid. Paint pure blue all water. Then mark every door and entrance into a building with one bright yellow square, on the ground just outside the door. Only flat white, red, black, blue and yellow.',
};

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

/** The door marks of Qwen's door plan (picture px): the middles of its yellow squares. */
export async function readDoorPlan(png: Buffer, pxm: number, seed = 1): Promise<DoorMark[]> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const k = Math.sqrt((DOOR_PLAN.mp * 1e6) / (W * H));
  const ref = await sharp(png).resize(Math.round((W * k) / 16) * 16, Math.round((H * k) / 16) * 16).png().toBuffer();
  const plan = await qwenEdit(ref, DOOR_PLAN.prompt, seed);
  // Yellow pixels at a quarter of the map's size, as connected blobs.
  const q = 4, w = Math.floor(W / q), h = Math.floor(H / q);
  const { data } = await sharp(plan).removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const g: Grid = { cols: w, rows: h };
  const yellow = (i: number) => data[i * 3]! > 200 && data[i * 3 + 1]! > 180 && data[i * 3 + 2]! < 90;
  const red = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 3]! > 150 && data[(y * w + x) * 3 + 1]! < 100 && data[(y * w + x) * 3 + 2]! < 100;
  // A mark beside a building has red within about a metre.
  const R = Math.round((1.2 * pxm) / q);
  return components(g, yellow).filter((b) => b.length >= 4 && b.length < 2500).map((b) => {
    let sx = 0, sy = 0;
    for (const i of b) (sx += i % w), (sy += Math.floor(i / w));
    const cx = Math.round(sx / b.length), cy = Math.round(sy / b.length);
    let building = false;
    for (let dy = -R; dy <= R && !building; dy++) for (let dx = -R; dx <= R && !building; dx++) building = red(cx + dx, cy + dy);
    return { x: (sx / b.length + 0.5) * q, y: (sy / b.length + 0.5) * q, building };
  });
}

/** A door mark of Qwen's door plan (picture px), and whether it was painted beside a building. */
export interface DoorMark {
  x: number;
  y: number;
  building: boolean;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Column letters: A..Z, then AA..AZ. */
const letter = (i: number) => (i < 26 ? LETTERS[i]! : `A${LETTERS[i - 26]}`);
/** A grid cell name ("C7", "AB12") back to [column, row], or null when off the grid. */
function cellOf(name: string, cols: number, rows: number): [number, number] | null {
  const m = /^([A-Z]{1,2})\s*(\d{1,2})$/.exec(name.trim().toUpperCase());
  if (!m) return null;
  const col = m[1]!.length === 1 ? LETTERS.indexOf(m[1]!) : 26 + LETTERS.indexOf(m[1]![1]!), row = Number(m[2]) - 1;
  return col >= 0 && col < cols && row >= 0 && row < rows ? [col, row] : null;
}

/** A region of the map (or all of it) at `C` px across, with a grid of n×m cells named A1.. in a margin. */
async function gridView(png: Buffer, left: number, top: number, w: number, h: number, cols: number, rows: number, C: number): Promise<Buffer> {
  const s = C / w, ch = Math.round(h * s), cw = C / cols, rh = ch / rows, pad = 24;
  let svg = '';
  for (let i = 0; i <= cols; i++) svg += `<line x1="${pad + i * cw}" y1="${pad}" x2="${pad + i * cw}" y2="${pad + ch}" stroke="#fff" stroke-opacity="0.5" stroke-width="1.2"/>`;
  for (let i = 0; i <= rows; i++) svg += `<line x1="${pad}" y1="${pad + i * rh}" x2="${pad + C}" y2="${pad + i * rh}" stroke="#fff" stroke-opacity="0.5" stroke-width="1.2"/>`;
  for (let i = 0; i < cols; i++) svg += `<text x="${pad + (i + 0.5) * cw}" y="17" font-size="14" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">${letter(i)}</text>`;
  for (let i = 0; i < rows; i++) svg += `<text x="12" y="${pad + (i + 0.5) * rh + 5}" font-size="14" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">${i + 1}</text>`;
  const crop = await sharp(png).extract({ left, top, width: w, height: h }).resize(C, ch).png().toBuffer();
  return sharp({ create: { width: C + pad, height: ch + pad, channels: 3, background: '#000' } })
    .composite([{ input: crop, left: pad, top: pad }, { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${C + pad}" height="${ch + pad}">${svg}</svg>`), left: 0, top: 0 }])
    .png().toBuffer();
}

/** The whole map at 1024 px with a magenta box round a region. */
async function overview(png: Buffer, W: number, H: number, left: number, top: number, w: number, h: number): Promise<Buffer> {
  const o = 1024 / W;
  const box = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="${Math.round(H * o)}"><rect x="${left * o}" y="${top * o}" width="${w * o}" height="${h * o}" fill="none" stroke="#ff00ff" stroke-width="3"/></svg>`;
  return sharp(png).resize(1024).composite([{ input: Buffer.from(box) }]).jpeg({ quality: 85 }).toBuffer();
}

const context = (p: PlaceBrief) => `We are placing people and things in a painted top-down map of a 2D top-down RPG. The place: ${p.name}. As designed: ${p.description.slice(0, 1200)}`;

const Found = z.object({
  entrances: z.array(z.object({
    building: z.string().describe('which building, in a few words that say its size and look (e.g. "large red-roofed house with a chimney")'),
    evidence: z.string().describe('what shows the entrance: a painted door, porch, steps, awning, lantern by a door, tent opening, cave mouth; or "front facing the street" if none is painted'),
    cell: z.string().describe('grid cell of the open ground right in front of the entrance, e.g. "C7"'),
  })),
});

/** Crop size and step (m) and grid cell (m) for finding entrances. */
const CROP_M = 24, STEP_M = 18, CELL_M = 2;

/** Luna's entrances on full-size gridded crops (step 1 of the file comment). Picture px. */
export async function findEntrances(png: Buffer, pxm: number, p: PlaceBrief): Promise<Spot[]> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const S = Math.min(Math.round(CROP_M * pxm), W, H), n = Math.round(S / pxm / CELL_M), step = Math.round(STEP_M * pxm);
  const starts = (len: number) => {
    const out: number[] = [];
    for (let v = 0; ; v += step) {
      out.push(Math.min(v, len - S));
      if (v + S >= len) break;
    }
    return out;
  };
  const crops = starts(H).flatMap((top) => starts(W).map((left) => [left, top] as const));
  const far = (l: number, t: number, x: number, y: number) => Math.max(Math.abs(l + S / 2 - x), Math.abs(t + S / 2 - y));
  const found = await pool(crops, 8, async ([left, top]) => {
    const prompt = `${context(p)}
Image 1 is the whole map; the magenta box marks where image 2 is. Image 2 is a close-up of about ${CROP_M} metres with a grid of ${CELL_M}-metre cells: columns A-${letter(n - 1)} left to right, rows 1-${n} top to bottom.
List every building in image 2 whose entrance is inside image 2: houses, shops, inns, halls, market stalls, tents, huts, sheds, and also unusual ones such as mushroom houses, hollow trees, caves, yurts or carved cliff dwellings. Where several buildings are joined in a row or block, list each one that has its own door or front as a separate entrance. For each, give the grid cell of the open walkable ground right in front of its entrance (where a shopkeeper would stand to greet visitors), not the roof. Prefer a painted door, porch, steps, awning or opening; if none is visible, use the middle of the side facing the street or path. Leave out buildings whose entrance is outside image 2, and do not list fences, walls, trees, rocks or decorations.`;
    const images = [await overview(png, W, H, left, top, S, S), await gridView(png, left, top, S, S, n, n, 1024)];
    const r = await genai().structured('world.content', { prompt, schema: Found, name: 'entrances', images, maxTokens: 3000 }).catch(() => ({ entrances: [] }));
    return r.entrances.flatMap((e): Spot[] => {
      const c = cellOf(e.cell, n, n);
      if (!c) return [];
      const x = left + ((c[0] + 0.5) * S) / n, y = top + ((c[1] + 0.5) * S) / n;
      // A spot seen by several overlapping crops is kept by the one it is nearest the middle of.
      return crops.every(([l, t]) => far(left, top, x, y) <= far(l, t, x, y)) ? [{ x, y, label: e.building }] : [];
    });
  });
  return found.flat();
}

/** Each spot moves to the nearest door mark within `maxM` (closest pairs first; a mark moves one spot). */
export function fuseDoors(spots: Spot[], marks: { x: number; y: number }[], pxm: number, maxM = 3): Spot[] {
  const pairs = spots.flatMap((s, i) => marks.map((m, j) => ({ i, j, d: Math.hypot(m.x - s.x, m.y - s.y) }))).filter((e) => e.d < maxM * pxm).sort((a, b) => a.d - b.d);
  const moved = new Map<number, number>(), used = new Set<number>();
  for (const e of pairs) if (!moved.has(e.i) && !used.has(e.j)) (moved.set(e.i, e.j), used.add(e.j));
  return spots.map((s, i) => (moved.has(i) ? { ...s, x: marks[moved.get(i)!]!.x, y: marks[moved.get(i)!]!.y } : s));
}

/** Spots on the walkable ground: each moved to the nearest walkable cell within `maxM` (dropped when none). */
export function ontoWalk(spots: Spot[], walk: Uint8Array, g: Grid, W: number, H: number, maxM = 3): Spot[] {
  const kx = W / g.cols, ky = H / g.rows, R = Math.ceil(maxM / CELL);
  return spots.flatMap((s) => {
    const c0 = Math.floor(s.x / kx), r0 = Math.floor(s.y / ky);
    let best: [number, number] | null = null, bd = Infinity;
    for (let r = Math.max(0, r0 - R); r <= Math.min(g.rows - 1, r0 + R); r++)
      for (let c = Math.max(0, c0 - R); c <= Math.min(g.cols - 1, c0 + R); c++) {
        const d = Math.hypot(c - c0, r - r0);
        if (walk[r * g.cols + c] && d < bd && d <= R) (bd = d), (best = [c, r]);
      }
    return best ? [{ ...s, x: (best[0] + 0.5) * kx, y: (best[1] + 0.5) * ky }] : [];
  });
}

/**
 * Entrances closer than `nearM` that Luna judges to belong to one building (step 3): she also says which of the two
 * stands nearer its door, and the other goes. Spots closer than a metre are one (the first is kept).
 */
export async function dropSameBuilding(png: Buffer, pxm: number, p: PlaceBrief, spots: Spot[], nearM = 4.5): Promise<Spot[]> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const pairs: [number, number][] = [];
  for (let i = 0; i < spots.length; i++)
    for (let j = i + 1; j < spots.length; j++) if (Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y) < nearM * pxm) pairs.push([i, j]);
  /** Per pair: the spot to drop, or -1 when they are two buildings. */
  const verdicts = await pool(pairs, 12, async ([i, j]) => {
    const a = spots[i]!, b = spots[j]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < pxm) return j;
    const S = Math.min(Math.round(14 * pxm), W, H), C = 640, s = C / S;
    const left = Math.round(Math.max(0, Math.min(W - S, (a.x + b.x) / 2 - S / 2))), top = Math.round(Math.max(0, Math.min(H - S, (a.y + b.y) / 2 - S / 2)));
    const mark = (q: Spot, n: number) => `<circle cx="${(q.x - left) * s}" cy="${(q.y - top) * s}" r="12" fill="#ffd400" stroke="#000" stroke-width="2"/><text x="${(q.x - left) * s}" y="${(q.y - top) * s + 5}" font-size="15" font-weight="bold" font-family="Arial" text-anchor="middle">${n}</text>`;
    const crop = await sharp(png).extract({ left, top, width: S, height: S }).resize(C, C).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}">${mark(a, 1)}${mark(b, 2)}</svg>`) }]).png().toBuffer();
    const r = await genai().decide('image.check', {
      state: `We are placing shopkeepers at the entrances of buildings in a painted top-down map of a 2D top-down RPG. The place: ${p.name}. The image is a close-up of about 14 metres. Markers 1 and 2 stand on the ground in front of what may be building entrances.`,
      questions: { same: { type: 'choice', instructions: 'Do markers 1 and 2 stand in front of the same building (one shop or home, so only one shopkeeper belongs there), or in front of two different buildings or separate units of a joined row, each with its own door or front? If the same, which marker stands nearer its door or front?', criteria: { different: 'two different buildings or units', same1: 'the same building; marker 1 is nearer its door', same2: 'the same building; marker 2 is nearer its door' } } },
      images: [crop],
    }).catch(() => ({}) as Record<string, never>);
    const pr = (r as Record<string, { type: string; probabilities?: Record<string, number> }>).same?.probabilities ?? {};
    if ((pr.same1 ?? 0) + (pr.same2 ?? 0) <= 0.5) return -1;
    return (pr.same1 ?? 0) >= (pr.same2 ?? 0) ? j : i;
  });
  // Closest pairs first; a spot already dropped decides nothing more.
  const drop = new Set<number>();
  const order = pairs.map(([i, j], k) => ({ i, j, k, d: Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y) })).sort((x, y) => x.d - y.d);
  for (const { i, j, k } of order) if (verdicts[k]! >= 0 && !drop.has(i) && !drop.has(j)) drop.add(verdicts[k]!);
  return spots.filter((_, i) => !drop.has(i));
}

const Named = z.object({
  landmarks: z.array(z.object({
    name: z.string().describe('a short evocative name as a player would call it, e.g. "the frozen pond", "the great Christmas tree"'),
    kind: z.enum(['monument', 'feature', 'open space', 'water', 'natural', 'way in']).describe('monument: statue, fountain, well, great tree, altar, idol; feature: bridge, stairs, gate, cluster of market stalls; open space: plaza, square, clearing, chamber; water: pond, pool, canal; natural: rock, crag, grove; way in: a cave mouth, stairs or a hole going down, a tunnel or gate into somewhere else'),
    cell: z.string().describe('grid cell of its middle, e.g. "K7"'),
  })).max(14),
});

/** Grid cell (m) of the landmark view. */
const LANDMARK_CELL_M = 4;

/** Sol's named landmarks (and ways in or down) on the whole map, each at the middle of its cell. Picture px. */
export async function nameLandmarks(png: Buffer, pxm: number, p: PlaceBrief): Promise<Spot[]> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const cols = Math.round(W / pxm / LANDMARK_CELL_M), rows = Math.round(H / pxm / LANDMARK_CELL_M);
  const prompt = `${context(p)}
The image is the whole map with a grid of ${LANDMARK_CELL_M}-metre cells: columns A-${letter(cols - 1)} left to right, rows 1-${rows} top to bottom.
List the landmarks of this place, up to 12, most memorable first: the things a player would remember and that a quest could send them to, such as a monument, fountain, well, great tree, altar or idol, a plaza, square, clearing or striking chamber, a bridge, a grand stair, a gate, a pond or pool, a striking rock or grove, a market. Also list every way in or down drawn inside the map (a cave mouth, stairs or a hole going down, a tunnel or gate into somewhere else). Each must be clearly visible in the painting. Do not list ordinary houses, single small props, or the edge of the map.`;
  const r = await genai().structured('world.design', { model: genai().strongModel('world.design'), prompt, schema: Named, name: 'landmarks', images: [await gridView(png, 0, 0, W, H, cols, rows, 1536)], maxTokens: 16000 });
  return r.landmarks.flatMap((l): Spot[] => {
    const c = cellOf(l.cell, cols, rows);
    return c ? [{ x: ((c[0] + 0.5) * W) / cols, y: ((c[1] + 0.5) * H) / rows, label: l.name, kind: l.kind }] : [];
  });
}
