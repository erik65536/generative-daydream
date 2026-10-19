/**
 * A place drawn on the server at the game's own scale (64x32 pixel tiles): its painted ground projected to
 * isometric, its walls and its props where the game puts them. It is the block-out a painted backdrop is made
 * from, and (scaled down) the overview a reviewer looks at.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { GROUND, OBJ, PROP_COVER, PROP_COVER_TALL, SURFACE_BASE, base64ToBytes, propIndex, type PropDef, type WorldDefinition, type ZoneDef } from '@gd/shared';
import { worldAssetDir } from '../storage';

export const HW = 32, HH = 16;
/** Top-down pixels per tile before the isometric projection (a texture image spans two tiles, as in the game). */
const T = 32;
/** Room above the map for tall things standing on its back edge. */
export const TOP = 220;

/** Prop sizes in the game (height, width), by height class and footprint; kept in step with the client's PROP_ART. */
export const PROP_ART: Record<PropDef['height'], [[number, number], [number, number]]> = {
  low: [[40, 58], [62, 124]],
  mid: [[70, 78], [100, 132]],
  tall: [[128, 72], [176, 140]],
};
const LEGACY_ART: Record<string, [number, number]> = { tree: [150, 130], pillar: [125, 70], light: [92, 50], furniture: [74, 96], rock: [52, 64], plant: [38, 48], rubble: [30, 52] };
const LEGACY_ROLE: Record<number, string> = { [OBJ.tree]: 'tree', [OBJ.rock]: 'rock', [OBJ.plant]: 'plant', [OBJ.light]: 'light', [OBJ.furniture]: 'furniture', [OBJ.rubble]: 'rubble', [OBJ.pillar]: 'pillar' };

export interface SceneOpts {
  /** Which props to draw: every one, none, or only those a person could never stand behind (low ones). */
  props?: 'all' | 'none' | 'low';
  walls?: boolean;
  /** Draw buildings and walls as flat-coloured blocks (block-out) rather than leaving them out. */
  blocks?: boolean;
  /** Fill each surface with its painting's average colour instead of repeating its texture (for the painter, who
   *  should invent the material rather than copy a repeated tile). */
  flatGround?: boolean;
  /** Also render the id map (which object each pixel shows). */
  ids?: boolean;
}


export interface Scene {
  png: Buffer;
  width: number;
  height: number;
  /** Pixel position of tile (0,0)'s centre. */
  ox: number;
  oy: number;
  /** Everything standing that can hide someone behind it (walls per tile, props per anchor). */
  objects: SceneObject[];
  /** With `ids`: raw RGB, each pixel the id + 1 of the object seen there (0 = ground). */
  ids?: Buffer;
}

export interface SceneObject {
  id: number;
  kind: 'wall' | 'prop';
  /** Tile (a prop's anchor). */
  x: number;
  y: number;
  /** Draw order, as the game sorts it. */
  depth: number;
  size: number;
}

/** Where a tile centre lands in a scene. */
export const tileToScene = (s: Pick<Scene, 'ox' | 'oy'>, x: number, y: number) => ({ x: s.ox + (x - y) * HW, y: s.oy + (x + y) * HH });

const hex = (c: string | undefined, fb: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fb);
const shade = (c: string, k: number) => `#${[1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(c.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('')}`;

export async function renderScene(w: WorldDefinition, z: ZoneDef, opts: SceneOpts = {}): Promise<Scene> {
  const ts = w.tilesets[z.tilesetId]!;
  const dir = worldAssetDir(w.id);
  const fileOf = (key?: string) => {
    const a = key ? w.assets[key] : undefined;
    return a?.status === 'ok' && a.file && fs.existsSync(path.join(dir, a.file)) ? path.join(dir, a.file) : undefined;
  };
  const W = z.width, H = z.height;
  const g = base64ToBytes(z.ground), o = base64ToBytes(z.objects);

  // 1. Ground, top-down: each surface's texture repeated over its tiles (walls stand on floor; void is black).
  const tex = new Map<number, { file?: string; color: string }>();
  const role = (code: number, r: 'floor' | 'floorAlt' | 'path' | 'water' | 'wall') => tex.set(code, { file: fileOf(ts.roles[r].asset), color: hex(ts.roles[r].colors[0], '#808080') });
  role(GROUND.floor, 'floor');
  role(GROUND.floorAlt, 'floorAlt');
  role(GROUND.path, 'path');
  role(GROUND.water, 'water');
  (ts.surfaces ?? []).forEach((s, k) => tex.set(SURFACE_BASE + k, { file: fileOf(s.asset), color: hex(s.colors[0], '#808080') }));
  const groundOf = (i: number) => (g[i] === GROUND.wall ? GROUND.floor : g[i]!);
  const organic = z.blueprint?.style === 'natural' || g.includes(GROUND.water);
  // Organic edges: every pixel goes to the surface whose (rounded, noise-nudged) presence is strongest there,
  // so neighbouring surfaces meet along a curve with no gap between them.
  let partition: ((code: number) => Buffer) | null = null;
  const organicPartition = async () => {
    if (partition) return partition;
    const fields = new Map<number, Float32Array>();
    for (const code of codes) {
      const m = Buffer.alloc(W * H);
      for (let i = 0; i < W * H; i++) if (g[i] !== GROUND.void && groundOf(i) === code) m[i] = 255;
      fields.set(code, await organicField(m, W, H, code === GROUND.water ? 0.5 : 0.35, code));
    }
    const N = W * T * H * T, owner = new Int32Array(N).fill(-1);
    for (let k = 0; k < N; k++) {
      let best = 0.12, who = -1;
      for (const [code, f] of fields) if (f[k]! > best) (best = f[k]!), (who = code);
      owner[k] = who;
    }
    partition = (code: number) => {
      const out = Buffer.alloc(N);
      for (let k = 0; k < N; k++) if (owner[k] === code) out[k] = 255;
      return out;
    };
    return partition;
  };
  const codes = new Set<number>();
  for (let i = 0; i < W * H; i++) if (g[i] !== GROUND.void) codes.add(groundOf(i));
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (const code of codes) {
    let t: { file?: string; color: string } = tex.get(code) ?? { color: '#777777' };
    if (opts.flatGround && t.file) {
      const { channels } = await sharp(t.file).stats();
      t = { color: `#${channels.slice(0, 3).map((c) => Math.round(c.mean).toString(16).padStart(2, '0')).join('')}` };
    }
    // Water must read as water to the painter (a dark liquid's average colour reads as a void or fog).
    if (opts.flatGround && code === GROUND.water) t = { color: '#2e6684' };
    const tile = t.file ? await sharp(t.file).resize(T * 2, T * 2).png().toBuffer() : await sharp({ create: { width: T * 2, height: T * 2, channels: 3, background: t.color } }).png().toBuffer();
    const full = await sharp({ create: { width: W * T, height: H * T, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: tile, tile: true, gravity: 'northwest' }]).png().toBuffer();
    // Its tiles as a mask (soft by a pixel, so neighbouring surfaces meet without a jagged seam).
    const mask = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) if (g[i] !== GROUND.void && groundOf(i) === code) mask[i] = 255;
    let alpha: Buffer = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).resize(W * T, H * T, { kernel: "nearest" }).blur(1.2).extractChannel(0).raw().toBuffer();
    // Shorelines, and the edges of natural ground, follow organic curves rather than the tile grid (rounded, then
    // nudged by noise; never more than half a tile from the real edge).
    if (opts.flatGround && organic) alpha = (await organicPartition())(code);
    // (Two steps: sharp drops alpha at the end of a pipeline, which would also drop the joined mask.)
    const rgb = await sharp(full).removeAlpha().raw().toBuffer();
    const rgba = await sharp(rgb, { raw: { width: W * T, height: H * T, channels: 3 } }).joinChannel(alpha, { raw: { width: W * T, height: H * T, channels: 1 } }).png().toBuffer();
    layers.push({ input: rgba, left: 0, top: 0 });
  }
  const topdown = await sharp({ create: { width: W * T, height: H * T, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } }).composite(layers).png().toBuffer();

  // 2. Project to isometric: (X, Y) -> (X - Y, (X + Y) / 2), as the game draws tiles.
  const iso = await sharp(topdown).affine([[HW / T, -HW / T], [HH / T, HH / T]], { background: { r: 0, g: 0, b: 0, alpha: 0 }, interpolator: 'bicubic' }).png().toBuffer({ resolveWithObject: true });
  const width = iso.info.width, height = iso.info.height + TOP;
  const scene = { ox: H * HW, oy: TOP + HH };
  const at = (x: number, y: number) => tileToScene(scene, x, y);

  // 3. Things standing on the map, back to front.
  type Item = { depth: number; input: Buffer; left: number; top: number };
  const items: Item[] = [];
  const cache = new Map<string, { buf: Buffer; w: number; h: number } | null>();
  const sprite = async (file: string | undefined, maxH: number, maxW: number, mirror: boolean) => {
    const key = `${file}:${maxH}:${maxW}:${mirror}`;
    if (cache.has(key)) return cache.get(key)!;
    let v: { buf: Buffer; w: number; h: number } | null = null;
    if (file) {
      const trimmed = await sharp(file).trim().png().toBuffer({ resolveWithObject: true });
      const sc = Math.min(maxH / trimmed.info.height, maxW / trimmed.info.width);
      const wd = Math.max(1, Math.round(trimmed.info.width * sc)), ht = Math.max(1, Math.round(trimmed.info.height * sc));
      let img = sharp(trimmed.data).resize(wd, ht);
      if (mirror) img = img.flop();
      v = { buf: await img.png().toBuffer(), w: wd, h: ht };
    }
    cache.set(key, v);
    return v;
  };
  const shadow = (cx: number, cy: number, rx: number, ry: number) => ({
    depth: -1,
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rx * 2 + 8)}" height="${Math.ceil(ry * 2 + 8)}"><defs><radialGradient id="g"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse cx="${rx + 4}" cy="${ry + 4}" rx="${rx}" ry="${ry}" fill="url(#g)"/></svg>`),
    left: Math.round(cx - rx - 4),
    top: Math.round(cy - ry - 4),
  });
  const shadows: Item[] = [];
  const wallTop = z.kind === 'town' ? 62 : z.kind === 'interior' ? 54 : 40;
  const wallColor = hex(ts.roles.wall.colors[0], '#8a8378');
  // Walls show their painted material (a small repeating swatch), shaded per face.
  const wallFile = fileOf(ts.roles.wall.asset);
  const wallSwatch = wallFile ? `data:image/png;base64,${(await sharp(wallFile).resize(32, 32).png().toBuffer()).toString('base64')}` : undefined;
  // Everything standing gets an id (walls per tile, props per anchor) for the id map.
  const objects: SceneObject[] = [];
  const idItems: Item[] = [];
  const idColor = (id: number) => `#${(id + 1).toString(16).padStart(6, '0')}`;
  const silhouette = async (buf: Buffer, id: number) => {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const c = id + 1;
    for (let k = 0; k < info.width * info.height; k++) {
      const on = data[k * 4 + 3]! >= 128;
      data[k * 4] = (c >> 16) & 255;
      data[k * 4 + 1] = (c >> 8) & 255;
      data[k * 4 + 2] = c & 255;
      data[k * 4 + 3] = on ? 255 : 0;
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (g[i] === GROUND.wall && opts.walls !== false && opts.blocks !== false) {
        // A wall tile as a small box: front-left, front-right and top faces.
        const p0 = at(x, y);
        const left = Math.floor(p0.x - HW), top = Math.floor(p0.y - HH - wallTop);
        const P = (tx: number, ty: number, h: number) => {
          const p = at(tx, ty);
          return `${(p.x - left).toFixed(1)},${(p.y - h - top).toFixed(1)}`;
        };
        const faces = (f1: string, f2: string, f3: string, crisp = false, swatch?: string) => {
          const q = (pts: string[], fill: string, tex = false) =>
            (tex && swatch ? `<polygon points="${pts.join(' ')}" fill="url(#t)"/>` : '') + `<polygon points="${pts.join(' ')}" fill="${fill}"${tex && swatch ? ' fill-opacity="0.45"' : ''}${crisp ? ' shape-rendering="crispEdges"' : ''}/>`;
          const defs = swatch ? `<defs><pattern id="t" patternUnits="userSpaceOnUse" width="32" height="32"><image href="${swatch}" width="32" height="32"/></pattern></defs>` : '';
          return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${HW * 2 + 2}" height="${HH * 2 + wallTop + 2}">${defs}${q([P(x - 0.5, y + 0.5, 0), P(x + 0.5, y + 0.5, 0), P(x + 0.5, y + 0.5, wallTop), P(x - 0.5, y + 0.5, wallTop)], f1, true)}${q([P(x + 0.5, y + 0.5, 0), P(x + 0.5, y - 0.5, 0), P(x + 0.5, y - 0.5, wallTop), P(x + 0.5, y + 0.5, wallTop)], f2, true)}${q([P(x - 0.5, y - 0.5, wallTop), P(x + 0.5, y - 0.5, wallTop), P(x + 0.5, y + 0.5, wallTop), P(x - 0.5, y + 0.5, wallTop)], f3)}</svg>`);
        };
        const id = objects.length;
        objects.push({ id, kind: 'wall', x, y, depth: x + y, size: 1 });
        items.push({ depth: x + y, input: faces(shade(wallColor, 0.78), shade(wallColor, 0.6), shade(wallColor, 1.0), false, wallSwatch), left, top });
        if (opts.ids) idItems.push({ depth: x + y, input: faces(idColor(id), idColor(id), idColor(id), true), left, top });
        continue;
      }
      const ob = o[i]!;
      if (!ob || ob === PROP_COVER || ob === PROP_COVER_TALL || opts.props === 'none') continue;
      const pi = propIndex(ob);
      let file: string | undefined, mh: number, mw: number, n = 1, height: PropDef['height'] = 'mid', mirror = false, blocks = true;
      if (pi >= 0) {
        const p = ts.props?.[pi];
        if (!p) continue;
        n = p.size;
        height = p.height;
        blocks = p.blocks;
        file = fileOf(p.asset);
        [mh, mw] = PROP_ART[p.height][n - 1]!;
        mirror = p.height === 'tall' && (z.variation ? base64ToBytes(z.variation)[i]! & 1 : 0) === 1;
      } else {
        const r = LEGACY_ROLE[ob];
        if (!r) continue;
        file = fileOf(ts.roles[r as 'tree'].asset);
        [mh, mw] = LEGACY_ART[r]!;
        height = r === 'tree' || r === 'pillar' ? 'tall' : r === 'plant' || r === 'rubble' ? 'low' : 'mid';
        blocks = r !== 'plant' && r !== 'rubble';
      }
      if (opts.props === 'low' && height !== 'low') continue;
      const spr = await sprite(file, mh, mw, mirror);
      const c = at(x + (n - 1) / 2, y + (n - 1) / 2);
      const depth = x + y + (n - 1) * 2 + 0.1;
      shadows.push(shadow(c.x, c.y, (n * HW * 0.8), (n * HH * 0.8)));
      if (!spr) continue;
      const left = Math.round(c.x - spr.w / 2), top = Math.round(c.y - spr.h + 2);
      items.push({ depth, input: spr.buf, left, top });
      // Walkable low things (rugs, papers) never hide anyone: they need no cut-out.
      if (!blocks && height === 'low') continue;
      const id = objects.length;
      objects.push({ id, kind: 'prop', x, y, depth, size: n });
      if (opts.ids) idItems.push({ depth, input: await silhouette(spr.buf, id), left, top });
    }
  const clip = (it: Item) => ({ input: it.input, left: Math.max(0, it.left), top: Math.max(0, it.top) });
  const byDepth = (a: Item, b: Item) => a.depth - b.depth;
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } })
    .composite([{ input: iso.data, left: 0, top: TOP }, ...shadows.map(clip), ...items.sort(byDepth).map(clip)])
    .png()
    .toBuffer();
  const ids = opts.ids
    ? await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } }).composite(idItems.sort(byDepth).map(clip)).removeAlpha().raw().toBuffer()
    : undefined;
  return { png, width, height, ...scene, objects, ids };
}

/** How strongly a surface is present at each pixel (T pixels per tile): its tiles, rounded, nudged by noise. */
async function organicField(mask: Buffer, W: number, H: number, wobble: number, seed: number): Promise<Float32Array> {
  const blurred = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).resize(W * T, H * T, { kernel: 'nearest' }).blur(T * 0.45).extractChannel(0).raw().toBuffer();
  const grid = (cell: number, sd: number) => {
    const gw = Math.ceil((W * T) / cell) + 2, gh = Math.ceil((H * T) / cell) + 2;
    const v = new Float32Array(gw * gh);
    let st = sd;
    for (let i = 0; i < v.length; i++) (st = (st * 1103515245 + 12345) >>> 0), (v[i] = (st / 4294967296) * 2 - 1);
    return (x: number, y: number) => {
      const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
      const a = v[y0 * gw + x0]!, b = v[y0 * gw + x0 + 1]!, c = v[(y0 + 1) * gw + x0]!, d = v[(y0 + 1) * gw + x0 + 1]!;
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
  };
  const n1 = grid(T * 1.5, 7 + seed * 31), n2 = grid(T * 0.6, 13 + seed * 17);
  const out = new Float32Array(W * T * H * T);
  for (let y = 0; y < H * T; y++)
    for (let x = 0; x < W * T; x++) {
      const k = y * W * T + x;
      out[k] = blurred[k]! / 255 + (n1(x, y) * 0.7 + n2(x, y) * 0.3) * wobble * 0.5;
    }
  return out;
}
