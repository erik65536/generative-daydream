/**
 * The game view and its mouse input. The place's painting is the ground; everything that moves is drawn over it in
 * depth order (lit like the place, see light.ts), then the place's mist (fog of war and the painting's edge, see
 * mist.ts: what lies past the edge is drawn with the ground), light, weather, and the combat and targeting overlays. Positions are ground metres:
 * the painting is the same isometric projection of that ground (a metre runs ISO_X pixels across and ISO_Y down).
 */
import {
  BODY, ISO_X, ISO_Y, NAV_CELL, PX_PER_METRE_UP, SPACING, clipKey, fogSize, rx, skillRange, squeezeCost, walkAmong, walkCost,
  type ActorAnim, type ClipName, type EntityView, type FeatureDef, type FxEvent, type Vec2,
} from '@gd/shared';
import type { GameClient, ZoneData } from '../net/game';
import { hexToRgb, mix, rgb, type RGB } from './color';
import { drawFigure, drawImageSprite, loadImage } from './sprites';
import { advance, cellBounds, drawCell, frameOf, newMotion, playOnce, rowOf, type Motion } from './actors';
import { PlaceLight, type FigureLight } from './light';
import { Mist, type MistFrame } from './mist';
import { FxSystem } from './fx';
import { HIGHLIGHT, drawOutline } from './highlight';
import { kindColor } from '../rules';

const HW = ISO_X;
const HH = ISO_Y;
const iso = (x: number, y: number) => ({ x: (x - y) * HW, y: (x + y) * HH });

/** Objects the game draws over every painting (one look per world), and how tall they stand in metres. */
const OBJECT_ART: Record<string, { key: string; height: number }> = {
  chest: { key: 'obj_chest', height: 0.85 },
  sign: { key: 'obj_sign', height: 1.7 },
  waypoint: { key: 'obj_waypoint', height: 2.1 },
};
/** Features one uses (they glow when near). Doors and ways out light up on hover. */
const USABLE = new Set(['chest', 'sign', 'lore', 'bed', 'craft_station', 'waypoint', 'object']);

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

const sized = new Map<string, HTMLCanvasElement>();
/** An image scaled to `h` pixels tall, as a canvas (for outlines), cached. */
function sizedSprite(img: HTMLImageElement, key: string, h: number): HTMLCanvasElement {
  const k = `${key}:${Math.round(h)}`;
  let c = sized.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.height = Math.round(h);
  c.width = Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * h));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  sized.set(k, c);
  return c;
}

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
  /** The animated actor's clip and timing (actors with clip sheets). */
  motion: Motion;
}

interface Drawable {
  depth: number;
  draw: () => void;
}

export interface HoverInfo {
  /** The ground point under the cursor (metres), when it is on the place. */
  point: Vec2 | null;
  entityId?: string;
  featureId?: string;
  lootId?: string;
  screenX: number;
  screenY: number;
}

/** Line segments (metres) tracing where `inside` changes over a grid of half-metre cells (marching squares). */
function contour(cols: number, rows: number, inside: (cx: number, cy: number) => boolean): number[] {
  const out: number[] = [];
  const v = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < cols && cy < rows && inside(cx, cy) ? 1 : 0);
  // Corners are cell centres; edges cut halfway between them.
  const c = (cx: number) => (cx + 0.5) * NAV_CELL;
  for (let cy = -1; cy < rows; cy++)
    for (let cx = -1; cx < cols; cx++) {
      const a = v(cx, cy), b = v(cx + 1, cy), d = v(cx, cy + 1), e = v(cx + 1, cy + 1);
      const k = a | (b << 1) | (e << 2) | (d << 3);
      if (k === 0 || k === 15) continue;
      const x0 = c(cx), x1 = c(cx + 1), y0 = c(cy), y1 = c(cy + 1), xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
      const top = [xm, y0], right = [x1, ym], bottom = [xm, y1], left = [x0, ym];
      const seg = (p: number[], q: number[]) => out.push(p[0]!, p[1]!, q[0]!, q[1]!);
      switch (k) {
        case 1: case 14: seg(left, top); break;
        case 2: case 13: seg(top, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(right, bottom); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(left, bottom); break;
        case 5: seg(left, top); seg(right, bottom); break;
        case 10: seg(top, right); seg(left, bottom); break;
      }
    }
  return out;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private W = 0;
  private H = 0;
  camX = 0;
  camY = 0;
  zoom = 1;
  private camInit = false;
  private zoneKey = '';
  private lightCanvas = document.createElement('canvas');
  private fogCanvas = document.createElement('canvas');
  private mist = new Mist();
  private light = new PlaceLight();
  /** Where a figure is drawn, and then lit, before it goes onto the view. */
  private scratch = [document.createElement('canvas'), document.createElement('canvas')] as const;
  private anims = new Map<string, Anim>();
  readonly fx = new FxSystem();
  hover: HoverInfo = { point: null, screenX: 0, screenY: 0 };
  private hitRects: { id: string; kind: 'entity' | 'feature' | 'loot'; x: number; y: number; w: number; h: number; depth: number }[] = [];
  private raf = 0;
  private last = performance.now();
  private t = 0;
  private reach: { key: string; cells: Map<number, number>; lines: number[][] } | null = null;
  private weather: { x: number; y: number; z: number; s: number; p: number }[] = [];
  private lastExplore = '';
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

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.render(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  // ---------------------------------------------------------------------------- coordinates

  private worldToScreen(wx: number, wy: number) {
    const c = iso(this.camX, this.camY);
    return { x: (wx - c.x) * this.zoom + this.W / 2, y: (wy - c.y) * this.zoom + this.H / 2 };
  }

  /** Ground metres (and `z` pixels up) to screen pixels. */
  groundToScreen(x: number, y: number, z = 0) {
    const p = iso(x, y);
    return this.worldToScreen(p.x, p.y - z);
  }

  screenToGround(sx: number, sy: number): Vec2 {
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

  /**
   * Controller walking: the stick's direction (ground space) while held. The leader is then moved here every
   * frame (client-side prediction) and only eased toward the server's position, so its path renewals never show.
   */
  steer: Vec2 | null = null;
  private predicted: Vec2 | null = null;
  /** After the stick is let go: hold the leader where they stopped until the server agrees. */
  private holdUntil = 0;
  private predictedZone: string | undefined;

  /** Where this screen has the steered leader (sent to the server, which takes it). */
  predictedPos(): Vec2 | null {
    return this.predicted ? { ...this.predicted } : null;
  }

  /** Hover set by a controller (a ground cursor or a focused target). Moving the mouse takes over again. */
  padHover: HoverInfo | null = null;

  setPadHover(info: HoverInfo | null) {
    this.padHover = info;
    if (info) this.hover = info;
    else this.hover = { point: null, screenX: this.hover.screenX, screenY: this.hover.screenY };
  }

  /** What a controller cursor at this ground point points at. */
  hoverAt(p: Vec2, ids: { entityId?: string; featureId?: string; lootId?: string } = {}): HoverInfo {
    const s = this.groundToScreen(p.x, p.y);
    return { point: { x: p.x, y: p.y }, screenX: s.x, screenY: s.y, ...ids };
  }

  /** A screen-space direction (stick) as a unit direction on the ground. */
  screenDirToGround(dx: number, dy: number): Vec2 {
    const a = this.screenToGround(this.W / 2, this.H / 2), b = this.screenToGround(this.W / 2 + dx * 100, this.H / 2 + dy * 100);
    const vx = b.x - a.x, vy = b.y - a.y, len = Math.hypot(vx, vy) || 1;
    return { x: vx / len, y: vy / len };
  }

  canStand(x: number, y: number): boolean {
    return !!this.client.state.zone?.walk.walkable(x, y);
  }

  /** Developer option: zoom far out to see a whole place. */
  devZoom = false;
  /** Developer option: show where people can walk (green) and see through (blue). */
  showWalk = false;
  /**
   * Keep the view inside the painting: a place smaller than the screen sits centred with mist around it. Off by
   * default (the developer panel switches it, remembered in this browser) until it is decided how it should feel.
   */
  clampCamera = (() => {
    try {
      return localStorage.getItem('gd.clampCamera') === '1';
    } catch {
      return false;
    }
  })();

  setClampCamera(on: boolean) {
    this.clampCamera = on;
    try {
      localStorage.setItem('gd.clampCamera', on ? '1' : '0');
    } catch {
      /* not remembered */
    }
  }

  /** Where the camera may look to show ground point `g`: kept inside the painting when clamping. */
  private framed(z: ZoneData, g: Vec2): Vec2 {
    if (!this.clampCamera || !z.painting) return g;
    const c = iso(g.x, g.y), P = z.painting;
    const fit = (v: number, lo: number, hi: number, half: number) => (hi - lo <= half * 2 ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v)));
    const cx = fit(c.x, -P.ox, P.width - P.ox, this.W / 2 / this.zoom), cy = fit(c.y, -P.oy, P.height - P.oy, this.H / 2 / this.zoom);
    return { x: (cy / HH + cx / HW) / 2, y: (cy / HH - cx / HW) / 2 };
  }

  private get minZoom() {
    return this.devZoom ? 0.12 : 0.55;
  }

  zoomBy(f: number) {
    this.zoom = Math.max(this.minZoom, Math.min(1.9, this.zoom * f));
  }

  private onMove = (e: MouseEvent) => {
    if (this.padHover) {
      this.padHover = null;
      this.client.update({ inputMode: 'mouse' });
    }
    const r = this.canvas.getBoundingClientRect();
    this.hover = this.pick(e.clientX - r.left, e.clientY - r.top);
  };

  private onDown = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.onClick?.(this.pick(e.clientX - r.left, e.clientY - r.top), e.button, e);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
  };

  private pick(sx: number, sy: number): HoverInfo {
    const p = this.screenToGround(sx, sy);
    const z = this.client.state.zone;
    const inside = !!z && p.x >= 0 && p.y >= 0 && p.x < z.width && p.y < z.height;
    const info: HoverInfo = { point: inside ? p : null, screenX: sx, screenY: sy };
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
    }
    return info;
  }

  // ---------------------------------------------------------------------------- frame

  private enteredZone(z: ZoneData) {
    const key = `${z.id}:${this.client.state.world?.id}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    this.anims.clear();
    this.camInit = false;
    this.weather = [];
    this.reach = null;
    this.fogBytes = null;
  }

  /** The place's painting, once loaded. */
  private painting(z: ZoneData): HTMLImageElement | null {
    return z.painting ? loadImage(this.client.assetUrl(z.painting.image)) : null;
  }

  private render(dt: number) {
    const st = this.client.state;
    const ctx = this.ctx;
    this.setScreenTransform();
    const z = st.zone;
    ctx.fillStyle = '#07060a';
    ctx.fillRect(0, 0, this.W, this.H);
    if (!z) return;
    this.enteredZone(z);
    this.fx.update(dt);
    // The camera follows the leader.
    const leader = this.client.leaderEntity();
    if (leader) {
      const lp = this.client.entityPos(leader);
      const k = this.camInit ? Math.min(1, dt * 6) : 1;
      const look = this.framed(z, lp);
      this.camX += (look.x - this.camX) * k;
      this.camY += (look.y - this.camY) * k;
      this.camInit = true;
      this.updateExplored(z, lp);
    }
    // 1. The ground: the place's painting (darkness until it has loaded).
    const img = this.painting(z);
    if (!img || !z.painting) return;
    this.setWorldTransform();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -z.painting.ox, -z.painting.oy, z.painting.width, z.painting.height);
    this.light.update(`${this.zoneKey}:${z.painting.image}`, z.look, img, -z.painting.ox, -z.painting.oy);
    this.drawMist(z, 'ground');
    if (this.showWalk) this.drawWalkable(z);
    // 2. On the ground: surfaces, then combat and targeting overlays.
    this.drawSurfaces();
    this.drawGroundOverlays(z);
    // 3. Everything standing, nearest the viewer last.
    this.hitRects = [];
    const list: Drawable[] = [];
    this.collectFeatures(list, z);
    this.collectLoot(list);
    this.collectEntities(list, dt);
    list.sort((a, b) => a.depth - b.depth);
    for (const d of list) {
      try {
        d.draw();
      } catch (e) {
        ctx.restore?.();
        if (!this.warned) console.error('[renderer] drawable failed', e);
        this.warned = true;
      }
    }
    // 4. Particles and projectiles, the mist (fog of war), light, weather; floating texts and labels on top.
    this.drawFx();
    this.drawMist(z, 'air');
    this.drawLighting(z);
    this.drawWeather(dt, z);
    this.setWorldTransform();
    this.drawTexts();
    this.drawOverlayLabels(z);
  }

  /** Developer view of the navigation grid. */
  private drawWalkable(z: ZoneData) {
    const ctx = this.ctx;
    const nav = z.walk;
    const view = [this.screenToGround(0, 0), this.screenToGround(this.W, 0), this.screenToGround(0, this.H), this.screenToGround(this.W, this.H)];
    const [x0, y0] = nav.cellOf(Math.min(...view.map((v) => v.x)), Math.min(...view.map((v) => v.y)));
    const [x1, y1] = nav.cellOf(Math.max(...view.map((v) => v.x)), Math.max(...view.map((v) => v.y)));
    for (let cy = Math.max(0, y0); cy <= Math.min(nav.rows - 1, y1); cy++)
      for (let cx = Math.max(0, x0); cx <= Math.min(nav.cols - 1, x1); cx++) {
        const walk = nav.walkableCell(cx, cy), sight = nav.seeThroughCell(cx, cy);
        if (!walk && sight) continue;
        const p = iso((cx + 0.5) * NAV_CELL, (cy + 0.5) * NAV_CELL);
        ctx.fillStyle = walk ? 'rgba(60,220,90,0.28)' : 'rgba(60,110,255,0.3)';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - HH * NAV_CELL);
        ctx.lineTo(p.x + HW * NAV_CELL, p.y);
        ctx.lineTo(p.x, p.y + HH * NAV_CELL);
        ctx.lineTo(p.x - HW * NAV_CELL, p.y);
        ctx.fill();
      }
  }

  // ---------------------------------------------------------------------------- exploration

  /** The party sees the ground around it (the server keeps the same memory; this shows it at once). */
  private updateExplored(z: ZoneData, lp: Vec2) {
    const st = this.client.state;
    if (!st.explored) return;
    const key = `${Math.round(lp.x)},${Math.round(lp.y)},${st.zoneVersion}`;
    if (key === this.lastExplore) return;
    this.lastExplore = key;
    const { w, h } = fogSize(z);
    const r = 11;
    for (const e of st.entities.values()) {
      if (e.ownerUserId !== st.userId) continue;
      const p = this.client.entityPos(e);
      const px = Math.round(p.x), py = Math.round(p.y);
      for (let y = Math.max(0, py - r); y <= Math.min(h - 1, py + r); y++)
        for (let x = Math.max(0, px - r); x <= Math.min(w - 1, px + r); x++) if (Math.hypot(x - px, y - py) <= r) st.explored.set(y * w + x);
    }
  }

  // ---------------------------------------------------------------------------- features and loot

  private collectFeatures(list: Drawable[], z: ZoneData) {
    const st = this.client.state;
    const ctx = this.ctx;
    const leader = this.client.leaderEntity();
    const lp = leader ? this.client.entityPos(leader) : null;
    for (const f of z.features) {
      const fs = st.features.get(f.id);
      if (f.kind === 'trap' && !fs) continue;
      const p = iso(f.x, f.y);
      const hovered = this.hover.featureId === f.id;
      const liveTrap = f.kind === 'trap' && !fs?.disarmed && !fs?.triggered;
      const usable = !liveTrap && USABLE.has(f.kind) && !(f.kind === 'chest' && fs?.opened && fs?.empty) && !(f.kind === 'lore' && fs?.opened);
      const near = lp ? Math.hypot(lp.x - f.x, lp.y - f.y) : 99;
      const proximity = near < 10 ? 1 - Math.max(0, near - 4) / 6 : 0;
      const pulse = 0.5 + Math.sin(this.t * 3 + f.x * 0.7) * 0.5;
      const art = this.objectArt(f, fs?.opened);
      const depth = f.x + f.y + (art ? 0.06 : -0.4);
      list.push({
        depth,
        draw: () => {
          if (art) {
            const x = p.x - art.width / 2, y = p.y - art.height + 3;
            const l = this.light.at(p.x, p.y);
            ctx.save();
            ctx.translate(p.x, p.y);
            this.contactShadow(art.width / (2 * Math.SQRT2 * HW), l);
            this.drawLit(art.width, art.height, l, (g) => g.drawImage(art, -art.width / 2, 3 - art.height));
            ctx.restore();
            if (usable || hovered) drawOutline(ctx, art, x, y, HIGHLIGHT.use, hovered ? 1 : usable ? proximity * (0.35 + pulse * 0.35) : 0);
            const s = this.worldToScreen(x, y);
            this.hitRects.push({ id: f.id, kind: 'feature', x: s.x, y: s.y, w: art.width * this.zoom, h: art.height * this.zoom, depth });
            return;
          }
          // Everything else is in the painting (a door, a bed, the thing a quest asks about) or small (a note):
          // a mark on the ground shows it can be used.
          const glow = liveTrap ? 1 : hovered ? 1 : f.kind === 'door' || f.kind === 'exit' ? 0.25 + proximity * 0.45 : usable ? 0.2 + proximity * (0.4 + pulse * 0.3) : 0;
          if (glow > 0.01) this.groundMark(f, glow, liveTrap);
          const s = this.groundToScreen(f.x, f.y, 24);
          this.hitRects.push({ id: f.id, kind: 'feature', x: s.x - 26 * this.zoom, y: s.y - 30 * this.zoom, w: 52 * this.zoom, h: 64 * this.zoom, depth });
        },
      });
    }
  }

  /** A world object's art (a chest, open or shut; a sign; the waypoint), scaled to its height. */
  private objectArt(f: FeatureDef, opened?: boolean): HTMLCanvasElement | null {
    const o = OBJECT_ART[f.kind];
    if (!o) return null;
    const key = f.kind === 'chest' && opened && this.client.assetUrl(`${o.key}@open`) ? `${o.key}@open` : o.key;
    const img = loadImage(this.client.assetUrl(key));
    return img ? sizedSprite(img, key, o.height * PX_PER_METRE_UP) : null;
  }

  /** The ground mark of a feature: a soft ring (with an arrow for ways through, a dashed red one for a trap). */
  private groundMark(f: FeatureDef, alpha: number, trap: boolean) {
    const ctx = this.ctx;
    const p = iso(f.x, f.y);
    const color = trap ? '255,70,50' : f.kind === 'lore' || f.kind === 'object' ? '255,226,140' : '200,230,255';
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.5);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(${color},${Math.min(1, alpha)})`;
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 10;
    if (trap) {
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -this.t * 14;
    }
    const r = (trap ? 0.7 : 0.55) * HW * Math.SQRT2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    if (f.kind === 'door' || f.kind === 'exit') {
      // An arrow on the ground pointing the way through: into the building, or out of the place.
      const z = this.client.state.zone!;
      const into = f.kind === 'door' && !!this.client.state.world?.zones.find((x) => x.id === f.targetZoneId && x.parentZoneId === z.id);
      const dx = into ? -1 : f.x - z.entry.x, dy = into ? -1 : f.y - z.entry.y;
      const len = Math.hypot(dx, dy) || 1;
      const a = iso(f.x - (dx / len) * 0.25, f.y - (dy / len) * 0.25), b = iso(f.x + (dx / len) * 0.35, f.y + (dy / len) * 0.35);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.save();
      ctx.strokeStyle = `rgba(${color},${Math.min(1, alpha)})`;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.x - Math.cos(ang - 0.6) * 12, b.y - Math.sin(ang - 0.6) * 12);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(ang + 0.6) * 12, b.y - Math.sin(ang + 0.6) * 12);
      ctx.stroke();
      ctx.restore();
    } else if (f.kind === 'lore' || f.kind === 'object') {
      // A small light hovering over it.
      const y = p.y - 26 + Math.sin(this.t * 2.2 + f.x) * 4;
      const g = ctx.createRadialGradient(p.x, y, 0, p.x, y, 12);
      g.addColorStop(0, `rgba(255,248,210,${alpha})`);
      g.addColorStop(0.35, `rgba(${color},${alpha * 0.6})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 12, y - 12, 24, 24);
    }
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

  /** An actor's animation (clip sheets rendered from its rig), when its world has one. */
  private actorAnim(key: string | undefined): ActorAnim | undefined {
    return key ? this.client.state.world?.assets[key]?.anim : undefined;
  }

  /** A clip's sheet, once loaded. The other clips of the actor start loading with it. */
  private clipSheet(key: string, clip: ClipName): HTMLImageElement | null {
    const anim = this.actorAnim(key);
    if (!anim) return null;
    const img = loadImage(this.client.assetUrl(clipKey(key, clip)));
    if (!this.preloaded.has(key)) {
      this.preloaded.add(key);
      for (const c of Object.keys(anim.clips) as ClipName[]) loadImage(this.client.assetUrl(clipKey(key, c)));
    }
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }
  private preloaded = new Set<string>();
  /** Developer option: light figures like the place (off: drawn as painted or rendered). */
  figureLight = true;

  /** The steered leader's position this frame: walked locally, pulled gently toward where the server has it. */
  private predict(server: { x: number; y: number; moving: boolean; facing: number }, a: Anim, dt: number) {
    if (!this.steer) {
      // Stopped: stay exactly where the walk ended while the server catches up (it was told this spot).
      const p = this.predicted;
      if (!p) return server;
      if (!this.holdUntil) this.holdUntil = performance.now() + 1500;
      // (A new move — a click — releases it too, once the stop has reached the server.)
      if ((server.moving && performance.now() > this.holdUntil - 1100) || Math.hypot(server.x - p.x, server.y - p.y) < 0.12 || performance.now() > this.holdUntil) {
        this.predicted = null;
        this.holdUntil = 0;
        return server;
      }
      return { x: p.x, y: p.y, moving: false, facing: server.facing };
    }
    this.holdUntil = 0;
    // A new place (a way out walked through) starts from where the server put the party.
    const zid = this.client.state.zone?.id;
    if (this.predictedZone !== zid) {
      this.predictedZone = zid;
      this.predicted = { x: server.x, y: server.y };
    }
    const p = (this.predicted ??= { x: a.px, y: a.py });
    const step = 4.2 * Math.min(dt, 0.05);
    const d = this.steer;
    // Walk on, sliding along walls the way the server does.
    for (const [mx, my] of [[d.x, d.y], [d.x, 0], [0, d.y]] as const) {
      const len = Math.hypot(mx, my);
      if (len < 0.2) continue;
      const nx = p.x + (mx / len) * step, ny = p.y + (my / len) * step;
      if (this.canStand(nx, ny)) {
        p.x = nx;
        p.y = ny;
        break;
      }
    }
    // This screen leads (the server takes its position); only a big disagreement — a teleport or a new place —
    // snaps back.
    if (Math.hypot(server.x - p.x, server.y - p.y) > 6) {
      p.x = server.x;
      p.y = server.y;
    }
    return { x: p.x, y: p.y, moving: true, facing: Math.atan2(d.y, d.x) };
  }

  private anim(e: EntityView): Anim {
    let a = this.anims.get(e.id);
    if (!a) {
      a = { px: e.x, py: e.y, walk: 0, moving: false, amt: 0, dir: 1, face: e.facing, hurt: 0, attack: 0, death: 0, lastHp: e.hp, fade: 0, motion: newMotion() };
      this.anims.set(e.id, a);
    }
    return a;
  }

  private collectEntities(list: Drawable[], dt: number) {
    const st = this.client.state;
    const ctx = this.ctx;
    const combat = st.combat;
    const markers = st.player?.npcMarkers ?? {};
    const leadId = st.player?.leaderId;
    for (const e of st.entities.values()) {
      let target = this.client.entityPos(e);
      const a = this.anim(e);
      if (e.id === leadId && !combat) target = this.predict(target, a, dt);
      const gap = Math.hypot(target.x - a.px, target.y - a.py);
      // Small discrepancies (a new path, server correction) are eased out; big ones (teleport, a new place) snap.
      const k = gap > 2.5 ? 1 : 1 - Math.exp(-dt * (target.moving ? 18 : 12));
      const nx = a.px + (target.x - a.px) * k, ny = a.py + (target.y - a.py) * k;
      const moved = Math.hypot(nx - a.px, ny - a.py);
      // Legs keep pace with how far the figure travels on screen: a metre up or down the screen is half the
      // distance of a metre across it.
      const screenMoved = Math.hypot((nx - a.px - (ny - a.py)) * HW, (nx - a.px + (ny - a.py)) * HH) / (Math.SQRT2 * HW);
      a.px = nx;
      a.py = ny;
      a.moving = target.moving || moved > 0.004;
      a.amt = Math.max(0, Math.min(1, a.amt + (a.moving ? dt * 7 : -dt * 5)));
      // Stride about 0.9 m per cycle; keep the phase running while easing out so legs settle.
      if (a.amt > 0) a.walk += (gap > 2.5 ? 0 : screenMoved) * 7 + (a.moving ? 0 : dt * 2);
      // Turn smoothly toward the direction of travel.
      const dFace = Math.atan2(Math.sin(target.facing - a.face), Math.cos(target.facing - a.face));
      a.face += dFace * Math.min(1, dt * 14);
      a.hurt = Math.max(0, a.hurt - dt);
      a.attack = Math.max(0, a.attack - dt * 2.5);
      if (e.dead) a.death = Math.min(1, a.death + dt * 1.2);
      a.fade = Math.min(1, a.fade + dt * 3);
      const p = iso(a.px, a.py);
      // Screen-space facing from the ground direction.
      const fx = Math.cos(a.face), fy = Math.sin(a.face);
      const sdx = fx - fy, sdy = (fx + fy) / 2;
      if (sdx < -0.3) a.dir = -1;
      else if (sdx > 0.3) a.dir = 1;
      const anim = this.actorAnim(e.sprite);
      if (anim) advance(a.motion, anim, dt, a.moving && gap <= 2.5, gap > 2.5 || !dt ? 0 : moved / dt, !!(e.dead || e.downed));
      const dir = a.dir;
      const back = sdy < -0.25;
      const depth = a.px + a.py + 0.1;
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
          const l = this.light.at(p.x, p.y);
          if (!e.downed) this.contactShadow(BODY * e.scale, l);
          const img = loadImage(this.client.assetUrl(e.sprite));
          const height = 1.75 * PX_PER_METRE_UP * e.scale;
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
          const sheet = anim && this.clipSheet(e.sprite!, a.motion.clip);
          if (anim && sheet) {
            const c = anim.clips[a.motion.clip]!, b = cellBounds(anim, e.scale);
            const fallen = a.motion.clip === 'die' && a.motion.t > 0.4 * (c.frames / c.fps);
            this.drawLit(b.half * 2, b.above, l, (g) => drawCell(g, sheet, anim, frameOf(a.motion, c), rowOf(a.face), e.scale), fallen, b.below);
          } else this.drawLit(height * 1.5, height * 1.1, l, (g) => {
            if (img) drawImageSprite(g, img, { height, dir, walk, amt: a.amt, t: this.t, downed: e.downed, hurt: a.hurt, attack: a.attack });
            else
              drawFigure(g, {
                shape: e.shape, colors: e.colors.length ? e.colors : e.kind === 'character' ? ['#4a6a9a', '#2a3448', '#e0c060'] : ['#7a6a5a', '#4a3a30', '#d0b080'], scale: e.scale * 1.15, dir, back, walk, t: this.t, weapon: e.weapon, archetype: e.archetype,
                seed: e.id, downed: e.downed, hurt: a.hurt, attack: a.attack, role: e.role, kind: e.kind, amt: a.amt, presentation: e.presentation,
              });
          }, e.downed);
          ctx.shadowBlur = 0;
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

  /**
   * A soft contact shadow on the ground under a figure (at the current origin, its feet): a body `r` metres across
   * as an isometric ellipse, a dark core under the feet and a wider penumbra, in the place's own shadow colour.
   */
  private contactShadow(r: number, l: FigureLight) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(1, HH / HW);
    const R = r * Math.SQRT2 * HW * 1.25;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, `rgba(${l.shadow},${l.shadowAlpha})`);
    g.addColorStop(0.45, `rgba(${l.shadow},${l.shadowAlpha * 0.7})`);
    g.addColorStop(1, `rgba(${l.shadow},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draw a figure lit like the place (see light.ts): `draw` paints it once at the current origin (its feet) into a
   * scratch canvas; a copy is tinted from the key light at its top to the ground's bounce at its feet, cut back to
   * its shape, washed with the light from the upper left, and put on the view (keeping the caller's alpha and glow). `w` x `h` (picture
   * px) bounds the figure above its feet; a downed figure lies on its side, so it gets a box around it.
   */
  private drawLit(w: number, h: number, l: FigureLight, draw: (g: CanvasRenderingContext2D) => void, lying = false, under?: number) {
    const ctx = this.ctx;
    if (!this.figureLight) return draw(ctx);
    const T = ctx.getTransform();
    const k = T.a;
    const top = lying && under === undefined ? h * 0.6 : h, below = under ?? (lying ? h * 0.6 : h * 0.12);
    const bx = Math.floor(T.e - (w / 2) * k), by = Math.floor(T.f - top * k);
    const bw = Math.ceil(w * k) + 2, bh = Math.ceil((top + below) * k) + 2;
    if (bw * bh > 4e6) return draw(ctx);
    const [fig, lit] = this.scratch;
    for (const c of this.scratch) if (c.width < bw || c.height < bh) [c.width, c.height] = [Math.max(c.width, bw), Math.max(c.height, bh)];
    const f = fig.getContext('2d')!, g = lit.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, bw, bh);
    f.setTransform(T.a, T.b, T.c, T.d, T.e - bx, T.f - by);
    f.globalAlpha = 1;
    f.imageSmoothingQuality = 'high';
    draw(f);
    // Key light at the head to ground bounce at the feet (multiply), cut back to the figure's own shape.
    const feet = T.f - by, head = feet - (lying ? h * 0.3 : h) * k;
    const grad = g.createLinearGradient(0, head, 0, feet);
    grad.addColorStop(0, l.top);
    grad.addColorStop(0.55, l.top);
    grad.addColorStop(1, l.bottom);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, bw, bh);
    g.drawImage(fig, 0, 0, bw, bh, 0, 0, bw, bh);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = grad;
    g.fillRect(0, 0, bw, bh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(fig, 0, 0, bw, bh, 0, 0, bw, bh);
    const wash = g.createLinearGradient(0, 0, bw * 0.6, bh * 0.4);
    wash.addColorStop(0, l.wash);
    wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = wash;
    g.fillRect(0, 0, bw, bh);
    g.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lit, 0, 0, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }

  private labels: { e: EntityView; x: number; y: number; hovered: boolean; marker?: string; inCombat: boolean }[] = [];

  private drawOverlayLabels(z: ZoneData) {
    const ctx = this.ctx;
    this.setScreenTransform();
    for (const l of this.labels) {
      const e = l.e;
      if (e.dead || !this.client.seen(e.x, e.y)) continue;
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
    // The hovered feature's name.
    const f = this.hover.featureId ? z.features.find((x) => x.id === this.hover.featureId) : undefined;
    const name = f && this.featureLabel(f);
    if (f && name) {
      const s = this.groundToScreen(f.x, f.y, (OBJECT_ART[f.kind]?.height ?? 1) * PX_PER_METRE_UP + 12);
      ctx.font = '600 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(name, s.x, s.y);
      ctx.fillStyle = '#ffe8b0';
      ctx.fillText(name, s.x, s.y);
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
    const lines: string[] = [];
    let cur = '';
    for (const w of text.split(' ')) {
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

  /** Surfaces lie in square-metre patches: soft blobs of their colour on the ground. */
  private drawSurfaces() {
    const ctx = this.ctx;
    for (const s of this.client.state.surfaces) {
      const p = iso(s.x, s.y);
      const base = { fire: '#ff6a1a', poison: '#6ac02a', water: '#3a80e0', ice: '#cfefff', oil: '#3a2a1a', blessed: '#ffe680' }[s.type] ?? '#a0a0a0';
      const flick = s.type === 'fire' ? 0.45 + Math.sin(this.t * 12 + s.x * 3) * 0.12 : s.type === 'blessed' ? 0.35 + Math.sin(this.t * 2) * 0.08 : 0.42;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1, 0.5);
      const r = HW * 0.95;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, base + Math.round(flick * 255).toString(16).padStart(2, '0'));
      g.addColorStop(0.6, base + Math.round(flick * 200).toString(16).padStart(2, '0'));
      g.addColorStop(1, base + '00');
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
      if (s.type === 'fire' && Math.random() < 0.25) this.fx.spark(s.x + (Math.random() - 0.5) * 0.8, s.y + (Math.random() - 0.5) * 0.8, 0.1, Math.random() < 0.5 ? '#ffb040' : '#ff5a10', 0.7, 0.4, 3);
      if (s.type === 'poison' && Math.random() < 0.06) this.fx.spark(s.x, s.y, 0.05, '#9fe060', 0.8, 0.2, 2, false);
    }
  }

  /** An ellipse on the ground around (x, y), `r` metres across. */
  private groundCircle(x: number, y: number, r: number) {
    const ctx = this.ctx;
    const c = iso(x, y);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, r * HW * Math.SQRT2, r * HH * Math.SQRT2, 0, 0, Math.PI * 2);
  }

  /** Others in the fight, as the active fighter's walk sees them (strangers block, allies can be squeezed past). */
  private walkersFor(active: EntityView) {
    const st = this.client.state;
    return [...st.entities.values()].filter((e) => e.id !== active.id && !e.dead && e.inCombat).map((e) => ({ x: e.x, y: e.y, ally: e.hostile === active.hostile }));
  }

  private drawGroundOverlays(z: ZoneData) {
    const st = this.client.state;
    const ctx = this.ctx;
    const combat = st.combat;
    const active = combat ? st.entities.get(combat.activeId) : undefined;
    const myTurn = this.client.isMyTurn() && active;
    const ch = active ? st.player?.party.find((c) => c.id === active.id) : undefined;
    const tgt = st.targeting;
    const nav = z.walk;
    // How far the active character can move this turn: a soft area with a ring at its edge and at each AP step.
    if (myTurn && ch && !tgt?.skillId && !tgt?.itemId) {
      const stats = this.client.charStats(ch);
      const order = combat!.order.find((o) => o.id === active!.id)!;
      const budget = order.movementLeft + order.ap * stats.move;
      const apOf = (cost: number) => (cost <= order.movementLeft ? 0 : Math.ceil((cost - order.movementLeft) / stats.move));
      const others = this.walkersFor(active!);
      const key = `${active!.x.toFixed(2)},${active!.y.toFixed(2)},${budget},${combat!.round},${others.map((o) => `${o.x.toFixed(1)},${o.y.toFixed(1)}`).join(';')}`;
      if (this.reach?.key !== key) {
        const cells = nav.reach(active!, budget, walkAmong(nav, others));
        // Nobody can stop where someone already stands.
        for (const i of [...cells.keys()]) {
          const c = nav.centre(i % nav.cols, Math.floor(i / nav.cols));
          if (others.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < SPACING - 0.01)) cells.delete(i);
        }
        const bands = Math.max(0, ...[...cells.values()].map(apOf));
        const lines = Array.from({ length: bands + 1 }, (_, b) => contour(nav.cols, nav.rows, (cx, cy) => {
          const c = cells.get(cy * nav.cols + cx);
          return c !== undefined && apOf(c) <= b;
        }));
        this.reach = { key, cells, lines };
      }
      ctx.save();
      ctx.lineCap = 'round';
      this.reach.lines.forEach((segs, b) => {
        const last = b === this.reach!.lines.length - 1;
        ctx.strokeStyle = last ? 'rgba(140,220,255,0.85)' : 'rgba(140,220,255,0.35)';
        ctx.lineWidth = last ? 2.2 : 1.4;
        ctx.shadowColor = 'rgba(60,160,255,0.9)';
        ctx.shadowBlur = last ? 6 : 0;
        ctx.beginPath();
        for (let i = 0; i < segs.length; i += 4) {
          const a = iso(segs[i]!, segs[i + 1]!), c = iso(segs[i + 2]!, segs[i + 3]!);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
        }
        ctx.stroke();
      });
      ctx.restore();
      // The walk to the hovered point, and what it costs.
      const h = this.hover.point;
      if (h && !this.hover.entityId && nav.walkable(h.x, h.y)) {
        const path = nav.path(active!, h, { ...walkAmong(nav, others), maxNodes: 12000 });
        if (path?.length) {
          const len = walkCost(active!, path, squeezeCost(others.filter((o) => o.ally)));
          ctx.strokeStyle = 'rgba(255,240,180,0.9)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          const s0 = iso(active!.x, active!.y);
          ctx.moveTo(s0.x, s0.y);
          for (const t of path) {
            const s = iso(t.x, t.y);
            ctx.lineTo(s.x, s.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          const cost = apOf(len);
          const ok = len <= budget + 1e-6;
          ctx.fillStyle = ok ? 'rgba(255,230,140,0.3)' : 'rgba(255,80,60,0.3)';
          ctx.strokeStyle = ok ? 'rgba(255,230,140,0.9)' : 'rgba(255,80,60,0.9)';
          this.groundCircle(h.x, h.y, 0.4);
          ctx.fill();
          ctx.stroke();
          this.cursorNote = { text: ok ? `${cost} ${st.world?.ruleset.terminology.actionPoints ?? 'AP'}` : 'Too far', ok };
        }
      }
    }
    // Skill and item targeting: the range ring, and the area or target under the cursor.
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
        if (range > 0) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,230,150,0.55)';
          ctx.setLineDash([6, 6]);
          ctx.lineWidth = 2;
          this.groundCircle(up.x, up.y, range);
          ctx.stroke();
          ctx.restore();
        }
        const center = skill?.targeting === 'self' ? up : this.hover.point;
        if (center) {
          const inRange = Math.hypot(center.x - up.x, center.y - up.y) <= range + 0.01 || skill?.targeting === 'self';
          const los = range <= 2 || nav.sees(up, center);
          const color = inRange && los ? '255,220,120' : '255,80,60';
          ctx.fillStyle = `rgba(${color},${radius ? 0.22 : 0.3})`;
          ctx.strokeStyle = `rgba(${color},0.9)`;
          this.groundCircle(center.x, center.y, radius || 0.45);
          ctx.fill();
          ctx.stroke();
          this.cursorNote = inRange ? (los ? null : { text: 'No line of sight', ok: false }) : { text: 'Out of range', ok: false };
        }
      }
    }
  }

  cursorNote: { text: string; ok: boolean } | null = null;
  private warned = false;

  // ---------------------------------------------------------------------------- fx

  /** Start a one-shot clip (a blow, a spell, a flinch) on an actor that has clip sheets. */
  private playClip(id: string | undefined, clip: ClipName) {
    const a = id ? this.anims.get(id) : undefined;
    const e = id ? this.client.state.entities.get(id) : undefined;
    if (a && e) playOnce(a.motion, clip, this.actorAnim(e.sprite));
  }

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
            this.playClip(ev.targetId, 'hit');
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
          this.playClip(ev.sourceId, ev.fx === 'arrow' ? 'attack' : 'cast');
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
          this.playClip(ev.sourceId, ev.fx === 'slash' || ev.fx === 'arrow' || ev.fx === 'none' ? 'attack' : 'cast');
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

  // ---------------------------------------------------------------------------- light, fog, weather

  /**
   * How dark it is beyond the party's light. The painting carries the place's own light, so this only deepens it:
   * night and dusk under the open sky, and a dim place's gloom indoors.
   */
  private daylight(z: ZoneData): { darkness: number; tint: RGB } {
    if (!z.look.outdoor) return { darkness: Math.max(0, 0.8 - z.look.ambient) * 0.75, tint: hexToRgb(z.look.fogColor) };
    const h = (this.client.clockMinute() % 1440) / 60;
    // 0 at noon, 1 at midnight, smooth dawn/dusk.
    const night = h < 5 ? 1 : h < 7.5 ? 1 - (h - 5) / 2.5 : h < 18 ? 0 : h < 20.5 ? (h - 18) / 2.5 : 1;
    const dusk = h > 17 && h < 20.5 ? Math.sin(((h - 17) / 3.5) * Math.PI) : h > 5 && h < 8 ? Math.sin(((h - 5) / 3) * Math.PI) * 0.7 : 0;
    return { darkness: night * 0.62 + dusk * 0.16, tint: mix([10, 16, 48], [90, 40, 30], dusk) };
  }

  private drawLighting(z: ZoneData) {
    const { darkness, tint } = this.daylight(z);
    if (darkness < 0.02) return;
    const st = this.client.state;
    const lc = this.lightCanvas;
    const l = lc.getContext('2d')!;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, lc.width, lc.height);
    l.fillStyle = rgb(tint, darkness);
    l.fillRect(0, 0, lc.width, lc.height);
    l.globalCompositeOperation = 'destination-out';
    const hole = (x: number, y: number, metres: number, strength = 1, flicker = 0) => {
      const s = this.groundToScreen(x, y, 20);
      const r = metres * HW * this.zoom * (1 + flicker);
      const g = l.createRadialGradient(s.x / 2, s.y / 2, 0, s.x / 2, s.y / 2, r / 2);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.6})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.fillRect(s.x / 2 - r / 2, s.y / 2 - r / 2, r, r);
    };
    const glows: { x: number; y: number; r: number; color: string }[] = [];
    for (const e of st.entities.values()) {
      const p = this.client.entityPos(e);
      if (e.ownerUserId === st.userId) hole(p.x, p.y, 7.5, 1);
      else if (e.boss) hole(p.x, p.y, 3, 0.6);
    }
    for (const f of z.features) {
      if (f.kind === 'waypoint' || f.kind === 'object' || (f.kind === 'lore' && !st.features.get(f.id)?.opened)) {
        hole(f.x, f.y, f.kind === 'lore' ? 1.6 : 3, 0.7);
        glows.push({ x: f.x, y: f.y, r: 1.4, color: f.kind === 'waypoint' ? z.look.lightColor : '#ffe090' });
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const g of glows) {
      const s = this.groundToScreen(g.x, g.y, 30);
      const r = g.r * HW * this.zoom;
      const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      gr.addColorStop(0, g.color + '55');
      gr.addColorStop(1, g.color + '00');
      ctx.fillStyle = gr;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Fog of war per square metre for the mist: unexplored (0/255) and remembered-but-unseen (dim) bytes. */
  private fogBytes: { key: string; data: Uint8Array; w: number; h: number } | null = null;

  /** The fog of war of each square metre in view: unexplored, or how dim remembered ground is (a veil once out of sight). */
  private visibleFog(w: number, h: number, write: (x: number, y: number, unseen: boolean, dim: number) => void) {
    const st = this.client.state;
    const party = [...st.entities.values()].filter((e) => e.ownerUserId === st.userId).map((e) => this.client.entityPos(e));
    const view = [this.screenToGround(0, 0), this.screenToGround(this.W, 0), this.screenToGround(0, this.H), this.screenToGround(this.W, this.H)];
    const x0 = Math.max(0, Math.floor(Math.min(...view.map((v) => v.x))) - 3), x1 = Math.min(w - 1, Math.ceil(Math.max(...view.map((v) => v.x))) + 3);
    const y0 = Math.max(0, Math.floor(Math.min(...view.map((v) => v.y))) - 3), y1 = Math.min(h - 1, Math.ceil(Math.max(...view.map((v) => v.y))) + 3);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!st.explored!.get(y * w + x)) {
          write(x, y, true, 0);
          continue;
        }
        let d = 99;
        for (const p of party) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
        // Remembered-but-unseen ground dims smoothly with distance from the party.
        write(x, y, false, d > 13 ? 0.45 : d > 8 ? ((d - 8) / 5) ** 1.5 * 0.45 : 0);
      }
  }

  /** This frame's mist (see mist.ts), shared by its two passes. */
  private mistFrame: MistFrame | null = null;

  /** The fog of war per square metre for the mist (null where there is none). */
  private fogOfWar(z: ZoneData): { data: Uint8Array; w: number; h: number } | null {
    if (!this.client.state.explored) return null;
    const { w, h } = fogSize(z);
    const key = `${this.zoneKey}:${w}x${h}`;
    if (this.fogBytes?.key !== key) this.fogBytes = { key, data: new Uint8Array(w * h * 2).fill(255), w, h };
    const data = this.fogBytes.data;
    for (let i = 1; i < data.length; i += 2) data[i] = 0;
    this.visibleFog(w, h, (x, y, unseen, dim) => {
      data[(y * w + x) * 2] = unseen ? 255 : 0;
      data[(y * w + x) * 2 + 1] = Math.round(dim * 255);
    });
    return this.fogBytes;
  }

  /**
   * One pass of the place's mist (see mist.ts) onto the view: the ground past the painting's edge (before the
   * figures), or the air (fog of war and the veil along the edge, over everything). The frame is set up by the first.
   */
  private drawMist(z: ZoneData, pass: 'ground' | 'air') {
    if (!z.painting) return;
    if (pass === 'ground') {
      const st = this.client.state;
      const p = z.look.painted;
      const level = p?.level ?? z.look.ambient * 0.55;
      // The thin mist takes the place's shadow colour, its wisps the place's light, dimmer in darker places.
      const key = hexToRgb(p?.light ?? z.look.lightColor), km = Math.max(1, ...key);
      const c = iso(this.camX, this.camY);
      this.mistFrame = {
        W: this.W, H: this.H, camX: c.x, camY: c.y, zoom: this.zoom, t: this.t, fog: this.fogOfWar(z),
        rect: [-z.painting.ox, -z.painting.oy, z.painting.width - z.painting.ox, z.painting.height - z.painting.oy],
        base: hexToRgb(z.look.fogColor),
        tint: key.map((v) => Math.min(255, (0.7 + (0.3 * v) / km) * (0.55 + level * 0.8) * 255)) as RGB,
        tile: z.look.mist ? loadImage(this.client.assetUrl(z.look.mist)) : null,
        party: [...st.entities.values()].filter((e) => e.ownerUserId === st.userId).map((e) => {
          const a = this.anims.get(e.id);
          return iso(a?.px ?? e.x, a?.py ?? e.y);
        }),
      };
    }
    const f = this.mistFrame;
    if (!f) return;
    if (!this.mist.ok) return pass === 'air' ? this.drawPlainFog(z, f.fog) : undefined;
    const out = this.mist.render(f, pass);
    if (!out) return;
    this.ctx.save();
    this.setScreenTransform();
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(out, 0, 0, this.W, this.H);
    this.ctx.restore();
  }

  /** Without WebGL: the fog of war as a plain veil in the place's fog colour (no mist, no edge). */
  private drawPlainFog(z: ZoneData, fog: { data: Uint8Array; w: number; h: number } | null) {
    if (!fog) return;
    const { w, h } = fog;
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [w, h];
    const img = canvas.getContext('2d')!.createImageData(w, h);
    const [r, g, b] = hexToRgb(z.look.fogColor);
    for (let i = 0; i < w * h; i++) img.data.set([r * 0.35, g * 0.35, b * 0.35, fog.data[i * 2]! || fog.data[i * 2 + 1]!], i * 4);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    const fc = this.fogCanvas;
    const f = fc.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, fc.width, fc.height);
    const sc = fc.width / this.W;
    const o = this.groundToScreen(0, 0);
    const k = this.zoom * sc;
    // Square metre (x, y) maps to screen ((x−y)·HW, (x+y)·HH); pixel corners sit half a metre before the centres.
    f.setTransform(HW * k, HH * k, -HW * k, HH * k, o.x * sc, o.y * sc);
    f.imageSmoothingEnabled = true;
    f.drawImage(canvas, -0.5, -0.5);
    this.setScreenTransform();
    this.ctx.drawImage(fc, 0, 0, this.W, this.H);
  }

  private drawWeather(dt: number, z: ZoneData) {
    const kind = z.look.weather;
    // No rain or snow under a roof (dust, ash, spores and embers can drift indoors).
    if (kind === 'none' || (!z.look.outdoor && (kind === 'rain' || kind === 'snow'))) return;
    const ctx = this.ctx;
    this.setScreenTransform();
    const target = kind === 'rain' ? 160 : kind === 'snow' ? 120 : kind === 'fireflies' ? 26 : 50;
    while (this.weather.length < target) this.weather.push({ x: Math.random() * this.W, y: Math.random() * this.H, z: Math.random(), s: Math.random(), p: Math.random() * 10 });
    const night = this.daylight(z).darkness;
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
}
