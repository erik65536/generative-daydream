/**
 * A picture of a whole place as the game shows it (isometric, with its painted ground and props), made on the
 * server, and a review of it by a vision model: does the place read as what it is meant to be? The review's
 * notes feed the next floor plan when it does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { GROUND, OBJ, PROP_COVER, PROP_COVER_TALL, SURFACE_BASE, base64ToBytes, propIndex, type WorldDefinition, type ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { worldAssetDir } from '../storage';

const HW = 14, HH = 7;
/** Prop heights on the overview, by class and footprint (relative to the game's 32px half tile). */
const PROP_H = { low: [40, 62], mid: [70, 100], tall: [128, 176] } as const;
const PROP_W = { low: [58, 124], mid: [78, 132], tall: [72, 140] } as const;

const hex = (c: string | undefined, fb: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fb);

/** The average colour of a painted image (for ground at overview scale). */
async function meanColor(file: string | undefined, fallback: string): Promise<string> {
  if (!file || !fs.existsSync(file)) return fallback;
  const { channels } = await sharp(file).stats();
  const [r, g, b] = channels.map((c) => Math.round(c.mean));
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
}

const shade = (c: string, k: number) => `#${[1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(c.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('')}`;

/** Render a place's overview as a PNG. */
export async function renderOverview(w: WorldDefinition, z: ZoneDef): Promise<Buffer> {
  const ts = w.tilesets[z.tilesetId]!;
  const dir = worldAssetDir(w.id);
  const fileOf = (key?: string) => {
    const a = key ? w.assets[key] : undefined;
    return a?.status === 'ok' && a.file ? path.join(dir, a.file) : undefined;
  };
  const W = z.width, H = z.height;
  const g = base64ToBytes(z.ground), o = base64ToBytes(z.objects);
  const ox = H * HW + 40, oy = 140;
  const width = (W + H) * HW + 80, height = (W + H) * HH + 200;
  const iso = (x: number, y: number) => ({ x: ox + (x - y) * HW, y: oy + (x + y) * HH });
  // Ground colours from the painted surfaces.
  const colors = new Map<number, string>();
  const roleColor = async (code: number, role: 'floor' | 'floorAlt' | 'path' | 'water' | 'wall') => colors.set(code, await meanColor(fileOf(ts.roles[role].asset), hex(ts.roles[role].colors[0], '#808080')));
  await Promise.all([roleColor(GROUND.floor, 'floor'), roleColor(GROUND.floorAlt, 'floorAlt'), roleColor(GROUND.path, 'path'), roleColor(GROUND.water, 'water'), roleColor(GROUND.wall, 'wall')]);
  await Promise.all((ts.surfaces ?? []).map(async (s, k) => colors.set(SURFACE_BASE + k, await meanColor(fileOf(s.asset), hex(s.colors[0], '#808080')))));
  // Town buildings (wall blocks with a door): storefronts indoors, roofed houses outdoors, as the game draws them.
  const bldg = new Int32Array(W * H).fill(-1);
  if (z.kind === 'town') {
    const doorAt = new Set(z.features.filter((f) => f.kind === 'door').map((f) => f.y * W + f.x));
    let n = 0;
    for (const d of doorAt) {
      if (bldg[d]! >= 0) continue;
      const stack = [d];
      bldg[d] = n;
      while (stack.length) {
        const k = stack.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = (k % W) + dx, y = ((k / W) | 0) + dy, ni = y * W + x;
          if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 || bldg[ni]! >= 0 || (g[ni] !== GROUND.wall && !doorAt.has(ni))) continue;
          bldg[ni] = n;
          stack.push(ni);
        }
      }
      n++;
    }
  }
  const indoorTown = !!z.indoor || z.layout?.structures === 'walled';
  const roofColor = await meanColor(fileOf(ts.extras?.roof?.asset), '#7a3a2a');
  const fascia = (k: number) => `hsl(${(k * 67) % 360},55%,48%)`;
  const poly = (pts: { x: number; y: number }[], fill: string) => `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${fill}"/>`;
  const shapes: string[] = [];
  const walls: { depth: number; svg: string }[] = [];
  const WALL = 22;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const code = g[y * W + x]!;
      if (code === GROUND.void) continue;
      const c = colors.get(code) ?? '#777777';
      const n = iso(x - 0.5, y - 0.5), e = iso(x + 0.5, y - 0.5), s = iso(x + 0.5, y + 0.5), wv = iso(x - 0.5, y + 0.5);
      // Tiles are drawn a hair larger so no gaps show between them.
      const grow = (p: { x: number; y: number }, cx: number, cy: number) => ({ x: cx + (p.x - cx) * 1.04, y: cy + (p.y - cy) * 1.04 });
      const ctr = iso(x, y);
      const bi = bldg[y * W + x]!;
      if (bi >= 0 || (code === GROUND.wall && z.features.some((f) => f.kind === 'door' && f.x === x && f.y === y))) {
        const up = (p: { x: number; y: number }, k = 1) => ({ x: p.x, y: p.y - WALL * k });
        const top = indoorTown ? shade(c, 0.6) : roofColor;
        const sides = indoorTown
          ? poly([wv, s, up(s, 0.75), up(wv, 0.75)], '#9fbccc') + poly([s, e, up(e, 0.75), up(s, 0.75)], '#7f9cac') + poly([up(wv, 0.75), up(s, 0.75), up(s), up(wv)], fascia(bi)) + poly([up(s, 0.75), up(e, 0.75), up(e), up(s)], fascia(bi))
          : poly([wv, s, up(s), up(wv)], shade(c, 0.8)) + poly([s, e, up(e), up(s)], shade(c, 0.62));
        walls.push({ depth: x + y, svg: sides + poly([up(n), up(e), up(s), up(wv)], top) });
      } else if (code === GROUND.wall) {
        const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - WALL });
        walls.push({ depth: x + y, svg: poly([wv, s, up(s), up(wv)], shade(c, 0.7)) + poly([s, e, up(e), up(s)], shade(c, 0.55)) + poly([up(n), up(e), up(s), up(wv)], shade(c, 1.05)) });
      } else shapes.push(poly([n, e, s, wv].map((p) => grow(p, ctr.x, ctr.y)), shade(c, 0.94 + ((x * 7 + y * 13) % 5) * 0.03)));
    }
  const ground = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#101014"/>${shapes.join('')}</svg>`);
  // Things standing on the map, back to front: walls and props (scaled to overview size).
  const k = HW / 32;
  type Item = { depth: number; input: Buffer; left: number; top: number };
  const items: Item[] = [];
  const cache = new Map<string, { buf: Buffer; w: number; h: number } | null>();
  const sprite = async (file: string | undefined, maxH: number, maxW: number) => {
    const key = `${file}:${maxH}:${maxW}`;
    if (cache.has(key)) return cache.get(key)!;
    let v: { buf: Buffer; w: number; h: number } | null = null;
    if (file && fs.existsSync(file)) {
      const img = sharp(file).trim();
      const meta = await img.clone().png().toBuffer({ resolveWithObject: true });
      const sc = Math.min(maxH / meta.info.height, maxW / meta.info.width);
      const wd = Math.max(1, Math.round(meta.info.width * sc)), ht = Math.max(1, Math.round(meta.info.height * sc));
      v = { buf: await sharp(meta.data).resize(wd, ht).png().toBuffer(), w: wd, h: ht };
    }
    cache.set(key, v);
    return v;
  };
  const legacyRole: Record<number, string> = { [OBJ.tree]: 'tree', [OBJ.rock]: 'rock', [OBJ.plant]: 'plant', [OBJ.light]: 'light', [OBJ.furniture]: 'furniture', [OBJ.rubble]: 'rubble', [OBJ.pillar]: 'pillar' };
  const legacySize: Record<string, [number, number]> = { tree: [150, 130], pillar: [125, 70], light: [92, 50], furniture: [74, 96], rock: [52, 64], plant: [38, 48], rubble: [30, 52] };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ob = o[y * W + x]!;
      if (!ob || ob === PROP_COVER || ob === PROP_COVER_TALL) continue;
      const pi = propIndex(ob);
      let file: string | undefined, mh: number, mw: number, n = 1;
      if (pi >= 0) {
        const p = ts.props?.[pi];
        if (!p) continue;
        n = p.size;
        file = fileOf(p.asset);
        mh = PROP_H[p.height][n - 1]! * k;
        mw = PROP_W[p.height][n - 1]! * k;
      } else {
        const role = legacyRole[ob];
        if (!role) continue;
        file = fileOf(ts.roles[role as 'tree'].asset);
        [mh, mw] = legacySize[role]!.map((v) => v * k) as [number, number];
      }
      const spr = await sprite(file, Math.round(mh), Math.round(mw));
      const at = iso(x + (n - 1) / 2, y + (n - 1) / 2);
      if (spr) items.push({ depth: x + y + (n - 1) * 2 + 0.1, input: spr.buf, left: Math.round(at.x - spr.w / 2), top: Math.round(at.y - spr.h + 2) });
    }
  // Doors and ways out, as small markers.
  for (const f of z.features) {
    if (f.kind !== 'exit' && f.kind !== 'door') continue;
    const at = iso(f.x, f.y);
    items.push({ depth: f.x + f.y + 0.2, input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="5" fill="${f.kind === 'exit' ? '#40c0ff' : '#ffc040'}" stroke="#000"/></svg>`), left: Math.round(at.x - 6), top: Math.round(at.y - 6) });
  }
  const wallItems = walls.length
    ? [{ depth: -1, input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${walls.sort((a, b) => a.depth - b.depth).map((x) => x.svg).join('')}</svg>`), left: 0, top: 0 }]
    : [];
  // Walls go in one layer under the props (exact interleaving matters little at this scale).
  const all = [...wallItems, ...items.sort((a, b) => a.depth - b.depth)].map(({ input, left, top }) => ({ input, left: Math.max(0, left), top: Math.max(0, top) }));
  return sharp(ground).composite(all).png().toBuffer();
}

const ReviewSchema = z.object({
  score: z.number().min(0).max(10),
  reads_as: z.string().max(300).describe('What the place looks like at a glance'),
  problems: z.array(z.string().max(240)).max(6),
});
export type PlaceReview = z.infer<typeof ReviewSchema>;

/** Ask the vision model whether the place reads as what it is meant to be. */
export async function reviewPlace(w: WorldDefinition, z: ZoneDef, png: Buffer): Promise<PlaceReview> {
  const view = await sharp(png).resize({ width: 1400, withoutEnlargement: true }).png().toBuffer();
  const ts = w.tilesets[z.tilesetId];
  const areas = z.blueprint?.areas.map((a) => `${a.count > 1 ? `${a.count}x ` : ''}${a.name} (${a.purpose})`).join('; ');
  return genai().structured('world.design', {
    system: 'You are a demanding art director and level designer reviewing a map of a 2D isometric RPG. Judge only what you see in the picture.',
    prompt: `This is an overview of one whole place of the game, seen from above at an angle. Blue dots are ways out, yellow dots are doors into buildings.
It is meant to be: ${z.name}: ${z.description}
${areas ? `Its plan has these areas: ${areas}.\n` : ''}${ts?.props?.length ? `Its props: ${ts.props.map((p) => p.name).join(', ')}.\n` : ''}
Does it read at a glance as this place, laid out the way such a place really is, with areas that make sense and look furnished and alive? Score 0-10 (10 = instantly convincing and good looking, 6 = acceptable, below 5 = confusing or wrong). List concrete problems a level designer could fix (an area that makes no sense, furniture that does not belong or is set out oddly, areas that look empty or cluttered, things that look broken).`,
    schema: ReviewSchema,
    name: 'place_review',
    images: [view],
    maxTokens: 1500,
  });
}
