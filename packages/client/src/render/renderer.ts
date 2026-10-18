/** Isometric 2D renderer and mouse input for the game view. */
import {
  ALLY_PASS_COST, GROUND, OBJ, findPath, reachable, rx, skillRange, hasLineOfSight,
  type EntityView, type FeatureDef, type FxEvent, type TilesetDef, type TileRole, type Vec2,
} from '@gd/shared';
import type { GameClient } from '../net/game';
import { TEX, hexToRgb, imageTexture, mix, proceduralTexture, rgb, shade, strHash } from './textures';
import { ART_SIZE, blockSprite, featureSprite, furnitureSprite, imageSprite, lightSprite, pillarSprite, plantSprite, rockSprite, rubbleSprite, treeSprite, type Sprite } from './props';
import { drawFigure, drawImageSprite, drawShadow, loadImage, type PoseFrames } from './sprites';
import { FxSystem } from './fx';
import { HIGHLIGHT, drawOutline } from './highlight';
import { kindColor, rules } from '../rules';

const HW = 32; // half tile width
const HH = 16; // half tile height

/** Features the player can use (they glow when near). Doors only glow on hover; they are everywhere. */
const USABLE = new Set(['chest', 'lever', 'shrine', 'sign', 'lore', 'bed', 'craft_station', 'waypoint']);

let lootCanvas: HTMLCanvasElement | null = null;
/** A dropped satchel (drawn once). */
function lootSprite(): HTMLCanvasElement {
  if (lootCanvas) return lootCanvas;
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 20;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7a5a34';
  g.beginPath();
  g.ellipse(12, 12, 8, 6, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#5a4024';
  g.fillRect(9, 4, 6, 4);
  g.fillStyle = '#ffe08a';
  g.beginPath();
  g.arc(17, 4, 1.6, 0, Math.PI * 2);
  g.fill();
  lootCanvas = c;
  return c;
}
const CHUNK = 12;

const iso = (x: number, y: number) => ({ x: (x - y) * HW, y: (x + y) * HH });

interface Anim {
  /** Displayed position: eases toward the server position so path changes never pop. */
  px: number;
  py: number;
  walk: number;
  moving: boolean;
  /** 0..1 blend between idle and walk poses, so starts and stops ease in and out. */
  amt: number;
  /** Screen-facing with hysteresis, so figures don't flicker when walking straight up or down the screen. */
  dir: 1 | -1;
  face: number;
  hurt: number;
  attack: number;
  death: number;
  lastHp: number;
  fade: number;
}

interface Drawable {
  depth: number;
  draw: () => void;
}

export interface HoverInfo {
  tile: Vec2 | null;
  /** Exact ground point under the cursor, in tile coordinates. */
  point: Vec2 | null;
  entityId?: string;
  featureId?: string;
  lootId?: string;
  screenX: number;
  screenY: number;
}

const BLOCKING = new Set<number>([OBJ.tree, OBJ.rock, OBJ.furniture, OBJ.pillar, OBJ.light]);
const SOLID_FEATURE = new Set(['chest', 'shrine', 'sign', 'lever', 'lore', 'bed', 'craft_station', 'waypoint']);

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private W = 0;
  private H = 0;
  camX = 0;
  camY = 0;
  zoom = 1;
  private camInit = false;
  private chunks = new Map<string, HTMLCanvasElement>();
  private chunkVersion = '';
  private textures = new Map<string, HTMLCanvasElement>();
  private wallCache = new Map<string, Sprite>();
  private lightCanvas = document.createElement('canvas');
  private fogCanvas = document.createElement('canvas');
  private anims = new Map<string, Anim>();
  readonly fx = new FxSystem();
  hover: HoverInfo = { tile: null, point: null, screenX: 0, screenY: 0 };
  private hitRects: { id: string; kind: 'entity' | 'feature' | 'loot'; x: number; y: number; w: number; h: number; depth: number }[] = [];
  private raf = 0;
  private last = performance.now();
  private t = 0;
  private reach: { key: string; map: Map<number, number> } | null = null;
  private weather: { x: number; y: number; z: number; s: number; p: number }[] = [];
  private exploredDirtyAt = 0;
  private lastExploreTile = '';
  private unsubFx: () => void;
  onClick?: (info: HoverInfo, button: number, ev: MouseEvent) => void;

  constructor(private canvas: HTMLCanvasElement, private client: GameClient) {
    this.ctx = canvas.getContext('2d')!;
    this.unsubFx = client.onFx((ev) => this.onFx(ev));
    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('mousemove', this.onMove);
    canvas.addEventListener('mousedown', this.onDown);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('mousemove', this.onMove);
    this.canvas.removeEventListener('mousedown', this.onDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.unsubFx();
  }

  private resize = () => {
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width;
    this.H = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.lightCanvas.width = Math.ceil(r.width / 2);
    this.lightCanvas.height = Math.ceil(r.height / 2);
    this.fogCanvas.width = Math.ceil(r.width / 4);
    this.fogCanvas.height = Math.ceil(r.height / 4);
  };

  // ---------------------------------------------------------------------------- coordinates

  private worldToScreen(wx: number, wy: number) {
    const c = iso(this.camX, this.camY);
    return { x: (wx - c.x) * this.zoom + this.W / 2, y: (wy - c.y) * this.zoom + this.H / 2 };
  }

  tileToScreen(x: number, y: number, z = 0) {
    const p = iso(x, y);
    return this.worldToScreen(p.x, p.y - z);
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    const c = iso(this.camX, this.camY);
    const wx = (sx - this.W / 2) / this.zoom + c.x;
    const wy = (sy - this.H / 2) / this.zoom + c.y;
    return { x: (wy / HH + wx / HW) / 2, y: (wy / HH - wx / HW) / 2 };
  }

  private setWorldTransform() {
    const c = iso(this.camX, this.camY);
    const k = this.dpr * this.zoom;
    this.ctx.setTransform(k, 0, 0, k, (this.W / 2) * this.dpr - c.x * k, (this.H / 2) * this.dpr - c.y * k);
  }

  private setScreenTransform() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ---------------------------------------------------------------------------- input

  private onMove = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    this.hover = this.pick(sx, sy);
  };

  private onDown = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const info = this.pick(e.clientX - r.left, e.clientY - r.top);
    this.onClick?.(info, e.button, e);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = Math.max(0.55, Math.min(1.9, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  };

  private pick(sx: number, sy: number): HoverInfo {
    const t = this.screenToTile(sx, sy);
    const tile = { x: Math.round(t.x), y: Math.round(t.y) };
    const z = this.client.state.zone;
    const inside = !!z && tile.x >= 0 && tile.y >= 0 && tile.x < z.width && tile.y < z.height;
    const info: HoverInfo = { tile: inside ? tile : null, point: inside ? t : null, screenX: sx, screenY: sy };
    // Overlapping figures: the one whose body centre is nearest the cursor wins, so a figure standing just
    // behind another can still be clicked on its visible part. Entities beat features and loot.
    let best: (typeof this.hitRects)[number] | null = null;
    let bestScore = Infinity;
    for (const h of this.hitRects) {
      if (sx < h.x || sy < h.y || sx > h.x + h.w || sy > h.y + h.h) continue;
      const nx = (sx - (h.x + h.w / 2)) / (h.w / 2), ny = (sy - (h.y + h.h * 0.45)) / (h.h / 2);
      const score = nx * nx + ny * ny + (h.kind === 'entity' ? 0 : 0.6) - h.depth * 1e-4;
      if (score < bestScore) {
        best = h;
        bestScore = score;
      }
    }
    if (best) {
      if (best.kind === 'entity') info.entityId = best.id;
      else if (best.kind === 'feature') info.featureId = best.id;
      else info.lootId = best.id;
    } else if (z && info.tile) {
      const f = z.features.find((ff) => ff.x === info.tile!.x && ff.y === info.tile!.y && ff.kind !== 'trap');
      if (f) info.featureId = f.id;
      const l = this.client.state.lootPiles.find((p) => p.x === info.tile!.x && p.y === info.tile!.y);
      if (l) info.lootId = l.id;
    }
    return info;
  }

  // ---------------------------------------------------------------------------- textures

  private texture(ts: TilesetDef, role: TileRole | 'roof'): HTMLCanvasElement {
    const key = `${ts.id}:${role}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    let tex: HTMLCanvasElement | null = null;
    {
      const url = this.client.assetUrl(role === 'roof' ? ts.extras?.roof?.asset : ts.roles[role]?.asset);
      const img = loadImage(url);
      if (img) tex = imageTexture(img);
      else if (url) {
        // Not loaded yet: use procedural for now and retry later.
        const p = proceduralTexture(ts, role);
        setTimeout(() => {
          this.textures.delete(key);
          this.chunks.clear();
          this.wallCache.clear();
        }, 1500);
        return p;
      }
    }
    tex = tex ?? proceduralTexture(ts, role);
    this.textures.set(key, tex);
    return tex;
  }

  private tileset(): TilesetDef | undefined {
    const z = this.client.state.zone;
    return z ? this.client.state.world?.tilesets[z.tilesetId] : undefined;
  }

  // ---------------------------------------------------------------------------- ground chunks

  private vertexJitter(x: number, y: number, amp: number) {
    const h = strHash(`${x},${y}`);
    return { dx: (((h & 255) / 255) - 0.5) * amp, dy: ((((h >> 8) & 255) / 255) - 0.5) * amp };
  }

  /** Diamond with shared, deterministically jittered vertices so same-role tiles merge into organic shapes. */
  private organicDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, amp: number, ox: number, oy: number) {
    const corners = [
      [x - 0.5, y - 0.5], [x, y - 0.5], [x + 0.5, y - 0.5], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5], [x - 0.5, y + 0.5], [x - 0.5, y],
    ];
    ctx.moveTo(0, 0);
    corners.forEach(([cx, cy], i) => {
      const j = amp ? this.vertexJitter(Math.round(cx! * 2), Math.round(cy! * 2), amp) : { dx: 0, dy: 0 };
      const p = iso(cx! + j.dx, cy! + j.dy);
      if (i === 0) ctx.moveTo(p.x + ox, p.y + oy);
      else ctx.lineTo(p.x + ox, p.y + oy);
    });
    ctx.closePath();
  }

  private chunkCanvas(cx: number, cy: number): HTMLCanvasElement | null {
    const st = this.client.state;
    const z = st.zone;
    const ts = this.tileset();
    if (!z || !ts) return null;
    const key = `${cx},${cy}`;
    const c0 = this.chunks.get(key);
    if (c0) return c0;
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const pad = 40;
    const minWX = (x0 - (y0 + CHUNK - 1)) * HW - HW - pad;
    const maxWX = (x0 + CHUNK - 1 - y0) * HW + HW + pad;
    const minWY = (x0 + y0) * HH - HH - pad;
    const maxWY = (x0 + y0 + 2 * CHUNK - 2) * HH + HH + pad;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(maxWX - minWX);
    canvas.height = Math.ceil(maxWY - minWY);
    const ctx = canvas.getContext('2d')!;
    const ox = -minWX, oy = -minWY;
    const W = z.width;
    const g = (x: number, y: number) => (x < 0 || y < 0 || x >= z.width || y >= z.height ? GROUND.void : z.groundBytes[y * W + x]!);
    const pattern = (role: TileRole) => {
      const p = ctx.createPattern(this.texture(ts, role), 'repeat')!;
      const T = 2;
      const k = T / TEX;
      p.setTransform(new DOMMatrix([HW * k, HH * k, -HW * k, HH * k, ox, oy]));
      return p;
    };
    const tiles: { x: number; y: number; g: number }[] = [];
    for (let y = Math.max(0, y0 - 2); y < Math.min(z.height, y0 + CHUNK + 2); y++)
      for (let x = Math.max(0, x0 - 2); x < Math.min(z.width, x0 + CHUNK + 2); x++) tiles.push({ x, y, g: g(x, y) });
    const inChunk = (t: { x: number; y: number }) => t.x >= x0 && t.y >= y0 && t.x < x0 + CHUNK && t.y < y0 + CHUNK;
    // Base floor under everything walkable or wall.
    ctx.fillStyle = pattern('floor');
    ctx.beginPath();
    for (const t of tiles) if (inChunk(t) && t.g !== GROUND.void) this.organicDiamond(ctx, t.x, t.y, 0, ox, oy);
    ctx.fill();
    // Layers with soft, organic edges: a blurred mask of jittered diamonds filled with the role texture.
    // Neighbors outside the chunk are included so edges match across chunk borders.
    const softLayer = (code: number, role: TileRole, amp: number, blur: number, rim: number) => {
      const sel = tiles.filter((t) => t.g === code);
      if (!sel.length) return;
      const mask = document.createElement('canvas');
      mask.width = canvas.width;
      mask.height = canvas.height;
      const m = mask.getContext('2d')!;
      const shape = () => {
        m.beginPath();
        for (const t of sel) this.organicDiamond(m, t.x, t.y, amp, ox, oy);
      };
      if (rim > 0) {
        // A faint darker rim where the layer meets the base ground.
        m.filter = `blur(${blur * 1.6}px)`;
        m.fillStyle = `rgba(0,0,0,${rim})`;
        shape();
        m.fill();
        ctx.drawImage(mask, 0, 0);
        m.clearRect(0, 0, mask.width, mask.height);
      }
      m.filter = `blur(${blur}px)`;
      m.fillStyle = '#fff';
      shape();
      m.fill();
      m.filter = 'none';
      m.globalCompositeOperation = 'source-in';
      const p = m.createPattern(this.texture(ts, role), 'repeat')!;
      const k = 2 / TEX;
      p.setTransform(new DOMMatrix([HW * k, HH * k, -HW * k, HH * k, ox, oy]));
      m.fillStyle = p;
      m.fillRect(0, 0, mask.width, mask.height);
      ctx.drawImage(mask, 0, 0);
    };
    softLayer(GROUND.floorAlt, 'floorAlt', 0.6, 7, 0);
    softLayer(GROUND.path, 'path', 0.35, 4, 0.22);
    // Water with a darker bank.
    ctx.save();
    ctx.beginPath();
    for (const t of tiles) if (t.g === GROUND.water) this.organicDiamond(ctx, t.x, t.y, 0.45, ox, oy);
    ctx.fillStyle = 'rgba(20,30,40,0.55)';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(30,25,20,0.35)';
    ctx.stroke();
    ctx.fillStyle = pattern('water');
    ctx.fill();
    ctx.restore();
    // Per-tile variation and ambient occlusion near walls.
    for (const t of tiles) {
      if (!inChunk(t) || t.g === GROUND.void || t.g === GROUND.wall) continue;
      const v = z.variationBytes[t.y * W + t.x]! / 255;
      ctx.beginPath();
      this.organicDiamond(ctx, t.x, t.y, 0, ox, oy);
      ctx.fillStyle = v > 0.5 ? `rgba(255,255,240,${(v - 0.5) * 0.07})` : `rgba(0,0,0,${(0.5 - v) * 0.1})`;
      ctx.fill();
      const wallN = g(t.x, t.y - 1) === GROUND.wall || g(t.x - 1, t.y) === GROUND.wall || g(t.x - 1, t.y - 1) === GROUND.wall;
      if (wallN) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fill();
      }
    }
    // Remember the chunk's world origin.
    (canvas as HTMLCanvasElement & { wx: number; wy: number }).wx = minWX;
    (canvas as HTMLCanvasElement & { wx: number; wy: number }).wy = minWY;
    this.chunks.set(key, canvas);
    if (this.chunks.size > 40) this.chunks.delete(this.chunks.keys().next().value!);
    return canvas;
  }

  // ---------------------------------------------------------------------------- walls

  private wallHeight(): number {
    const z = this.client.state.zone;
    return z?.kind === 'town' ? 62 : z?.kind === 'interior' ? 54 : 40;
  }

  private wallSprite(ts: TilesetDef, left: boolean, right: boolean, roof: boolean, variant: number, heightOverride?: number): Sprite {
    const H = heightOverride ?? this.wallHeight();
    const key = `${ts.id}:${left}:${right}:${roof}:${H}:${variant}`;
    let s = this.wallCache.get(key);
    if (s) return s;
    const c = document.createElement('canvas');
    c.width = HW * 2 + 4;
    c.height = HH * 2 + H + 4;
    const ctx = c.getContext('2d')!;
    const ax = HW + 2, ay = HH + H + 2; // anchor = tile center on ground
    ctx.translate(ax, ay);
    const tex = this.texture(ts, 'wall');
    const p = ctx.createPattern(tex, 'repeat')!;
    const k = 64 / TEX;
    const N = { x: 0, y: -HH }, E = { x: HW, y: 0 }, S = { x: 0, y: HH }, Wp = { x: -HW, y: 0 };
    const face = (a: Vec2, b: Vec2, dark: number) => {
      // Texture u runs along a->b (one texture spans two faces), v runs down the face (64px per texture).
      const dux = ((b.x - a.x) * 2) / TEX, duy = ((b.y - a.y) * 2) / TEX;
      const off = (variant % 2) * 0.5;
      p.setTransform(new DOMMatrix([dux, duy, 0, 64 / TEX, a.x - (b.x - a.x) * off, a.y - H - (b.y - a.y) * off]));
      void k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y - H);
      ctx.lineTo(a.x, a.y - H);
      ctx.closePath();
      ctx.fillStyle = p;
      ctx.fill();
      ctx.fillStyle = `rgba(0,0,0,${dark})`;
      ctx.fill();
      // Grounding gradient
      const g = ctx.createLinearGradient(0, Math.max(a.y, b.y), 0, Math.max(a.y, b.y) - H * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fill();
    };
    if (left) face(Wp, S, 0.22);
    if (right) face(S, E, 0.42);
    // Top
    ctx.beginPath();
    ctx.moveTo(N.x, N.y - H);
    ctx.lineTo(E.x, E.y - H);
    ctx.lineTo(S.x, S.y - H);
    ctx.lineTo(Wp.x, Wp.y - H);
    ctx.closePath();
    const topTex = roof ? this.texture(ts, 'roof') : tex;
    const tp = ctx.createPattern(topTex, 'repeat')!;
    const tk = 1 / TEX;
    tp.setTransform(new DOMMatrix([HW * tk, HH * tk, -HW * tk, HH * tk, (variant % 3) * 11, -HH - H]));
    ctx.fillStyle = tp;
    ctx.fill();
    const zk = this.client.state.zone?.kind;
    ctx.fillStyle = roof ? 'rgba(0,0,0,0.05)' : zk === 'dungeon' ? 'rgba(6,4,10,0.62)' : 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.strokeStyle = roof ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    s = { canvas: c, ax, ay };
    this.wallCache.set(key, s);
    return s;
  }

  // ---------------------------------------------------------------------------- buildings

  private bld: { zoneId: string; map: Int32Array; list: Building[]; doors: Set<number> } | null = null;

  /** Find rectangular wall blocks in towns; they get pitched roofs. */
  private buildings() {
    const z = this.client.state.zone!;
    if (this.bld?.zoneId === z.id) return this.bld;
    const W = z.width, H = z.height;
    const map = new Int32Array(W * H).fill(-1);
    const list: Building[] = [];
    const doors = new Set<number>();
    for (const f of z.features) if (f.kind === 'door') doors.add(f.y * W + f.x);
    const solid = (i: number) => z.groundBytes[i] === GROUND.wall || doors.has(i);
    if (z.kind === 'town' && !z.indoor && z.layout?.structures !== 'walled') {
      for (let i = 0; i < W * H; i++) {
        if (z.groundBytes[i] !== GROUND.wall || map[i]! >= 0) continue;
        const idx = list.length;
        const stack = [i];
        map[i] = idx;
        let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
        while (stack.length) {
          const k = stack.pop()!;
          const x = k % W, y = (k / W) | 0;
          n++;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (map[ni]! >= 0 || !solid(ni)) continue;
            map[ni] = idx;
            stack.push(ni);
          }
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const roofed = x0 > 1 && y0 > 1 && x1 < W - 2 && y1 < H - 2 && n >= w * h - 2 && w >= 3 && h >= 3;
        list.push({ x0, y0, x1, y1, alongX: w >= h, roofed });
      }
    }
    this.bld = { zoneId: z.id, map, list, doors };
    return this.bld;
  }

  private roofHeight(b: Building, cx: number, cy: number, H: number) {
    const pitch = 24;
    if (b.alongX) {
      const half = (b.y1 - b.y0 + 1) / 2, mid = (b.y0 + b.y1) / 2;
      return H + pitch * half * Math.max(0, 1 - Math.abs(cy - mid) / half);
    }
    const half = (b.x1 - b.x0 + 1) / 2, mid = (b.x0 + b.x1) / 2;
    return H + pitch * half * Math.max(0, 1 - Math.abs(cx - mid) / half);
  }

  /** Draw one tile of a pitched-roof building: exposed wall faces (with gables and windows) and its roof piece. */
  private drawRoofTile(ts: TilesetDef, b: Building, x: number, y: number, v: number, alpha: number) {
    const ctx = this.ctx;
    const z = this.client.state.zone!;
    const H = this.wallHeight();
    const doors = this.bld?.doors;
    const isWall = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < z.width && yy < z.height && (z.groundBytes[yy * z.width + xx] === GROUND.wall || !!doors?.has(yy * z.width + xx));
    const isDoor = !!doors?.has(y * z.width + x);
    const P = (tx: number, ty: number, h: number) => {
      const p = iso(tx, ty);
      return { x: p.x, y: p.y - h };
    };
    const hAt = (cx: number, cy: number) => this.roofHeight(b, cx, cy, H);
    const wallTex = ctx.createPattern(this.texture(ts, 'wall'), 'repeat')!;
    const wallBase = hexToRgb(ts.roles.wall.colors[0] ?? '#8a8378');
    const night = this.daylight().darkness;
    ctx.save();
    ctx.globalAlpha = alpha;
    const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const face = (ax: number, ay: number, bx: number, by: number, dark: number, windowSeed: number) => {
      const a0 = P(ax, ay, 0), b0 = P(bx, by, 0), a1 = P(ax, ay, hAt(ax, ay)), b1 = P(bx, by, hAt(bx, by));
      ctx.beginPath();
      ctx.moveTo(a0.x, a0.y);
      ctx.lineTo(b0.x, b0.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.lineTo(a1.x, a1.y);
      ctx.closePath();
      ctx.fillStyle = rgb(shade(wallBase, 1.05));
      ctx.fill();
      ctx.fillStyle = wallTex;
      ctx.globalAlpha = alpha * 0.55;
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgba(0,0,0,${dark})`;
      ctx.fill();
      // Timber beams at the base and the top of the wall.
      ctx.strokeStyle = 'rgba(40,26,16,0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(a0.x, a0.y - 3);
      ctx.lineTo(b0.x, b0.y - 3);
      ctx.moveTo(a0.x, a0.y - H);
      ctx.lineTo(b0.x, b0.y - H);
      ctx.stroke();
      if (isDoor) {
        const d0 = lerp(a0, b0, 0.22), d1 = lerp(a0, b0, 0.78);
        const top = H * 0.78;
        const mid = lerp(d0, d1, 0.5);
        ctx.beginPath();
        ctx.moveTo(d0.x, d0.y);
        ctx.lineTo(d0.x, d0.y - top * 0.8);
        ctx.quadraticCurveTo(mid.x, mid.y - top * 1.12, d1.x, d1.y - top * 0.8);
        ctx.lineTo(d1.x, d1.y);
        ctx.closePath();
        const doorCol = hexToRgb(ts.roles.door.colors[0] ?? '#6a4a2a');
        ctx.fillStyle = rgb(shade(doorCol, 0.9));
        ctx.fill();
        ctx.strokeStyle = 'rgba(30,18,10,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(30,18,10,0.4)';
        ctx.lineWidth = 1;
        for (const t of [0.36, 0.64]) {
          const q = lerp(d0, d1, t);
          ctx.beginPath();
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(q.x, q.y - top * 0.86);
          ctx.stroke();
        }
        const knob = lerp(d0, d1, 0.7);
        ctx.fillStyle = '#e0c070';
        ctx.beginPath();
        ctx.arc(knob.x, knob.y - top * 0.42, 1.8, 0, Math.PI * 2);
        ctx.fill();
        // A warm lantern over the door at night.
        if (night > 0.25) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const lp = { x: mid.x, y: mid.y - top * 1.2 };
          const g = ctx.createRadialGradient(lp.x, lp.y, 0, lp.x, lp.y, 26);
          g.addColorStop(0, 'rgba(255,190,100,0.55)');
          g.addColorStop(1, 'rgba(255,190,100,0)');
          ctx.fillStyle = g;
          ctx.fillRect(lp.x - 26, lp.y - 26, 52, 52);
          ctx.restore();
        }
      } else if (windowSeed % 3 === 0) {
        const w0 = lerp(a0, b0, 0.3), w1 = lerp(a0, b0, 0.7);
        const lo = H * 0.32, hi = H * 0.72;
        ctx.beginPath();
        ctx.moveTo(w0.x, w0.y - lo);
        ctx.lineTo(w1.x, w1.y - lo);
        ctx.lineTo(w1.x, w1.y - hi);
        ctx.lineTo(w0.x, w0.y - hi);
        ctx.closePath();
        const lit = night > 0.25;
        ctx.fillStyle = lit ? `rgba(255,${190 + (windowSeed % 40)},110,${0.55 + night * 0.4})` : 'rgba(30,34,44,0.85)';
        if (lit) {
          ctx.shadowColor = 'rgba(255,200,110,0.9)';
          ctx.shadowBlur = 10;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(50,32,18,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const m0 = lerp(w0, w1, 0.5);
        ctx.beginPath();
        ctx.moveTo(m0.x, m0.y - lo);
        ctx.lineTo(m0.x, m0.y - hi);
        ctx.stroke();
      }
    };
    if (!isWall(x, y + 1)) face(x - 0.5, y + 0.5, x + 0.5, y + 0.5, 0.12, v);
    if (!isWall(x + 1, y)) face(x + 0.5, y + 0.5, x + 0.5, y - 0.5, 0.36, v >> 2);
    // Roof piece, split at the ridge when it crosses this tile.
    const roofBase = mix(hexToRgb(ts.roles.wall.colors[1] ?? '#6a3a2a'), [128, 52, 40], 0.45);
    const roofTex = ctx.createPattern(this.texture(ts, 'roof'), 'repeat')!;
    const piece = (pts: [number, number][], light: number) => {
      ctx.beginPath();
      pts.forEach(([cx, cy], i) => {
        const p = P(cx, cy, hAt(cx, cy) + 2);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = rgb(shade(roofBase, light));
      ctx.fill();
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = roofTex;
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(20,10,8,0.18)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    };
    const x0 = x - 0.5, x1 = x + 0.5, y0 = y - 0.5, y1 = y + 0.5;
    if (b.alongX) {
      const mid = (b.y0 + b.y1) / 2;
      if (mid > y0 && mid < y1) {
        piece([[x0, y0], [x1, y0], [x1, mid], [x0, mid]], 0.72);
        piece([[x0, mid], [x1, mid], [x1, y1], [x0, y1]], 1.08);
      } else piece([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], y0 >= mid ? 1.08 : 0.72);
    } else {
      const mid = (b.x0 + b.x1) / 2;
      if (mid > x0 && mid < x1) {
        piece([[x0, y0], [mid, y0], [mid, y1], [x0, y1]], 0.68);
        piece([[mid, y0], [x1, y0], [x1, y1], [mid, y1]], 0.92);
      } else piece([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], x0 >= mid ? 0.92 : 0.68);
    }
    // Eaves: a dark lip along exposed lower edges.
    ctx.strokeStyle = 'rgba(25,12,8,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (!isWall(x, y + 1)) {
      const a = P(x0, y1, hAt(x0, y1) + 2), c = P(x1, y1, hAt(x1, y1) + 2);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
    }
    if (!isWall(x + 1, y)) {
      const a = P(x1, y1, hAt(x1, y1) + 2), c = P(x1, y0, hAt(x1, y0) + 2);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------- frame

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    try {
      this.render(dt);
    } catch (e) {
      console.error(e);
    }
  };

  private ensureChunkVersion() {
    const st = this.client.state;
    const v = `${st.zone?.id}:${st.world?.id}`;
    if (v !== this.chunkVersion) {
      this.chunkVersion = v;
      this.chunks.clear();
      this.wallCache.clear();
      this.anims.clear();
      this.camInit = false;
      this.weather = [];
      this.bld = null;
    }
  }

  private daylight(): { darkness: number; tint: [number, number, number] } {
    const ts = this.tileset();
    const z = this.client.state.zone;
    if (!ts || !z) return { darkness: 0, tint: [0, 0, 0] };
    if (!ts.outdoor || z.kind === 'interior' || z.kind === 'dungeon') {
      const amb = z.kind === 'dungeon' ? Math.min(ts.ambient, 0.45) : ts.ambient;
      return { darkness: Math.max(0, 1 - amb) * 0.92, tint: hexToRgb(ts.fogColor ?? '#0a0810') };
    }
    const minute = this.client.clockMinute() % 1440;
    const h = minute / 60;
    // 0 at noon, 1 at midnight, smooth dawn/dusk.
    const night = h < 5 ? 1 : h < 7.5 ? 1 - (h - 5) / 2.5 : h < 18 ? 0 : h < 20.5 ? (h - 18) / 2.5 : 1;
    const dusk = h > 17 && h < 20.5 ? Math.sin(((h - 17) / 3.5) * Math.PI) : h > 5 && h < 8 ? Math.sin(((h - 5) / 3) * Math.PI) * 0.7 : 0;
    const tint = mix([10, 16, 48], [90, 40, 30], dusk);
    return { darkness: night * 0.66 + dusk * 0.18, tint };
  }

  private render(dt: number) {
    const st = this.client.state;
    const ctx = this.ctx;
    this.ensureChunkVersion();
    this.setScreenTransform();
    const ts = this.tileset();
    const z = st.zone;
    ctx.fillStyle = '#07060a';
    ctx.fillRect(0, 0, this.W, this.H);
    if (!z || !ts) return;
    this.fx.update(dt);
    // Camera follows the leader.
    const leader = this.client.leaderEntity();
    if (leader) {
      const lp = this.client.entityPos(leader);
      const k = this.camInit ? Math.min(1, dt * 6) : 1;
      this.camX += (lp.x - this.camX) * k;
      this.camY += (lp.y - this.camY) * k;
      this.camInit = true;
      this.updateExplored(lp);
    }
    // Visible tile window.
    const corners = [this.screenToTile(0, 0), this.screenToTile(this.W, 0), this.screenToTile(0, this.H), this.screenToTile(this.W, this.H)];
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 2);
    const maxX = Math.min(z.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 4);
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 2);
    const maxY = Math.min(z.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 4);

    // 1. Ground chunks
    this.setWorldTransform();
    for (let cy = Math.floor(minY / CHUNK); cy <= Math.floor(maxY / CHUNK); cy++)
      for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++) {
        const c = this.chunkCanvas(cx, cy) as (HTMLCanvasElement & { wx: number; wy: number }) | null;
        if (c) ctx.drawImage(c, c.wx, c.wy);
      }
    // 2. Animated water shimmer
    const W = z.width;
    ctx.save();
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        if (z.groundBytes[y * W + x] !== GROUND.water) continue;
        const p = iso(x, y);
        const ph = this.t * 1.6 + (x * 0.7 + y * 1.3);
        ctx.strokeStyle = `rgba(220,240,255,${0.12 + Math.sin(ph) * 0.08})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - 14 + Math.sin(ph) * 4, p.y + Math.cos(ph * 0.7) * 3);
        ctx.quadraticCurveTo(p.x, p.y - 3, p.x + 14 + Math.sin(ph) * 4, p.y + Math.cos(ph * 0.7) * 3);
        ctx.stroke();
      }
    ctx.restore();
    // 3. Surfaces
    this.drawSurfaces();
    // 4. Combat / targeting overlays on the ground
    this.drawGroundOverlays();
    // 5. Depth-sorted scene
    this.hitRects = [];
    const list: Drawable[] = [];
    this.collectStatics(list, minX, maxX, minY, maxY, ts);
    this.collectFeatures(list, ts);
    this.collectLoot(list);
    this.collectEntities(list, dt);
    list.sort((a, b) => a.depth - b.depth);
    for (const d of list) {
      try {
        d.draw();
      } catch (e) {
        this.ctx.restore?.();
        if (!this.warned) console.error('[renderer] drawable failed', e);
        this.warned = true;
      }
    }
    // 6. Particles & projectiles
    this.drawFx();
    // 7. Lighting
    this.drawLighting(minX, maxX, minY, maxY);
    // 8. Fog of war
    this.drawFog(minX, maxX, minY, maxY);
    // 9. Weather (screen space)
    this.drawWeather(dt, ts);
    // 10. Floating texts, bars and labels on top
    this.setWorldTransform();
    this.drawTexts();
    this.drawOverlayLabels();
  }

  // ---------------------------------------------------------------------------- exploration

  private updateExplored(lp: { x: number; y: number }) {
    const st = this.client.state;
    const z = st.zone;
    if (!z || !st.explored) return;
    const key = `${Math.round(lp.x)},${Math.round(lp.y)},${st.zoneVersion}`;
    if (key === this.lastExploreTile) return;
    this.lastExploreTile = key;
    for (const e of st.entities.values()) {
      if (e.ownerUserId !== st.userId) continue;
      const p = this.client.entityPos(e);
      const r = 11;
      for (let y = Math.max(0, Math.round(p.y) - r); y <= Math.min(z.height - 1, Math.round(p.y) + r); y++)
        for (let x = Math.max(0, Math.round(p.x) - r); x <= Math.min(z.width - 1, Math.round(p.x) + r); x++)
          if (Math.hypot(x - p.x, y - p.y) <= r) st.explored.set(y * z.width + x);
    }
    this.exploredDirtyAt = performance.now();
  }

  // ---------------------------------------------------------------------------- statics

  private collectStatics(list: Drawable[], minX: number, maxX: number, minY: number, maxY: number, ts: TilesetDef) {
    const st = this.client.state;
    const z = st.zone!;
    const W = z.width;
    const leader = this.client.leaderEntity();
    const lp = leader ? this.client.entityPos(leader) : { x: -99, y: -99 };
    const occluders = [...st.entities.values()].filter((e) => e.ownerUserId === st.userId || e.inCombat).map((e) => this.client.entityPos(e));
    const ctx = this.ctx;
    // Pitched roofs belong to outdoor towns; indoor hubs (lobbies, decks) show their rooms as plain walls.
    const roof = z.kind === 'town' && !z.indoor && z.layout?.structures !== 'walled';
    const bld = this.buildings();
    const g = (x: number, y: number) => (x < 0 || y < 0 || x >= z.width || y >= z.height ? GROUND.void : z.groundBytes[y * W + x]!);
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const i = y * W + x;
        const gr = z.groundBytes[i]!;
        const ob = z.objectBytes[i]!;
        const v = z.variationBytes[i]!;
        const depth = x + y;
        // Cutaway: tall things drawn over any of the party on screen become see-through.
        const occH = gr === GROUND.wall ? this.wallHeight() + 90 : ob === OBJ.tree ? 150 : ob === OBJ.pillar ? 120 : 0;
        const inFront = occH > 0 && depth > lp.x + lp.y + 0.2 && occluders.some((o) => {
          const dx = (x - y - (o.x - o.y)) * HW, dy = (x + y - (o.x + o.y)) * HH;
          return Math.abs(dx) < 40 && dy > -10 && dy - occH < -20;
        });
        if (gr === GROUND.wall) {
          const bi = bld.map[i]!;
          const b = bi >= 0 ? bld.list[bi] : undefined;
          if (b?.roofed) {
            const fade = inFront || occluders.some((o) => o.x <= b.x1 + 0.5 && o.y <= b.y1 + 0.5 && o.x >= b.x0 - 4 && o.y >= b.y0 - 4) ? 0.3 : 1;
            list.push({ depth, draw: () => this.drawRoofTile(ts, b, x, y, v, fade) });
            continue;
          }
          const left = g(x, y + 1) !== GROUND.wall;
          const right = g(x + 1, y) !== GROUND.wall;
          // Interiors: the walls facing the camera are cut down so the room stays visible.
          const low = z.kind === 'interior' && (y === z.height - 1 || x === z.width - 1);
          const spr = this.wallSprite(ts, left, right, roof, v, low ? 14 : undefined);
          const p = iso(x, y);
          list.push({
            depth: depth + 0.0,
            draw: () => {
              ctx.globalAlpha = inFront ? 0.28 : 1;
              ctx.drawImage(spr.canvas, p.x - spr.ax, p.y - spr.ay);
              ctx.globalAlpha = 1;
            },
          });
          continue;
        }
        if (bld.doors.has(i) && bld.map[i]! >= 0) {
          const b = bld.list[bld.map[i]!]!;
          if (b.roofed) {
            const fade = inFront || occluders.some((o) => o.x <= b.x1 + 0.5 && o.y <= b.y1 + 0.5 && o.x >= b.x0 - 4 && o.y >= b.y0 - 4) ? 0.3 : 1;
            list.push({ depth, draw: () => this.drawRoofTile(ts, b, x, y, v, fade) });
            continue;
          }
        }
        if (!ob) continue;
        const p = iso(x, y);
        const jx = ((v & 15) - 7.5) * 0.9, jy = (((v >> 4) & 15) - 7.5) * 0.4;
        let spr: Sprite | null = null;
        const role = ob === OBJ.tree ? 'tree' : ob === OBJ.rock ? 'rock' : ob === OBJ.plant ? 'plant' : ob === OBJ.light ? 'light' : ob === OBJ.furniture ? 'furniture' : ob === OBJ.rubble ? 'rubble' : 'pillar';
        const assetKey = ts.roles[role as TileRole]?.asset;
        const img = loadImage(this.client.assetUrl(assetKey));
        if (img) {
          const [mh, mw] = ART_SIZE[role]!;
          // Slight size variety and mirroring so repeated props do not look stamped.
          const vary = 0.9 + ((v >> 2) & 7) * 0.03;
          const art = imageSprite(img, assetKey!, Math.round(mh * vary), Math.round(mw * vary), (v & 1) === 1);
          list.push({
            depth: depth + 0.05,
            draw: () => {
              ctx.globalAlpha = inFront && mh > 60 ? 0.4 : 1;
              ctx.drawImage(art.canvas, p.x + (role === 'plant' || role === 'rubble' || role === 'rock' ? jx : 0) - art.ax, p.y + (role === 'plant' || role === 'rubble' ? jy : 0) - art.ay);
              ctx.globalAlpha = 1;
            },
          });
          continue;
        }
        switch (ob) {
          case OBJ.tree: spr = z.layout?.structure === 'grid' || (z.indoor && z.kind !== 'dungeon') ? blockSprite(ts, v % 4) : treeSprite(ts, v % 4); break;
          case OBJ.rock: spr = rockSprite(ts, v % 3, (v & 64) > 0); break;
          case OBJ.plant: spr = plantSprite(ts, v % 4); break;
          case OBJ.light: spr = lightSprite(ts, z.kind === 'interior' || z.kind === 'dungeon'); break;
          case OBJ.furniture: spr = furnitureSprite(ts, v % 3); break;
          case OBJ.rubble: spr = rubbleSprite(ts, v % 3); break;
          case OBJ.pillar: spr = pillarSprite(ts); break;
        }
        if (!spr) continue;
        const s = spr;
        const tall = ob === OBJ.tree || ob === OBJ.pillar;
        const sway = ob === OBJ.tree && ts.outdoor ? Math.sin(this.t * 1.2 + x * 0.7 + y) * 0.012 : 0;
        list.push({
          depth: depth + 0.05,
          draw: () => {
            ctx.globalAlpha = inFront && tall ? 0.38 : 1;
            if (sway) {
              ctx.save();
              ctx.translate(p.x + jx, p.y + jy);
              ctx.transform(1, 0, sway * 3, 1, 0, 0);
              ctx.drawImage(s.canvas, -s.ax, -s.ay);
              ctx.restore();
            } else ctx.drawImage(s.canvas, p.x + (ob === OBJ.plant || ob === OBJ.rubble || ob === OBJ.rock ? jx : 0) - s.ax, p.y + (ob === OBJ.plant || ob === OBJ.rubble ? jy : 0) - s.ay);
            ctx.globalAlpha = 1;
          },
        });
      }
  }

  private collectFeatures(list: Drawable[], ts: TilesetDef) {
    const st = this.client.state;
    const z = st.zone!;
    const ctx = this.ctx;
    const bld = this.buildings();
    const leader = this.client.leaderEntity();
    const lp = leader ? this.client.entityPos(leader) : null;
    for (const f of z.features) {
      const fs = st.features.get(f.id);
      if (f.kind === 'trap' && !fs) continue;
      if (f.kind === 'door' && bld.map[f.y * z.width + f.x]! >= 0 && bld.list[bld.map[f.y * z.width + f.x]!]!.roofed) {
        const p0 = iso(f.x, f.y);
        const H = this.wallHeight();
        const depth = f.x + f.y + 0.2;
        list.push({
          depth,
          draw: () => {
            const s0 = this.worldToScreen(p0.x - 34, p0.y - H);
            this.hitRects.push({ id: f.id, kind: 'feature', x: s0.x, y: s0.y, w: 68 * this.zoom, h: (H + 20) * this.zoom, depth: depth + 1 });
          },
        });
        continue;
      }
      const p = iso(f.x, f.y);
      const spr = this.featureArt(f.kind, ts, fs) ?? featureSprite(f.kind, ts, { opened: fs?.opened, toggled: fs?.toggled, disarmed: fs?.disarmed || fs?.triggered, empty: fs?.empty, locked: !!f.lockLevel && !fs?.unlocked }, f.facing);
      const flat = f.kind === 'trap' || f.kind === 'waypoint' || f.kind === 'exit';
      const depth = f.x + f.y + (flat ? -0.4 : 0.06);
      const hovered = this.hover.featureId === f.id;
      // What can be used glows gold when you are near; spotted live traps glow red.
      const liveTrap = f.kind === 'trap' && !fs?.disarmed && !fs?.triggered;
      const usable = !liveTrap && USABLE.has(f.kind) && !(f.kind === 'chest' && fs?.opened && fs?.empty);
      const near = lp ? Math.hypot(lp.x - f.x, lp.y - f.y) : 99;
      list.push({
        depth,
        draw: () => {
          if (f.kind === 'exit' && f.facing) {
            // Rotate chevrons outward.
            ctx.save();
            ctx.translate(p.x, p.y);
            const ang = { n: -Math.PI * 0.75, e: -Math.PI * 0.25, s: Math.PI * 0.25, w: Math.PI * 0.75 }[f.facing];
            const sx = Math.cos(ang) * 1, sy = Math.sin(ang) * 0.5;
            ctx.transform(sy * 2, -sx, sx * 2, sy * 2, 0, 0);
            ctx.globalAlpha = 0.6 + Math.sin(this.t * 3) * 0.25;
            ctx.drawImage(spr.canvas, -spr.ax, -spr.ay);
            ctx.restore();
          } else {
            if (f.kind === 'waypoint') ctx.globalAlpha = 0.7 + Math.sin(this.t * 2) * 0.2;
            if (liveTrap) {
              // Spotted, live traps pulse with a warning outline so they read clearly against any floor.
              ctx.save();
              ctx.strokeStyle = `rgba(255,70,50,${0.55 + Math.sin(this.t * 4) * 0.35})`;
              ctx.lineWidth = 2;
              ctx.setLineDash([5, 4]);
              ctx.lineDashOffset = -this.t * 12;
              ctx.beginPath();
              ctx.moveTo(p.x - HW * 0.9, p.y);
              ctx.lineTo(p.x, p.y + HH * 0.9);
              ctx.lineTo(p.x + HW * 0.9, p.y);
              ctx.lineTo(p.x, p.y - HH * 0.9);
              ctx.closePath();
              ctx.stroke();
              ctx.restore();
            }
            ctx.drawImage(spr.canvas, p.x - spr.ax, p.y - spr.ay);
            ctx.globalAlpha = 1;
            const pulse = 0.5 + Math.sin(this.t * 3 + f.x * 0.7) * 0.5;
            if (liveTrap) drawOutline(ctx, spr.canvas, p.x - spr.ax, p.y - spr.ay, HIGHLIGHT.trap, hovered ? 1 : 0.55 + pulse * 0.4);
            else if (usable || hovered) {
              const proximity = near < 10 ? 1 - Math.max(0, near - 4) / 6 : 0;
              drawOutline(ctx, spr.canvas, p.x - spr.ax, p.y - spr.ay, HIGHLIGHT.use, hovered ? 1 : usable ? proximity * (0.35 + pulse * 0.35) : 0);
            }
          }
          const s = this.worldToScreen(p.x - spr.ax, p.y - spr.ay);
          this.hitRects.push({ id: f.id, kind: 'feature', x: s.x, y: s.y, w: spr.canvas.width * this.zoom, h: spr.canvas.height * this.zoom, depth });
        },
      });
    }
  }

  /** Painted pose frames of a generated character, once loaded (walk frames only count as a pair). */
  private poseFrames(key: string | undefined): PoseFrames | undefined {
    const w = this.client.state.world;
    if (!key || !w) return undefined;
    const frame = (v: string) => {
      const k = `${key}@${v}`;
      const img = loadImage(this.client.assetUrl(k));
      return img ? { img, rel: w.assets[k]?.relHeight ?? 1 } : undefined;
    };
    const out: PoseFrames = { walk_a: frame('walk_a'), walk_b: frame('walk_b'), attack: frame('attack') };
    return out.walk_a || out.attack ? out : undefined;
  }

  /** Generated art for a feature (chest closed or open, shrine, sign, lever, bed, crafting station), if painted. */
  private featureArt(kind: string, ts: TilesetDef, fs: { opened?: boolean; toggled?: boolean } | undefined): Sprite | null {
    const base = kind === 'craft_station' ? ts.extras?.craft?.asset : ['chest', 'shrine', 'sign', 'lever', 'bed'].includes(kind) ? ts.roles[kind as TileRole]?.asset : undefined;
    if (!base) return null;
    const key = kind === 'chest' && fs?.opened && this.client.assetUrl(`${base}@open`) ? `${base}@open` : base;
    const img = loadImage(this.client.assetUrl(key));
    if (!img) return null;
    const [mh, mw] = ART_SIZE[kind] ?? [56, 56];
    // A pulled lever is the same lever, mirrored.
    return imageSprite(img, key, mh, mw, kind === 'lever' && !!fs?.toggled);
  }

  private collectLoot(list: Drawable[]) {
    const ctx = this.ctx;
    const spr = lootSprite();
    for (const l of this.client.state.lootPiles) {
      const p = iso(l.x, l.y);
      const depth = l.x + l.y + 0.02;
      const hovered = this.hover.lootId === l.id;
      list.push({
        depth,
        draw: () => {
          const x = p.x - spr.width / 2, y = p.y - spr.height + 4;
          ctx.drawImage(spr, x, y);
          const pulse = 0.5 + Math.sin(this.t * 4 + l.x) * 0.5;
          drawOutline(ctx, spr, x, y, HIGHLIGHT.loot, hovered ? 1 : 0.45 + pulse * 0.45);
          const s = this.worldToScreen(p.x - 12, p.y - 18);
          this.hitRects.push({ id: l.id, kind: 'loot', x: s.x, y: s.y, w: 24 * this.zoom, h: 24 * this.zoom, depth });
        },
      });
    }
  }


  // ---------------------------------------------------------------------------- entities

  private anim(e: EntityView): Anim {
    let a = this.anims.get(e.id);
    if (!a) {
      a = { px: e.x, py: e.y, walk: 0, moving: false, amt: 0, dir: 1, face: e.facing, hurt: 0, attack: 0, death: 0, lastHp: e.hp, fade: 0 };
      this.anims.set(e.id, a);
    }
    return a;
  }

  private collectEntities(list: Drawable[], dt: number) {
    const st = this.client.state;
    const ctx = this.ctx;
    const ts = this.tileset()!;
    const combat = st.combat;
    const markers = st.player?.npcMarkers ?? {};
    for (const e of st.entities.values()) {
      const target = this.client.entityPos(e);
      const a = this.anim(e);
      const gap = Math.hypot(target.x - a.px, target.y - a.py);
      // Small discrepancies (a new path, server correction) are eased out; big ones (teleport, zone entry) snap.
      const k = gap > 2.5 ? 1 : 1 - Math.exp(-dt * (target.moving ? 18 : 12));
      const nx = a.px + (target.x - a.px) * k, ny = a.py + (target.y - a.py) * k;
      const moved = Math.hypot(nx - a.px, ny - a.py);
      a.px = nx;
      a.py = ny;
      a.moving = target.moving || moved > 0.004;
      a.amt = Math.max(0, Math.min(1, a.amt + (a.moving ? dt * 7 : -dt * 5)));
      // Stride length ~0.9 tiles per cycle; keep the phase running while easing out so legs settle.
      if (a.amt > 0) a.walk += (gap > 2.5 ? 0 : moved) * 7 + (a.moving ? 0 : dt * 2);
      // Turn smoothly toward the direction of travel.
      const dFace = Math.atan2(Math.sin(target.facing - a.face), Math.cos(target.facing - a.face));
      a.face += dFace * Math.min(1, dt * 14);
      const pos = { x: a.px, y: a.py, facing: a.face };
      a.hurt = Math.max(0, a.hurt - dt);
      a.attack = Math.max(0, a.attack - dt * 2.5);
      if (e.dead) a.death = Math.min(1, a.death + dt * 1.2);
      a.fade = Math.min(1, a.fade + dt * 3);
      const p = iso(pos.x, pos.y);
      // Screen-space facing from tile-space direction.
      const fx = Math.cos(pos.facing), fy = Math.sin(pos.facing);
      const sdx = fx - fy, sdy = (fx + fy) / 2;
      if (sdx < -0.3) a.dir = -1;
      else if (sdx > 0.3) a.dir = 1;
      const dir = a.dir;
      const back = sdy < -0.25;
      const depth = pos.x + pos.y + 0.1;
      const hovered = this.hover.entityId === e.id;
      const active = combat?.activeId === e.id;
      const isMine = e.ownerUserId === st.userId;
      const selected = isMine && st.selectedCharId === e.id;
      list.push({
        depth,
        draw: () => {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.globalAlpha = (1 - a.death * 0.85) * a.fade;
          // Ground rings
          if (active || selected || hovered || (e.hostile && combat && e.inCombat)) {
            ctx.save();
            ctx.scale(1, 0.5);
            ctx.lineWidth = active ? 3 : 2;
            ctx.strokeStyle = active ? `rgba(255,220,120,${0.7 + Math.sin(this.t * 5) * 0.25})` : e.hostile ? 'rgba(255,90,70,0.7)' : selected ? 'rgba(140,220,255,0.8)' : 'rgba(255,255,255,0.6)';
            ctx.beginPath();
            ctx.arc(0, 0, 20 * e.scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          drawShadow(ctx, 15 * e.scale);
          const img = loadImage(this.client.assetUrl(e.sprite));
          const height = 82 * e.scale * (e.kind === 'monster' ? 1 : 1);
          if (hovered) {
            ctx.shadowColor = e.hostile ? 'rgba(255,80,60,0.9)' : 'rgba(255,240,200,0.9)';
            ctx.shadowBlur = 12;
          }
          if (e.boss || e.elite) {
            const glow = e.boss ? kindColor(e.element, '#ff6040') : '#ffd060';
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const gr = ctx.createRadialGradient(0, -height * 0.45, 4, 0, -height * 0.45, height * 0.7);
            gr.addColorStop(0, glow + '40');
            gr.addColorStop(1, glow + '00');
            ctx.fillStyle = gr;
            ctx.fillRect(-height, -height * 1.2, height * 2, height * 1.5);
            ctx.restore();
          }
          const walk = a.amt > 0.02 ? a.walk : NaN;
          if (img) drawImageSprite(ctx, img, { height, dir, walk, amt: a.amt, t: this.t, downed: e.downed, hurt: a.hurt, attack: a.attack, frames: this.poseFrames(e.sprite) });
          else
            drawFigure(ctx, {
              shape: e.shape, colors: e.colors.length ? e.colors : this.defaultColors(e, ts), scale: e.scale * 1.15, dir, back, walk, t: this.t, weapon: e.weapon, archetype: e.archetype,
              seed: e.id, downed: e.downed, hurt: a.hurt, attack: a.attack, role: e.role, kind: e.kind, amt: a.amt, presentation: e.presentation,
            });
          ctx.shadowBlur = 0;
          // Status tint
          if (e.statuses.some((s) => s.id === 'frozen')) {
            ctx.fillStyle = 'rgba(160,220,255,0.35)';
            ctx.fillRect(-14, -height, 28, height);
          }
          ctx.restore();
          const top = this.worldToScreen(p.x, p.y - height - 6);
          const s0 = this.worldToScreen(p.x - 18 * e.scale, p.y - height);
          if (!e.dead) this.hitRects.push({ id: e.id, kind: 'entity', x: s0.x, y: s0.y, w: 36 * e.scale * this.zoom, h: (height + 6) * this.zoom, depth });
          this.labels.push({ e, x: top.x, y: top.y, hovered, marker: markers[e.id], inCombat: !!combat && !!e.inCombat });
        },
      });
    }
  }

  private defaultColors(e: EntityView, ts: TilesetDef): string[] {
    if (e.kind === 'character') return ['#4a6a9a', '#2a3448', '#e0c060'];
    if (e.kind === 'npc') return ['#7a6a5a', '#4a3a30', '#d0b080'];
    return ts.roles.rock.colors;
  }

  private labels: { e: EntityView; x: number; y: number; hovered: boolean; marker?: string; inCombat: boolean }[] = [];

  private drawOverlayLabels() {
    const ctx = this.ctx;
    this.setScreenTransform();
    const st = this.client.state;
    const zz = st.zone;
    for (const l of this.labels) {
      const e = l.e;
      if (e.dead) continue;
      if (zz && st.explored && !st.explored.get(Math.round(e.y) * zz.width + Math.round(e.x))) continue;
      const showBars = l.inCombat || l.hovered || (e.kind === 'monster' && e.hp < e.maxHp);
      let y = l.y;
      if (l.marker && !l.inCombat) {
        const sym = l.marker === 'quest' ? '!' : l.marker === 'turnin' ? '?' : '…';
        ctx.font = '700 22px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = l.marker === 'progress' ? '#c0c8d0' : '#ffd24a';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 4;
        const bob = Math.sin(this.t * 3) * 3;
        ctx.strokeText(sym, l.x, y - 6 + bob);
        ctx.fillText(sym, l.x, y - 6 + bob);
        y -= 22;
      }
      if (showBars) {
        const w = 54;
        const x0 = l.x - w / 2;
        let by = y - 4;
        const bar = (frac: number, color: string, h: number) => {
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(x0 - 1, by - 1, w + 2, h + 2);
          ctx.fillStyle = color;
          ctx.fillRect(x0, by, w * Math.max(0, Math.min(1, frac)), h);
          by -= h + 2;
        };
        bar(e.hp / Math.max(1, e.maxHp), e.hostile ? '#c8322a' : '#3fb34a', 5);
        if (e.barrier > 0) bar(e.barrier / Math.max(1, e.maxHp), '#9fd8ff', 3);
        y = by - 2;
      }
      if (l.hovered || (e.boss && l.inCombat)) {
        ctx.font = `600 ${e.boss ? 14 : 12}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        const name = `${e.name}${e.kind === 'monster' ? `  ·  ${this.client.state.world?.ruleset.terminology.level ?? 'Lv'} ${e.level}` : ''}`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(name, l.x, y - 4);
        ctx.fillStyle = e.hostile ? '#ff9a8a' : e.kind === 'npc' ? '#f0e0b0' : '#bfe4ff';
        ctx.fillText(name, l.x, y - 4);
        if (e.title && e.kind !== 'character') {
          ctx.font = 'italic 11px "EB Garamond", serif';
          ctx.strokeText(e.title, l.x, y - 18);
          ctx.fillStyle = '#d8ccb0';
          ctx.fillText(e.title, l.x, y - 18);
        }
        // Statuses
        e.statuses.slice(0, 6).forEach((s, i) => {
          ctx.fillStyle = kindColor(s.id, '#fff');
          ctx.beginPath();
          ctx.arc(l.x - 25 + i * 10, y + 4, 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      if (e.bark && e.bark.until > this.client.serverNow()) this.speechBubble(l.x, y - 22, e.bark.text);
    }
    this.labels = [];
    // Hovered feature label
    const z = st.zone;
    const f = this.hover.featureId ? z?.features.find((x) => x.id === this.hover.featureId) : undefined;
    if (f) {
      const name = this.featureLabel(f);
      if (name) {
        const s = this.tileToScreen(f.x, f.y, 52);
        ctx.font = '600 12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(name, s.x, s.y);
        ctx.fillStyle = '#ffe8b0';
        ctx.fillText(name, s.x, s.y);
      }
    }
  }

  private featureLabel(f: FeatureDef): string {
    const w = this.client.state.world;
    const fs = this.client.state.features.get(f.id);
    switch (f.kind) {
      case 'exit':
      case 'door':
        return f.name ?? 'Passage';
      case 'chest':
        return `${f.name ?? 'Chest'}${f.lockLevel && !fs?.unlocked ? ' (locked)' : fs?.empty ? ' (empty)' : ''}`;
      case 'trap':
        return `${(w && rx(w.ruleset).trap.get(f.trapKind ?? '')?.name) ?? f.name ?? 'Trap'}${fs?.disarmed ? ' (disarmed)' : fs?.triggered ? ' (sprung)' : ' — click to disarm'}`;
      default:
        return f.name ?? f.kind;
    }
  }

  private speechBubble(x: number, y: number, text: string) {
    const ctx = this.ctx;
    ctx.font = 'italic 14px "EB Garamond", serif';
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if (ctx.measureText(`${cur} ${w}`).width > 200 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) lines.push(cur);
    const w = Math.min(220, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18);
    const h = lines.length * 17 + 10;
    ctx.fillStyle = 'rgba(250,244,228,0.95)';
    ctx.strokeStyle = 'rgba(60,40,20,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h, w, h, 8);
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x, y + 7);
    ctx.lineTo(x + 6, y);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3a2a1a';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, x, y - h + 18 + i * 17));
  }

  // ---------------------------------------------------------------------------- surfaces & overlays

  private drawSurfaces() {
    const ctx = this.ctx;
    for (const s of this.client.state.surfaces) {
      const p = iso(s.x, s.y);
      const base = { fire: '#ff6a1a', poison: '#6ac02a', water: '#3a80e0', ice: '#cfefff', oil: '#3a2a1a', blessed: '#ffe680' }[s.type];
      ctx.save();
      ctx.beginPath();
      this.organicDiamond(ctx, s.x, s.y, 0.5, 0, 0);
      const flick = s.type === 'fire' ? 0.45 + Math.sin(this.t * 12 + s.x * 3) * 0.12 : s.type === 'blessed' ? 0.35 + Math.sin(this.t * 2) * 0.08 : 0.42;
      ctx.fillStyle = base + Math.round(flick * 255).toString(16).padStart(2, '0');
      ctx.fill();
      ctx.restore();
      if (s.type === 'fire' && Math.random() < 0.25) this.fx.spark(s.x + (Math.random() - 0.5) * 0.8, s.y + (Math.random() - 0.5) * 0.8, 0.1, Math.random() < 0.5 ? '#ffb040' : '#ff5a10', 0.7, 0.4, 3);
      if (s.type === 'poison' && Math.random() < 0.06) this.fx.spark(s.x, s.y, 0.05, '#9fe060', 0.8, 0.2, 2, false);
      void p;
    }
  }

  private passable(x: number, y: number, ignoreId?: string, ignoreEntities = false): boolean {
    const st = this.client.state;
    const z = st.zone!;
    if (x < 0 || y < 0 || x >= z.width || y >= z.height) return false;
    const i = y * z.width + x;
    const g = z.groundBytes[i]!;
    if (!(g === GROUND.floor || g === GROUND.floorAlt || g === GROUND.path)) return false;
    if (BLOCKING.has(z.objectBytes[i]!)) return false;
    for (const f of z.features) if (f.x === x && f.y === y && (SOLID_FEATURE.has(f.kind) || (f.kind === 'gate' && !st.features.get(f.id)?.toggled))) return false;
    if (!ignoreEntities) for (const e of st.entities.values()) if (e.id !== ignoreId && !e.dead && Math.round(e.x) === x && Math.round(e.y) === y && st.combat && e.inCombat) return false;
    return true;
  }

  private drawGroundOverlays() {
    const st = this.client.state;
    const ctx = this.ctx;
    const z = st.zone!;
    const combat = st.combat;
    const active = combat ? st.entities.get(combat.activeId) : undefined;
    const myTurn = this.client.isMyTurn() && active;
    const ch = active ? st.player?.party.find((c) => c.id === active.id) : undefined;
    const tgt = st.targeting;
    const diamond = (x: number, y: number, fill: string, stroke?: string) => {
      const p = iso(x, y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - HH + 1);
      ctx.lineTo(p.x + HW - 2, p.y);
      ctx.lineTo(p.x, p.y + HH - 1);
      ctx.lineTo(p.x - HW + 2, p.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    // Movement range during my turn.
    if (myTurn && ch && !tgt?.skillId && !tgt?.itemId) {
      const stats = this.client.charStats(ch);
      const order = combat!.order.find((o) => o.id === active!.id)!;
      const budget = order.movementLeft + order.ap * stats.move;
      const key = `${active!.x},${active!.y},${budget},${combat!.round}`;
      if (this.reach?.key !== key) {
        // Allies can be walked past (at a cost) but not stood on — same rule as the server.
        const ally = (x: number, y: number) => [...st.entities.values()].some((e) => e.id !== active!.id && !e.dead && e.inCombat && !e.hostile && Math.round(e.x) === x && Math.round(e.y) === y);
        const map = reachable(active!, budget, { width: z.width, height: z.height, passable: (x, y) => this.passable(x, y, active!.id) || (ally(x, y) && this.passable(x, y, active!.id, true)), extraCost: (x, y) => (ally(x, y) ? ALLY_PASS_COST : 0) });
        for (const k of [...map.keys()]) if (!this.passable(k % z.width, Math.floor(k / z.width), active!.id)) map.delete(k);
        this.reach = { key, map };
      }
      const reach = this.reach.map;
      const apOf = (cost: number) => (cost <= order.movementLeft ? 0 : Math.ceil((cost - order.movementLeft) / stats.move));
      for (const [idx, cost] of reach) {
        const x = idx % z.width, y = Math.floor(idx / z.width);
        const apNeeded = apOf(cost);
        diamond(x, y, `rgba(40,140,230,${Math.max(0.07, 0.2 - apNeeded * 0.03)})`);
      }
      // Outline the edge of the reachable area, and the edge of each AP band.
      ctx.save();
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const edge = (ax: number, ay: number, bx: number, by: number) => {
        const a = iso(ax, ay), b = iso(bx, by);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      };
      for (const [idx, cost] of reach) {
        const x = idx % z.width, y = Math.floor(idx / z.width);
        const band = apOf(cost);
        const out = (nx: number, ny: number) => {
          const c2 = reach.get(ny * z.width + nx);
          return c2 === undefined || apOf(c2) > band;
        };
        if (out(x, y - 1)) edge(x - 0.5, y - 0.5, x + 0.5, y - 0.5);
        if (out(x + 1, y)) edge(x + 0.5, y - 0.5, x + 0.5, y + 0.5);
        if (out(x, y + 1)) edge(x + 0.5, y + 0.5, x - 0.5, y + 0.5);
        if (out(x - 1, y)) edge(x - 0.5, y + 0.5, x - 0.5, y - 0.5);
      }
      ctx.strokeStyle = 'rgba(140,220,255,0.75)';
      ctx.shadowColor = 'rgba(60,160,255,0.9)';
      ctx.shadowBlur = 4;
      ctx.stroke();
      ctx.restore();
      // Path preview to hovered tile.
      const h = this.hover.tile;
      if (h && !this.hover.entityId && this.passable(h.x, h.y, active!.id)) {
        const allyAt = (x: number, y: number) => [...st.entities.values()].some((e) => e.id !== active!.id && !e.dead && e.inCombat && !e.hostile && Math.round(e.x) === x && Math.round(e.y) === y);
        const path = this.passable(h.x, h.y, active!.id) ? findPath(active!, h, { width: z.width, height: z.height, passable: (x, y) => this.passable(x, y, active!.id) || (allyAt(x, y) && this.passable(x, y, active!.id, true)), extraCost: (x, y) => (allyAt(x, y) ? ALLY_PASS_COST : 0), maxNodes: 4000 }) : null;
        if (path && path.length) {
          let len = 0;
          let px = active!.x, py = active!.y;
          ctx.strokeStyle = 'rgba(255,240,180,0.9)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          const s0 = iso(px, py);
          ctx.moveTo(s0.x, s0.y);
          for (const t of path) {
            len += Math.hypot(t.x - px, t.y - py) + (allyAt(t.x, t.y) ? ALLY_PASS_COST : 0);
            px = t.x;
            py = t.y;
            const s = iso(t.x, t.y);
            ctx.lineTo(s.x, s.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          const cost = len <= order.movementLeft ? 0 : Math.ceil((len - order.movementLeft) / stats.move);
          const ok = cost <= order.ap;
          diamond(h.x, h.y, ok ? 'rgba(255,230,140,0.35)' : 'rgba(255,80,60,0.35)', ok ? 'rgba(255,230,140,0.9)' : 'rgba(255,80,60,0.9)');
          this.cursorNote = { text: ok ? `${cost} ${st.world?.ruleset.terminology.actionPoints ?? 'AP'}` : 'Too far', ok };
        }
      }
    }
    // Skill / item targeting.
    if (tgt && (tgt.skillId || tgt.itemId)) {
      const user = st.entities.get(tgt.charId);
      const skill = tgt.skillId && st.world ? rx(st.world.ruleset).skill.get(tgt.skillId) : undefined;
      const chr = st.player?.party.find((c) => c.id === tgt.charId);
      if (user && chr) {
        const stats = this.client.charStats(chr);
        const item = tgt.itemId ? st.player?.inventory.find((i) => i.id === tgt.itemId) : undefined;
        const use = item && st.world ? rx(st.world.ruleset).item.get(item.baseId)?.use : undefined;
        const range = skill ? skillRange(skill, stats) : use?.targeting === 'ground' ? 8 : use?.targeting === 'ally' ? 6 : 1.6;
        const radius = skill?.radius ?? use?.radius ?? 0;
        const up = this.client.entityPos(user);
        // Range ring
        if (range > 0) {
          const c = iso(up.x, up.y);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.scale(1, 0.5);
          ctx.strokeStyle = 'rgba(255,230,150,0.55)';
          ctx.setLineDash([6, 6]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, range * HW * Math.SQRT2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          ctx.setLineDash([]);
        }
        const h = this.hover.tile;
        const center = skill?.targeting === 'self' ? up : h;
        if (center) {
          const inRange = Math.hypot(center.x - up.x, center.y - up.y) <= range + 0.01 || skill?.targeting === 'self';
          const los = range <= 2 || hasLineOfSight(up, center, (x, y) => {
            const g = z.groundBytes[y * z.width + x];
            const o = z.objectBytes[y * z.width + x];
            return g === GROUND.wall || g === GROUND.void || o === OBJ.tree || o === OBJ.pillar;
          });
          const color = inRange && los ? '255,220,120' : '255,80,60';
          if (radius) {
            for (let y = Math.floor(center.y - radius); y <= Math.ceil(center.y + radius); y++)
              for (let x = Math.floor(center.x - radius); x <= Math.ceil(center.x + radius); x++)
                if (Math.hypot(x - center.x, y - center.y) <= radius + 0.01) diamond(x, y, `rgba(${color},0.22)`);
          } else if (h) diamond(h.x, h.y, `rgba(${color},0.3)`, `rgba(${color},0.9)`);
          this.cursorNote = inRange ? (los ? null : { text: 'No line of sight', ok: false }) : { text: 'Out of range', ok: false };
        }
      }
    }
  }

  cursorNote: { text: string; ok: boolean } | null = null;
  private warned = false;

  // ---------------------------------------------------------------------------- fx

  private onFx(events: FxEvent[]) {
    const st = this.client.state;
    const posOf = (id?: string) => {
      const e = id ? st.entities.get(id) : undefined;
      return e ? this.client.entityPos(e) : null;
    };
    for (const ev of events) {
      const tp = posOf(ev.targetId) ?? (ev.x !== undefined ? { x: ev.x, y: ev.y! } : null);
      switch (ev.kind) {
        case 'damage': {
          if (!tp || !ev.damage) break;
          this.fx.damage(tp.x, tp.y, ev.damage.amount, ev.damage.type, ev.damage.crit);
          if (ev.damage.type !== 'heal' && !ev.damage.type.startsWith('armor')) {
            const a = ev.targetId ? this.anims.get(ev.targetId) : undefined;
            if (a) a.hurt = 0.3;
            this.fx.burst(tp.x, tp.y, kindColor(ev.damage.type), ev.damage.crit ? 16 : 8, 1.8, 1);
          }
          break;
        }
        case 'text':
          if (tp) this.fx.text(tp.x, tp.y, ev.text ?? '', ev.color ?? '#ffffff');
          break;
        case 'projectile': {
          const sp = posOf(ev.sourceId) ?? { x: ev.x ?? 0, y: ev.y ?? 0 };
          const to = posOf(ev.targetId) ?? { x: ev.tx ?? sp.x, y: ev.ty ?? sp.y };
          const color = kindColor(ev.element);
          const a = ev.sourceId ? this.anims.get(ev.sourceId) : undefined;
          if (a) a.attack = 1;
          const kind = ev.fx === 'arrow' ? 'arrow' : ev.fx === 'beam' ? 'beam' : 'bolt';
          this.fx.projectile(sp.x, sp.y, to.x, to.y, color, kind, () => {
            this.fx.burst(to.x, to.y, color, ev.radius ? 30 : 12, ev.radius ? 3.5 : 2);
            if (ev.radius) this.fx.ring(to.x, to.y, ev.radius, color);
          });
          break;
        }
        case 'skill': {
          const sp = posOf(ev.sourceId) ?? { x: ev.x ?? 0, y: ev.y ?? 0 };
          const center = { x: ev.tx ?? sp.x, y: ev.ty ?? sp.y };
          const color = kindColor(ev.element);
          const a = ev.sourceId ? this.anims.get(ev.sourceId) : undefined;
          if (a) a.attack = 1;
          if (ev.fx === 'heal') this.fx.rise(center.x, center.y, '#8dffb0', ev.radius ? 30 : 16);
          else if (ev.fx === 'buff') this.fx.rise(center.x, center.y, '#ffd880', 14);
          else if (ev.fx === 'debuff') this.fx.rise(center.x, center.y, '#d080ff', 12);
          else if (ev.fx === 'nova') {
            this.fx.ring(center.x, center.y, ev.radius ?? 2, color);
            this.fx.burst(center.x, center.y, color, 30, 3.5, 0.5);
          } else if (ev.fx === 'shadow') this.fx.smoke(center.x, center.y, 'rgba(60,40,80,0.55)', 12);
          else if (ev.fx === 'cloud') this.fx.smoke(center.x, center.y, ev.element === 'poison' ? 'rgba(110,190,60,0.4)' : 'rgba(120,160,220,0.4)', 18);
          else if (ev.fx === 'slash' && ev.targetId) {
            const t = posOf(ev.targetId);
            if (t) this.fx.burst(t.x, t.y, '#f0f0ff', 6, 1.4, 1);
          }
          break;
        }
        case 'death':
          if (tp) this.fx.smoke(tp.x, tp.y, 'rgba(40,30,30,0.5)', 14);
          break;
        case 'levelup':
          if (tp) {
            this.fx.rise(tp.x, tp.y, '#ffe080', 40);
            this.fx.text(tp.x, tp.y, ev.text ?? 'Level up!', '#ffe080', true);
          }
          break;
        case 'trap': {
          const p = { x: ev.x ?? 0, y: ev.y ?? 0 };
          const color = kindColor(ev.element);
          this.fx.burst(p.x, p.y, color, 26, 3);
          if (ev.radius) this.fx.ring(p.x, p.y, ev.radius, color);
          this.fx.text(p.x, p.y, ev.text ?? 'Trap!', '#ff9070', true);
          break;
        }
      }
    }
  }

  private drawFx() {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.fx.particles) {
      if (p.kind === 'text') continue;
      const s = iso(p.x, p.y);
      const k = Math.max(0, p.life / p.max);
      if (p.kind === 'ring') {
        const r = (1 - k) * (p.r ?? 1) * HW * Math.SQRT2 + 6;
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.scale(1, 0.5);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = k;
        ctx.lineWidth = 4 * k + 1;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (p.kind === 'smoke') {
        ctx.globalAlpha = k * 0.8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y - p.z * 32, p.size * (1.6 - k * 0.6), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.globalCompositeOperation = p.glow ? 'lighter' : 'source-over';
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y - p.z * 32, p.size * (0.5 + k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const pr of this.fx.projectiles) {
      const f = Math.min(1, pr.t / pr.dur);
      if (pr.kind === 'beam') {
        const a = iso(pr.x0, pr.y0), b = iso(pr.x1, pr.y1);
        ctx.globalAlpha = 1 - Math.max(0, pr.t - pr.dur) / 0.18;
        ctx.strokeStyle = pr.color;
        ctx.shadowColor = pr.color;
        ctx.shadowBlur = 16;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 40);
        const steps = 6;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = a.x + (b.x - a.x) * t + (i < steps ? (Math.random() - 0.5) * 14 : 0);
          const y = a.y - 40 + (b.y - a.y + 10) * t + (i < steps ? (Math.random() - 0.5) * 14 : 0);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        continue;
      }
      const x = pr.x0 + (pr.x1 - pr.x0) * f, y = pr.y0 + (pr.y1 - pr.y0) * f;
      const z = 1.2 + Math.sin(f * Math.PI) * pr.arc;
      const s = iso(x, y);
      ctx.globalAlpha = 1;
      if (pr.kind === 'arrow') {
        const a = iso(pr.x0, pr.y0), b = iso(pr.x1, pr.y1);
        const ang = Math.atan2(b.y - a.y - Math.cos(f * Math.PI) * pr.arc * 32, b.x - a.x);
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#e8e0d0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.x - Math.cos(ang) * 10, s.y - z * 32 - Math.sin(ang) * 10);
        ctx.lineTo(s.x + Math.cos(ang) * 6, s.y - z * 32 + Math.sin(ang) * 6);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
      } else {
        const g = ctx.createRadialGradient(s.x, s.y - z * 32, 0, s.x, s.y - z * 32, 12);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.3, pr.color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y - z * 32, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawTexts() {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const p of this.fx.particles) {
      if (p.kind !== 'text') continue;
      const s = iso(p.x, p.y);
      const k = p.life / p.max;
      ctx.globalAlpha = Math.min(1, k * 2.2);
      ctx.font = p.font ?? '700 15px Inter';
      const y = s.y - p.z * 32;
      const pop = k > 0.85 ? 1 + (k - 0.85) * 2 : 1;
      ctx.save();
      ctx.translate(s.x, y);
      ctx.scale(pop / this.zoom, pop / this.zoom);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(p.text ?? '', 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text ?? '', 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------- lighting & fog

  private drawLighting(minX: number, maxX: number, minY: number, maxY: number) {
    const { darkness, tint } = this.daylight();
    if (darkness < 0.02) return;
    const st = this.client.state;
    const z = st.zone!;
    const lc = this.lightCanvas;
    const l = lc.getContext('2d')!;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, lc.width, lc.height);
    l.fillStyle = rgb(tint, darkness);
    l.fillRect(0, 0, lc.width, lc.height);
    l.globalCompositeOperation = 'destination-out';
    const hole = (x: number, y: number, rTiles: number, strength = 1, flicker = 0) => {
      const s = this.tileToScreen(x, y, 20);
      const r = rTiles * HW * this.zoom * (1 + flicker);
      const g = l.createRadialGradient(s.x / 2, s.y / 2, 0, s.x / 2, s.y / 2, r / 2);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.6})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.fillRect(s.x / 2 - r / 2, s.y / 2 - r / 2, r, r);
    };
    const glows: { x: number; y: number; r: number; color: string }[] = [];
    for (const e of st.entities.values()) {
      if (e.ownerUserId === st.userId) {
        const p = this.client.entityPos(e);
        hole(p.x, p.y, 7.5, 1);
      } else if (e.boss) {
        const p = this.client.entityPos(e);
        hole(p.x, p.y, 3, 0.6);
      }
    }
    const W = z.width;
    const ts = this.tileset()!;
    const lightColor = ts.lightColor ?? '#ffc070';
    for (let y = Math.max(0, minY - 4); y <= Math.min(z.height - 1, maxY + 4); y++)
      for (let x = Math.max(0, minX - 4); x <= Math.min(z.width - 1, maxX + 4); x++) {
        if (z.objectBytes[y * W + x] === OBJ.light) {
          const fl = Math.sin(this.t * 9 + x * 3 + y) * 0.04;
          hole(x, y, 5, 0.95, fl);
          glows.push({ x, y, r: 2.6 + fl * 10, color: lightColor });
        }
      }
    for (const f of z.features) {
      if (f.kind === 'shrine' || f.kind === 'waypoint' || (f.kind === 'lore' && !st.features.get(f.id)?.opened) || (f.kind === 'exit' && !f.facing)) {
        hole(f.x, f.y, f.kind === 'lore' ? 1.6 : 3, 0.7);
        glows.push({ x: f.x, y: f.y, r: 1.4, color: f.kind === 'shrine' ? (ts.roles.shrine.colors[1] ?? '#80e0ff') : f.kind === 'lore' ? '#ffe090' : '#a0d8ff' });
      }
    }
    for (const s of st.surfaces) if (s.type === 'fire') {
      hole(s.x, s.y, 2.2, 0.8);
      glows.push({ x: s.x, y: s.y, r: 1, color: '#ff7a20' });
    }
    for (const p of this.fx.particles) if (p.glow && p.size > 2.5) hole(p.x, p.y, 0.7, 0.35);
    for (const pr of this.fx.projectiles) {
      const f = Math.min(1, pr.t / pr.dur);
      hole(pr.x0 + (pr.x1 - pr.x0) * f, pr.y0 + (pr.y1 - pr.y0) * f, 2.5, 0.8);
    }
    this.setScreenTransform();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lc, 0, 0, this.W, this.H);
    // Warm additive glows
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const g of glows) {
      const s = this.tileToScreen(g.x, g.y, 30);
      const r = g.r * HW * this.zoom;
      const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      gr.addColorStop(0, g.color + '55');
      gr.addColorStop(1, g.color + '00');
      ctx.fillStyle = gr;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  private fogMap: { key: string; canvas: HTMLCanvasElement; img: ImageData } | null = null;

  /**
   * Fog of war: one alpha value per tile, written into a tiny map-sized image and drawn with an isometric
   * transform and bilinear smoothing, so the fog is a continuous gradient with no overlapping tile seams.
   */
  private drawFog(minX: number, maxX: number, minY: number, maxY: number) {
    const st = this.client.state;
    const z = st.zone!;
    if (!st.explored) return;
    const key = `${z.id}:${z.width}x${z.height}`;
    if (this.fogMap?.key !== key) {
      const canvas = document.createElement('canvas');
      canvas.width = z.width;
      canvas.height = z.height;
      this.fogMap = { key, canvas, img: canvas.getContext('2d')!.createImageData(z.width, z.height) };
    }
    const { canvas, img } = this.fogMap;
    const data = img.data;
    const party = [...st.entities.values()].filter((e) => e.ownerUserId === st.userId).map((e) => this.client.entityPos(e));
    const W = z.width;
    const x0 = Math.max(0, minX - 3), x1 = Math.min(z.width - 1, maxX + 3);
    const y0 = Math.max(0, minY - 3), y1 = Math.min(z.height - 1, maxY + 3);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        let alpha: number;
        if (!st.explored.get(y * W + x)) alpha = 1;
        else {
          let d = 99;
          for (const p of party) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
          // Remembered-but-unseen ground dims smoothly with distance from the party.
          alpha = d > 13 ? 0.45 : d > 8 ? ((d - 8) / 5) ** 1.5 * 0.45 : 0;
        }
        data[(y * W + x) * 4 + 3] = Math.round(alpha * 255);
      }
    canvas.getContext('2d')!.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    const fc = this.fogCanvas;
    const f = fc.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, fc.width, fc.height);
    const sc = fc.width / this.W;
    const o = this.tileToScreen(0, 0);
    const k = this.zoom * sc;
    // Tile (x,y) maps to screen ((x−y)·HW, (x+y)·HH); pixel corners sit half a tile before the centres.
    f.setTransform(HW * k, HH * k, -HW * k, HH * k, o.x * sc, o.y * sc);
    f.imageSmoothingEnabled = true;
    f.imageSmoothingQuality = 'high';
    f.drawImage(canvas, -0.5, -0.5);
    f.setTransform(1, 0, 0, 1, 0, 0);
    this.setScreenTransform();
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(fc, 0, 0, this.W, this.H);
    void this.exploredDirtyAt;
  }

  private drawWeather(dt: number, ts: TilesetDef) {
    const kind = ts.weather ?? 'none';
    // No rain or snow under a roof (dust, ash, spores and embers can drift indoors).
    if (kind === 'none' || (!ts.outdoor && (kind === 'rain' || kind === 'snow'))) return;
    const ctx = this.ctx;
    this.setScreenTransform();
    const target = kind === 'rain' ? 160 : kind === 'snow' ? 120 : kind === 'fireflies' ? 26 : 50;
    while (this.weather.length < target) this.weather.push({ x: Math.random() * this.W, y: Math.random() * this.H, z: Math.random(), s: Math.random(), p: Math.random() * 10 });
    const night = this.daylight().darkness;
    for (const d of this.weather) {
      d.p += dt;
      switch (kind) {
        case 'rain':
          d.y += dt * (600 + d.s * 300);
          d.x -= dt * 120;
          ctx.strokeStyle = `rgba(190,210,255,${0.25 + d.s * 0.25})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - 4, d.y + 14);
          ctx.stroke();
          break;
        case 'snow':
          d.y += dt * (30 + d.s * 40);
          d.x += Math.sin(d.p + d.s * 6) * dt * 20;
          ctx.fillStyle = `rgba(255,255,255,${0.5 + d.s * 0.4})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1 + d.s * 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'fireflies': {
          d.x += Math.sin(d.p * 0.7 + d.s * 9) * dt * 18;
          d.y += Math.cos(d.p * 0.5 + d.s * 7) * dt * 14;
          const a = (0.25 + Math.sin(d.p * 2.5 + d.s * 10) * 0.25 + 0.25) * (0.3 + night);
          const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, 6);
          g.addColorStop(0, `rgba(220,255,140,${a})`);
          g.addColorStop(1, 'rgba(220,255,140,0)');
          ctx.fillStyle = g;
          ctx.fillRect(d.x - 6, d.y - 6, 12, 12);
          break;
        }
        case 'embers':
          d.y -= dt * (30 + d.s * 50);
          d.x += Math.sin(d.p + d.s * 5) * dt * 15;
          ctx.fillStyle = `rgba(255,${120 + d.s * 80},40,${0.5 + Math.sin(d.p * 4) * 0.3})`;
          ctx.fillRect(d.x, d.y, 2, 2);
          break;
        default: {
          // dust, ash, spores
          d.y += dt * (kind === 'ash' ? 20 : 6) * (0.5 + d.s);
          d.x += Math.sin(d.p * 0.4 + d.s * 8) * dt * 8;
          const c = kind === 'spores' ? '180,255,200' : kind === 'ash' ? '200,200,200' : '255,240,210';
          ctx.fillStyle = `rgba(${c},${0.15 + d.s * 0.25})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 0.8 + d.s * 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (d.y > this.H + 20) { d.y = -10; d.x = Math.random() * this.W; }
      if (d.y < -20) { d.y = this.H + 10; d.x = Math.random() * this.W; }
      if (d.x < -20) d.x = this.W + 10;
      if (d.x > this.W + 20) d.x = -10;
    }
  }

  /** Re-render static caches (e.g. after art arrives). */
  invalidate() {
    this.chunks.clear();
    this.wallCache.clear();
    this.textures.clear();
  }
}


interface Building {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  alongX: boolean;
  roofed: boolean;
}
