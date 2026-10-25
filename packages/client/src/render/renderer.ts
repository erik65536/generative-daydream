/**
 * The game view and its mouse input. The place's painting is the ground; everything that moves is drawn over it in
 * depth order (lit like the place, see light.ts), then the place's mist (fog of war and the painting's edge, see
 * mist.ts: what lies past the edge is drawn with the ground), light, weather, and the combat and targeting overlays. Positions are ground metres:
 * the painting is a top-down map of that ground (a metre runs PX_PER_METRE pixels across and down).
 */
import {
  BODY, NAV_CELL, PX_PER_METRE, SPACING, clipKey, fogSize, rx, skillRange, squeezeCost, walkAmong, walkCost,
  type ActorAnim, type ClipName, type EntityView, type FeatureDef, type FxEvent, type Vec2,
} from '@gd/shared';
import type { GameClient, ZoneData } from '../net/game';
import { hexToRgb, mix, rgb, type RGB } from './color';
import { drawImageSprite, drawPlaceholder, loadImage } from './sprites';
import { advance, cellBounds, drawCell, frameOf, newMotion, playOnce, rowOf, type Motion } from './actors';
import { PlaceLight, type FigureLight } from './light';
import { Mist, type MistFrame } from './mist';
import { FxSystem } from './fx';
import { HIGHLIGHT, drawOutline } from './highlight';
import { kindColor } from '../rules';

/** Ground metres to picture pixels (the ground origin at the picture origin). */
const M = PX_PER_METRE;
const pic = (x: number, y: number) => ({ x: x * M, y: y * M });
/**
 * Figures are drawn from a three-quarter camera over the top-down ground, so what lies flat around their feet (their
 * contact shadow, the rings under them) is drawn flattened by this, as that camera sees it.
 */
const SHADOW_FLAT = 0.6;
/** Size (m) of the squares the walkable outline is filed under, so a frame draws only the part near the mouse. */
const OUTLINE_BUCKET = 4;

/** Objects the game draws over every painting (one look per world), and how tall they stand in metres. */
const OBJECT_ART: Record<string, { key: string; height: number }> = {
  chest: { key: 'obj_chest', height: 0.85 },
  sign: { key: 'obj_sign', height: 1.7 },
  waypoint: { key: 'obj_waypoint', height: 2.1 },
  craft_station: { key: 'obj_craft_station', height: 1.1 },
};
/** Features one uses (they glow when near). Doors and ways out light up on hover. */
const USABLE = new Set(['chest', 'sign', 'lore', 'craft_station', 'waypoint', 'object']);

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
    const c = pic(this.camX, this.camY);
    return { x: (wx - c.x) * this.zoom + this.W / 2, y: (wy - c.y) * this.zoom + this.H / 2 };
  }

  /** Ground metres (and `z` pixels up) to screen pixels. */
  groundToScreen(x: number, y: number, z = 0) {
    const p = pic(x, y);
    return this.worldToScreen(p.x, p.y - z);
  }

  screenToGround(sx: number, sy: number): Vec2 {
    const c = pic(this.camX, this.camY);
    const wx = (sx - this.W / 2) / this.zoom + c.x;
    const wy = (sy - this.H / 2) / this.zoom + c.y;
    return { x: wx / M, y: wy / M };
  }

  private setWorldTransform() {
    const c = pic(this.camX, this.camY);
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
   * Where the camera may look to show ground point `g`: the view stays inside the painting, and a place smaller than
   * the screen sits centred with mist around it.
   */
  private framed(z: ZoneData, g: Vec2): Vec2 {
    if (!z.painting) return g;
    const c = pic(g.x, g.y), P = z.painting;
    const fit = (v: number, lo: number, hi: number, half: number) => (hi - lo <= half * 2 ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v)));
    const cx = fit(c.x, -P.ox, P.width - P.ox, this.W / 2 / this.zoom), cy = fit(c.y, -P.oy, P.height - P.oy, this.H / 2 / this.zoom);
    return { x: cx / M, y: cy / M };
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
    // behind another can still be clicked on its visible part. Any figure under the cursor beats things on the
    // ground (a creature standing over a satchel or a sign is the one picked).
    let best: (typeof this.hitRects)[number] | null = null;
    let bestScore = Infinity;
    for (const h of this.hitRects) {
      if (sx < h.x || sy < h.y || sx > h.x + h.w || sy > h.y + h.h) continue;
      const nx = (sx - (h.x + h.w / 2)) / (h.w / 2), ny = (sy - (h.y + h.h * 0.45)) / (h.h / 2);
      const score = nx * nx + ny * ny + (h.kind === 'entity' ? 0 : 100) - h.depth * 1e-4;
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
    this.chests.clear();
  }

  /** Chests seen with something in them, and when each was emptied (it fades away then). */
  private chests = new Map<string, number | null>();

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
    // Walk hints over the light, so they read at night too.
    this.drawWalkHints(z);
    this.drawTexts();
    this.drawOverlayLabels(z);
  }

  /**
   * Where one can walk, shown only near where it matters, the same for mouse and controller: the edge of the walkable
   * ground fades in around the mouse (or, with a controller, around the leader), and a small ring under the mouse is
   * warm on ground a click walks to and dim red where no one can stand (a click there walks only as near as it can).
   */
  private drawWalkHints(z: ZoneData) {
    const st = this.client.state;
    if (st.combat || st.dialog || st.panel || st.targeting) return;
    const ctx = this.ctx, nav = z.walk;
    if (st.inputMode === 'pad') {
      const leader = this.client.leaderEntity();
      if (leader) this.walkEdges(z, this.client.entityPos(leader), 3, 0.5);
      return;
    }
    const h = this.hover.point;
    if (!h || this.hover.entityId || this.hover.featureId || this.hover.lootId) return;
    this.walkEdges(z, h, 2.2, 0.42);
    const ok = nav.walkable(h.x, h.y);
    ctx.save();
    ctx.strokeStyle = ok ? 'rgba(255,248,225,0.5)' : 'rgba(255,105,85,0.7)';
    ctx.lineWidth = 1.5;
    if (!ok) ctx.setLineDash([2.5, 2.5]);
    this.groundCircle(h.x, h.y, 0.3);
    ctx.stroke();
    ctx.restore();
  }

  /** The walkable ground's outline: smooth segments in metres, bucketed by OUTLINE_BUCKET-metre squares. */
  private outline: { key: string; seg: Float32Array; buckets: Map<number, number[]>; bw: number } | null = null;

  /**
   * The edge of the walkable ground as a smooth line: marching squares at the half-way level over the walk grid
   * softened twice (cell corners, then a 3×3 blur), so it follows the ground in slopes and curves, not cell steps.
   * Made once per place.
   */
  private walkOutline(z: ZoneData) {
    const key = `${this.zoneKey}`;
    if (this.outline?.key === key) return this.outline;
    const nav = z.walk, C = nav.cols + 1, R = nav.rows + 1;
    const corner = new Float32Array(C * R);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < C; x++) {
        let open = 0;
        for (const [i, j] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]] as const) if (nav.walkableCell(i, j)) open++;
        corner[y * C + x] = open / 4;
      }
    const f = new Float32Array(C * R);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < C; x++) {
        let sum = 0, n = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(R - 1, y + 1); j++)
          for (let i = Math.max(0, x - 1); i <= Math.min(C - 1, x + 1); i++) (sum += corner[j * C + i]!), n++;
        f[y * C + x] = sum / n;
      }
    const out: number[] = [];
    const at = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number) => {
      const t = (0.5 - v0) / (v1 - v0);
      return [(x0 + (x1 - x0) * t) * NAV_CELL, (y0 + (y1 - y0) * t) * NAV_CELL];
    };
    for (let y = 0; y < R - 1; y++)
      for (let x = 0; x < C - 1; x++) {
        const a = f[y * C + x]!, b = f[y * C + x + 1]!, c = f[(y + 1) * C + x + 1]!, d = f[(y + 1) * C + x]!;
        // Crossings on the top, right, bottom and left sides of this square (or none).
        const top = (a >= 0.5) !== (b >= 0.5) ? at(x, y, a, x + 1, y, b) : null;
        const right = (b >= 0.5) !== (c >= 0.5) ? at(x + 1, y, b, x + 1, y + 1, c) : null;
        const bottom = (d >= 0.5) !== (c >= 0.5) ? at(x, y + 1, d, x + 1, y + 1, c) : null;
        const left = (a >= 0.5) !== (d >= 0.5) ? at(x, y, a, x, y + 1, d) : null;
        const pts = [top, right, bottom, left].filter((q): q is number[] => !!q);
        if (pts.length === 2) out.push(...pts[0]!, ...pts[1]!);
        else if (pts.length === 4) {
          // A saddle: the centre decides which corners join.
          const joinAB = ((a + b + c + d) / 4 >= 0.5) === (a >= 0.5);
          if (joinAB) out.push(...top!, ...right!, ...bottom!, ...left!);
          else out.push(...top!, ...left!, ...bottom!, ...right!);
        }
      }
    const seg = Float32Array.from(out), bw = Math.ceil((nav.cols * NAV_CELL) / OUTLINE_BUCKET) + 1;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < seg.length; i += 4) {
      const k = Math.floor((seg[i + 1]! + seg[i + 3]!) / 2 / OUTLINE_BUCKET) * bw + Math.floor((seg[i]! + seg[i + 2]!) / 2 / OUTLINE_BUCKET);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
    return (this.outline = { key, seg, buckets, bw });
  }

  /** The walkable ground's edge within `R` metres of `at`, fading outward. */
  private walkEdges(z: ZoneData, at: Vec2, R: number, alpha: number) {
    const ctx = this.ctx, o = this.walkOutline(z);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,240,200,0.6)';
    ctx.shadowBlur = 4;
    const bx0 = Math.floor((at.x - R) / OUTLINE_BUCKET), bx1 = Math.floor((at.x + R) / OUTLINE_BUCKET);
    const by0 = Math.floor((at.y - R) / OUTLINE_BUCKET), by1 = Math.floor((at.y + R) / OUTLINE_BUCKET);
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        for (const i of o.buckets.get(by * o.bw + bx) ?? []) {
          const s = o.seg, d = Math.hypot((s[i]! + s[i + 2]!) / 2 - at.x, (s[i + 1]! + s[i + 3]!) / 2 - at.y);
          if (d >= R) continue;
          const p = pic(s[i]!, s[i + 1]!), q = pic(s[i + 2]!, s[i + 3]!);
          ctx.strokeStyle = `rgba(255,244,215,${(alpha * (1 - d / R)).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
    ctx.restore();
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
        const p = pic((cx + 0.5) * NAV_CELL, (cy + 0.5) * NAV_CELL);
        ctx.fillStyle = walk ? 'rgba(60,220,90,0.28)' : 'rgba(60,110,255,0.3)';
        ctx.fillRect(p.x - (M * NAV_CELL) / 2, p.y - (M * NAV_CELL) / 2, M * NAV_CELL, M * NAV_CELL);
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
      if (f.kind === 'object' && !this.client.questThingOpen(f.id)) continue;
      const p = pic(f.x, f.y);
      const hovered = this.hover.featureId === f.id;
      const liveTrap = f.kind === 'trap' && !fs?.disarmed && !fs?.triggered;
      const usable = !liveTrap && USABLE.has(f.kind) && !(f.kind === 'chest' && fs?.opened && fs?.empty) && !(f.kind === 'lore' && fs?.opened);
      const near = lp ? Math.hypot(lp.x - f.x, lp.y - f.y) : 99;
      const proximity = near < 10 ? 1 - Math.max(0, near - 4) / 6 : 0;
      const pulse = 0.5 + Math.sin(this.t * 3 + f.x * 0.7) * 0.5;
      // An emptied chest fades away (one already empty when the place is entered is not drawn at all).
      let fade = 1;
      if (f.kind === 'chest') {
        const emptied = !!(fs?.opened && fs.empty);
        if (!emptied) this.chests.set(f.id, null);
        else if (!this.chests.has(f.id)) continue;
        else {
          const t0 = this.chests.get(f.id) ?? this.t;
          this.chests.set(f.id, t0);
          fade = 1 - (this.t - t0) / 0.6;
          if (fade <= 0) continue;
        }
      }
      const art = this.objectArt(f);
      const depth = f.y + (art ? 0.03 : -0.2);
      list.push({
        depth,
        draw: () => {
          if (art) {
            const x = p.x - art.width / 2, y = p.y - art.height + 3;
            const l = this.light.at(p.x, p.y);
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.translate(p.x, p.y);
            this.contactShadow(art.width / (2 * M), l);
            this.drawLit(art.width, art.height, l, (g) => g.drawImage(art, -art.width / 2, 3 - art.height));
            ctx.restore();
            if (fade < 1) return;
            if (usable || hovered) drawOutline(ctx, art, x, y, HIGHLIGHT.use, hovered ? 1 : usable ? proximity * (0.35 + pulse * 0.35) : 0);
            const s = this.worldToScreen(x, y);
            this.hitRects.push({ id: f.id, kind: 'feature', x: s.x, y: s.y, w: art.width * this.zoom, h: art.height * this.zoom, depth });
            return;
          }
          // Everything else is in the painting (a way out, the thing a quest asks about) or small (a note):
          // a mark on the ground shows it can be used.
          const glow = liveTrap ? 1 : hovered ? 1 : f.kind === 'exit' ? 0.25 + proximity * 0.45 : usable ? 0.2 + proximity * (0.4 + pulse * 0.3) : 0;
          if (glow > 0.01) this.groundMark(f, glow, liveTrap);
          const s = this.groundToScreen(f.x, f.y, 24);
          this.hitRects.push({ id: f.id, kind: 'feature', x: s.x - 26 * this.zoom, y: s.y - 30 * this.zoom, w: 52 * this.zoom, h: 64 * this.zoom, depth });
        },
      });
    }
  }

  /** A world object's art (a chest, a sign, the waypoint, the crafting station), scaled to its height. */
  private objectArt(f: FeatureDef): HTMLCanvasElement | null {
    const o = OBJECT_ART[f.kind];
    if (!o) return null;
    const img = loadImage(this.client.assetUrl(o.key));
    return img ? sizedSprite(img, o.key, o.height * PX_PER_METRE) : null;
  }

  /**
   * The ground mark of a feature. A way out: cool light with chevrons flowing toward where it leads. A thing a quest
   * asks about: warm gold light, a slow ripple and the quest sign over it. Others (notes, signs, traps): a soft ring
   * (dashed and red for a trap).
   */
  private groundMark(f: FeatureDef, alpha: number, trap: boolean) {
    if (f.kind === 'exit') return this.exitMark(f, alpha);
    if (f.kind === 'object') return this.questMark(f, alpha);
    const ctx = this.ctx;
    const p = pic(f.x, f.y);
    const color = trap ? '255,70,50' : f.kind === 'lore' ? '255,226,140' : '200,230,255';
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(${color},${Math.min(1, alpha)})`;
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 10;
    if (trap) {
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -this.t * 14;
    }
    ctx.beginPath();
    ctx.arc(0, 0, (trap ? 0.7 : 0.55) * M, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    if (f.kind === 'lore') this.floatingLight(p, alpha, color);
  }

  /** A soft light on the ground, a disc of `r` metres. */
  private groundGlow(p: Vec2, r: number, color: string, alpha: number) {
    const g = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * M);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    this.ctx.fillStyle = g;
    this.ctx.fillRect(p.x - r * M, p.y - r * M, 2 * r * M, 2 * r * M);
  }

  private exitMark(f: FeatureDef, alpha: number) {
    const ctx = this.ctx, z = this.client.state.zone!;
    const p = pic(f.x, f.y), color = '175,215,255';
    this.groundGlow(p, 1.1, color, 0.3 * Math.max(alpha, 0.5));
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 8;
    const a = Math.min(1, alpha * 1.4);
    // A way across the edge: chevrons flowing off the map, straight out from the nearest edge.
    const edges = [
      { d: f.x, ux: -1, uy: 0 },
      { d: z.width - f.x, ux: 1, uy: 0 },
      { d: f.y, ux: 0, uy: -1 },
      { d: z.height - f.y, ux: 0, uy: 1 },
    ];
    const out = edges.reduce((m, e) => (e.d < m.d ? e : m));
    if (out.d < 8) {
      for (let i = 0; i < 3; i++) {
        const ph = (this.t * 0.7 + i / 3) % 1;
        const at = pic(f.x + out.ux * (ph * 1.2 - 0.5), f.y + out.uy * (ph * 1.2 - 0.5));
        const w = 0.32 * M, back = 0.2 * M;
        ctx.strokeStyle = `rgba(${color},${(Math.sin(ph * Math.PI) * a).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(at.x - out.ux * back - out.uy * w, at.y - out.uy * back + out.ux * w);
        ctx.lineTo(at.x, at.y);
        ctx.lineTo(at.x - out.ux * back + out.uy * w, at.y - out.uy * back - out.ux * w);
        ctx.stroke();
      }
    } else {
      // A way in drawn inside the place (a door, a cave mouth): rings closing in on it.
      for (let i = 0; i < 2; i++) {
        const ph = (this.t * 0.6 + i / 2) % 1;
        ctx.strokeStyle = `rgba(${color},${(Math.sin(ph * Math.PI) * a).toFixed(3)})`;
        this.groundCircle(f.x, f.y, 0.95 - ph * 0.7);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private questMark(f: FeatureDef, alpha: number) {
    const ctx = this.ctx, p = pic(f.x, f.y), color = '255,205,90';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.groundGlow(p, 0.8, color, 0.4 * Math.max(alpha, 0.5));
    ctx.restore();
    // A ripple spreading slowly from it.
    const ph = (this.t / 1.8) % 1;
    ctx.save();
    ctx.strokeStyle = `rgba(${color},${(0.7 * (1 - ph)).toFixed(3)})`;
    ctx.lineWidth = 2;
    this.groundCircle(f.x, f.y, 0.3 + ph * 0.7);
    ctx.stroke();
    ctx.restore();
    // The quest sign: a gold diamond with a "!", bobbing over it.
    const y = p.y - 46 + Math.sin(this.t * 2.2 + f.x) * 4, s = 11;
    ctx.save();
    ctx.translate(p.x, y);
    ctx.shadowColor = 'rgba(255,200,80,0.9)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(255,214,110,0.95)';
    ctx.strokeStyle = 'rgba(90,55,10,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.fillStyle = 'rgba(70,40,5,0.95)';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 0, 1);
    ctx.restore();
  }

  /** A small light hovering over a note one can read. */
  private floatingLight(p: Vec2, alpha: number, color: string) {
    const ctx = this.ctx;
    const y = p.y - 26 + Math.sin(this.t * 2.2 + p.x) * 4;
    const g = ctx.createRadialGradient(p.x, y, 0, p.x, y, 12);
    g.addColorStop(0, `rgba(255,248,210,${alpha})`);
    g.addColorStop(0.35, `rgba(${color},${alpha * 0.6})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.x - 12, y - 12, 24, 24);
  }

  private collectLoot(list: Drawable[]) {
    const ctx = this.ctx;
    const spr = lootSprite();
    for (const l of this.client.state.lootPiles) {
      const p = pic(l.x, l.y);
      const depth = l.y + 0.01;
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
      a.px = nx;
      a.py = ny;
      a.moving = target.moving || moved > 0.004;
      a.amt = Math.max(0, Math.min(1, a.amt + (a.moving ? dt * 7 : -dt * 5)));
      // Stride about 0.9 m per cycle; keep the phase running while easing out so legs settle.
      if (a.amt > 0) a.walk += (gap > 2.5 ? 0 : moved) * 7 + (a.moving ? 0 : dt * 2);
      // Turn smoothly toward the direction of travel.
      const dFace = Math.atan2(Math.sin(target.facing - a.face), Math.cos(target.facing - a.face));
      a.face += dFace * Math.min(1, dt * 14);
      a.hurt = Math.max(0, a.hurt - dt);
      a.attack = Math.max(0, a.attack - dt * 2.5);
      if (e.dead) a.death = Math.min(1, a.death + dt * 1.2);
      a.fade = Math.min(1, a.fade + dt * 3);
      const p = pic(a.px, a.py);
      // A still sprite faces left or right as it goes (the map is top-down: ground x is screen x).
      const fx = Math.cos(a.face);
      if (fx < -0.3) a.dir = -1;
      else if (fx > 0.3) a.dir = 1;
      const anim = this.actorAnim(e.sprite);
      if (anim) advance(a.motion, anim, dt, a.moving && gap <= 2.5, gap > 2.5 || !dt ? 0 : moved / dt, !!(e.dead || e.downed));
      const dir = a.dir;
      const depth = a.py + 0.05;
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
            ctx.scale(1, SHADOW_FLAT);
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
          const height = 1.75 * PX_PER_METRE * e.scale;
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
            else drawPlaceholder(g, height, e.downed);
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
   * as an ellipse flattened as the figures' camera sees the ground, a dark core under the feet and a wider
   * penumbra, in the place's own shadow colour.
   */
  private contactShadow(r: number, l: FigureLight) {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(1, SHADOW_FLAT);
    const R = r * M * 1.25;
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
      const s = this.groundToScreen(f.x, f.y, (OBJECT_ART[f.kind]?.height ?? 1) * PX_PER_METRE + 12);
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
      const p = pic(s.x, s.y);
      const base = { fire: '#ff6a1a', poison: '#6ac02a', water: '#3a80e0', ice: '#cfefff', oil: '#3a2a1a', blessed: '#ffe680' }[s.type] ?? '#a0a0a0';
      const flick = s.type === 'fire' ? 0.45 + Math.sin(this.t * 12 + s.x * 3) * 0.12 : s.type === 'blessed' ? 0.35 + Math.sin(this.t * 2) * 0.08 : 0.42;
      ctx.save();
      ctx.translate(p.x, p.y);
      const r = M * 0.7;
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

  /** A circle on the ground around (x, y), `r` metres across. */
  private groundCircle(x: number, y: number, r: number) {
    const ctx = this.ctx;
    const c = pic(x, y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * M, 0, Math.PI * 2);
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
          const a = pic(segs[i]!, segs[i + 1]!), c = pic(segs[i + 2]!, segs[i + 3]!);
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
          const s0 = pic(active!.x, active!.y);
          ctx.moveTo(s0.x, s0.y);
          for (const t of path) {
            const s = pic(t.x, t.y);
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
      const s = pic(p.x, p.y);
      const k = Math.max(0, p.life / p.max);
      if (p.kind === 'ring') {
        const r = (1 - k) * (p.r ?? 1) * M + 6;
        ctx.save();
        ctx.translate(s.x, s.y);
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
        const a = pic(pr.x0, pr.y0), b = pic(pr.x1, pr.y1);
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
      const s = pic(x, y);
      ctx.globalAlpha = 1;
      if (pr.kind === 'arrow') {
        const a = pic(pr.x0, pr.y0), b = pic(pr.x1, pr.y1);
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
      const s = pic(p.x, p.y);
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
    // Dusk and dawn are a soft amber shading into the night's blue (a strong red read as a red cast on the world).
    return { darkness: night * 0.62 + dusk * 0.1, tint: mix([10, 16, 48], [96, 70, 44], dusk * 0.7) };
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
      const r = metres * M * 0.7 * this.zoom * (1 + flicker);
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
      if (f.kind === 'waypoint' || (f.kind === 'object' && this.client.questThingOpen(f.id)) || (f.kind === 'lore' && !st.features.get(f.id)?.opened)) {
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
      const r = g.r * M * 0.7 * this.zoom;
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
    // What the party sees from: its own figures and, in a fight, everyone in it (a fight is never in the dark).
    const party = [...st.entities.values()].filter((e) => e.ownerUserId === st.userId || (st.combat && e.inCombat && !e.dead)).map((e) => this.client.entityPos(e));
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
        // Remembered-but-unseen ground dims smoothly past sight range (11 m, as far as the party uncovers).
        write(x, y, false, d > 16 ? 0.45 : d > 11 ? ((d - 11) / 5) ** 1.5 * 0.45 : 0);
      }
  }

  /** This frame's mist (see mist.ts), shared by its two passes. */
  private mistFrame: MistFrame | null = null;

  /**
   * Per square metre for the mist (null where there is no fog of war): unexplored, how much of it no one can walk
   * (set once per place: the edge's veil lies thickest there), and remembered-but-unseen.
   */
  private fogOfWar(z: ZoneData): { data: Uint8Array; w: number; h: number } | null {
    if (!this.client.state.explored) return null;
    const { w, h } = fogSize(z);
    const key = `${this.zoneKey}:${w}x${h}`;
    if (this.fogBytes?.key !== key) {
      const data = new Uint8Array(w * h * 4);
      const nav = z.walk, per = Math.round(1 / NAV_CELL);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let open = 0;
          for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) if (nav.walkableCell(x * per + i, y * per + j)) open++;
          data.set([255, Math.round(255 * (1 - open / (per * per))), 0, 0], (y * w + x) * 4);
        }
      this.fogBytes = { key, data, w, h };
    }
    const data = this.fogBytes.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    this.visibleFog(w, h, (x, y, unseen, dim) => {
      data[(y * w + x) * 4] = unseen ? 255 : 0;
      data[(y * w + x) * 4 + 3] = Math.round(dim * 255);
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
      const c = pic(this.camX, this.camY);
      this.mistFrame = {
        W: this.W, H: this.H, camX: c.x, camY: c.y, zoom: this.zoom, t: this.t, fog: this.fogOfWar(z),
        rect: [-z.painting.ox, -z.painting.oy, z.painting.width - z.painting.ox, z.painting.height - z.painting.oy],
        base: hexToRgb(z.look.fogColor),
        tint: key.map((v) => Math.min(255, (0.7 + (0.3 * v) / km) * (0.55 + level * 0.8) * 255)) as RGB,
        tile: z.look.mist ? loadImage(this.client.assetUrl(z.look.mist)) : null,
        party: [...st.entities.values()].filter((e) => e.ownerUserId === st.userId).map((e) => {
          const a = this.anims.get(e.id);
          return pic(a?.px ?? e.x, a?.py ?? e.y);
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
    for (let i = 0; i < w * h; i++) img.data.set([r * 0.35, g * 0.35, b * 0.35, fog.data[i * 4]! || fog.data[i * 4 + 3]!], i * 4);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    const fc = this.fogCanvas;
    const f = fc.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, fc.width, fc.height);
    const sc = fc.width / this.W;
    const o = this.groundToScreen(0, 0);
    const k = this.zoom * sc;
    // Square metre (x, y) maps to screen (x·M, y·M); pixel corners sit half a metre before the centres.
    f.setTransform(M * k, 0, 0, M * k, o.x * sc, o.y * sc);
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
