/** Procedural, animated character and creature figures, plus generated-image sprite drawing. */
import { hexToRgb, mix, rgb, shade, strHash } from './textures';

export interface FigureOpts {
  shape: 'humanoid' | 'beast' | 'blob' | 'flyer' | 'hulk';
  colors: string[];
  scale: number;
  /** Screen-space facing: +1 right, -1 left. */
  dir: 1 | -1;
  back: boolean;
  /** Walk phase in radians; NaN when idle. */
  walk: number;
  /** 0..1 how far into the walking pose (eases starts and stops). */
  amt?: number;
  t: number;
  weapon?: string;
  archetype?: string;
  seed: string;
  downed?: boolean;
  hurt?: number;
  attack?: number;
  /** Visual role hints. */
  role?: string;
  kind?: string;
  /** Player heroes: hair length follows the chosen presentation. */
  presentation?: string;
}

const SKIN: [number, number, number][] = [[238, 205, 170], [214, 170, 128], [176, 126, 88], [130, 88, 60], [96, 64, 44]];

function grad(ctx: CanvasRenderingContext2D, x0: number, x1: number, c: [number, number, number]) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, rgb(shade(c, 1.2)));
  g.addColorStop(0.55, rgb(c));
  g.addColorStop(1, rgb(shade(c, 0.6)));
  return g;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawShadow(ctx: CanvasRenderingContext2D, w: number, a = 0.38) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.scale(1, 0.45);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, w, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function weaponDraw(ctx: CanvasRenderingContext2D, w: string | undefined, accent: [number, number, number], t: number, attack: number) {
  const swing = attack > 0 ? Math.sin(attack * Math.PI) * 1.4 : 0;
  ctx.save();
  ctx.rotate(-0.5 + swing);
  switch (w) {
    case 'bow':
      ctx.rotate(0.5 - swing);
      ctx.strokeStyle = '#6b4a2a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(4, -2, 14, -1.2, 1.2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(230,230,220,0.8)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(4 + Math.cos(-1.2) * 14, -2 + Math.sin(-1.2) * 14);
      ctx.lineTo(4 + Math.cos(1.2) * 14, -2 + Math.sin(1.2) * 14);
      ctx.stroke();
      break;
    case 'staff':
    case 'wand': {
      const len = w === 'staff' ? 38 : 16;
      ctx.rotate(0.4 - swing * 0.5);
      ctx.strokeStyle = '#5a3d22';
      ctx.lineWidth = w === 'staff' ? 2.6 : 2;
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.lineTo(0, -len);
      ctx.stroke();
      ctx.shadowColor = rgb(accent);
      ctx.shadowBlur = 10 + Math.sin(t * 4) * 4;
      ctx.fillStyle = rgb(shade(accent, 1.3));
      ctx.beginPath();
      ctx.arc(0, -len - 3, w === 'staff' ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'axe':
      ctx.strokeStyle = '#5a3d22';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.lineTo(0, -28);
      ctx.stroke();
      ctx.fillStyle = '#c8ccd4';
      ctx.beginPath();
      ctx.moveTo(0, -28);
      ctx.quadraticCurveTo(14, -30, 12, -16);
      ctx.lineTo(0, -20);
      ctx.fill();
      break;
    case 'dagger':
      ctx.fillStyle = '#d8dce4';
      ctx.beginPath();
      ctx.moveTo(-1.6, 0);
      ctx.lineTo(0, -14);
      ctx.lineTo(1.6, 0);
      ctx.fill();
      ctx.fillStyle = '#6b4a2a';
      ctx.fillRect(-3, 0, 6, 2);
      break;
    default:
      // sword
      ctx.fillStyle = '#dfe3ea';
      ctx.beginPath();
      ctx.moveTo(-2, 0);
      ctx.lineTo(-1.5, -26);
      ctx.lineTo(0, -30);
      ctx.lineTo(1.5, -26);
      ctx.lineTo(2, 0);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(-0.4, -26, 0.8, 24);
      ctx.fillStyle = rgb(accent);
      ctx.fillRect(-6, 0, 12, 2.5);
      ctx.fillStyle = '#4a3020';
      ctx.fillRect(-1.5, 2, 3, 6);
  }
  ctx.restore();
}

function humanoid(ctx: CanvasRenderingContext2D, o: FigureOpts, big = false) {
  const h = strHash(o.seed);
  const main = hexToRgb(o.colors[0] ?? '#5a6a8a');
  const second = hexToRgb(o.colors[1] ?? '#3a3040');
  const accent = hexToRgb(o.colors[2] ?? '#e0c060');
  const skin = o.kind === 'monster' ? mix(main, [200, 200, 180], 0.25) : SKIN[h % SKIN.length]!;
  const hair = o.kind === 'monster' ? shade(second, 0.8) : ([[40, 30, 25], [90, 60, 30], [160, 110, 60], [200, 180, 140], [60, 60, 70], [140, 50, 30]] as [number, number, number][])[(h >>> 3) % 6]!;
  const k = big ? 1.35 : 1;
  const walking = !Number.isNaN(o.walk);
  const sw = walking ? Math.sin(o.walk) * (o.amt ?? 1) : 0;
  const bob = walking ? Math.abs(Math.cos(o.walk)) * 1.6 * (o.amt ?? 1) : Math.sin(o.t * 2 + (h % 7)) * 0.5;
  const hooded = o.archetype === 'caster' || o.archetype === 'healer' || o.weapon === 'staff' || o.weapon === 'wand' || (h & 1) === 1 && o.archetype === 'assassin';
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(0, -bob);
  // Legs
  const legC = shade(second, 0.75);
  ctx.fillStyle = rgb(legC);
  ctx.save();
  ctx.translate(-3.5, -18);
  ctx.rotate(sw * 0.45);
  rr(ctx, -2.4, 0, 5, 18, 2);
  ctx.fill();
  ctx.fillStyle = rgb(shade(legC, 0.6));
  rr(ctx, -2.8, 15, 6, 4, 1.5);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = rgb(shade(legC, 0.9));
  ctx.save();
  ctx.translate(3.5, -18);
  ctx.rotate(-sw * 0.45);
  rr(ctx, -2.4, 0, 5, 18, 2);
  ctx.fill();
  ctx.fillStyle = rgb(shade(legC, 0.6));
  rr(ctx, -2.8, 15, 6, 4, 1.5);
  ctx.fill();
  ctx.restore();
  // Back arm
  ctx.fillStyle = rgb(shade(main, 0.7));
  ctx.save();
  ctx.translate(-7, -36);
  ctx.rotate(-sw * 0.5);
  rr(ctx, -2.2, 0, 4.4, 15, 2);
  ctx.fill();
  ctx.restore();
  // Torso / robe
  ctx.fillStyle = grad(ctx, -10, 10, main);
  ctx.beginPath();
  if (hooded) {
    ctx.moveTo(-8, -38);
    ctx.lineTo(8, -38);
    ctx.lineTo(11, -12);
    ctx.quadraticCurveTo(0, -9, -11, -12);
  } else {
    ctx.moveTo(-8.5, -38);
    ctx.lineTo(8.5, -38);
    ctx.lineTo(7, -17);
    ctx.lineTo(-7, -17);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgb(shade(second, 0.9));
  ctx.fillRect(-7.5, -21, 15, 3);
  ctx.fillStyle = rgb(accent);
  ctx.fillRect(-1.5, -21, 3, 3);
  if (!o.back) {
    ctx.strokeStyle = rgb(shade(main, 1.3), 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.lineTo(0, -22);
    ctx.stroke();
  }
  // Head
  ctx.fillStyle = rgb(skin);
  ctx.beginPath();
  ctx.arc(0, -44, 6.2, 0, Math.PI * 2);
  ctx.fill();
  if (hooded) {
    ctx.fillStyle = grad(ctx, -8, 8, shade(main, 0.9));
    ctx.beginPath();
    ctx.moveTo(-7.5, -38);
    ctx.quadraticCurveTo(-9, -52, 0, -53);
    ctx.quadraticCurveTo(9, -52, 7.5, -38);
    if (!o.back) {
      ctx.quadraticCurveTo(4, -44, 0, -45);
      ctx.quadraticCurveTo(-4, -44, -7.5, -38);
    }
    ctx.fill();
  } else {
    ctx.fillStyle = rgb(hair);
    // Longer hair falls behind the shoulders (feminine) or to the jaw (androgynous).
    const len = o.presentation === 'feminine' ? 9 : o.presentation === 'androgynous' ? 4 : 0;
    if (len) {
      ctx.beginPath();
      ctx.moveTo(-6.6, -46);
      ctx.quadraticCurveTo(-8.2, -44 + len * 0.6, -6.2, -40 + len);
      ctx.lineTo(6.2, -40 + len);
      ctx.quadraticCurveTo(8.2, -44 + len * 0.6, 6.6, -46);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    if (o.back) ctx.arc(0, -44.5, 6.6, 0, Math.PI * 2);
    else {
      ctx.arc(0, -45.5, 6.4, Math.PI * 1.02, Math.PI * 1.98);
      ctx.lineTo(4, -44);
      ctx.quadraticCurveTo(0, -47, -4, -44.5);
    }
    ctx.fill();
  }
  if (!o.back) {
    ctx.fillStyle = o.kind === 'monster' ? rgb(shade(accent, 1.3)) : 'rgba(30,20,20,0.9)';
    if (o.kind === 'monster') {
      ctx.shadowColor = rgb(accent);
      ctx.shadowBlur = 4;
    }
    ctx.fillRect(1.2, -45, 1.6, 1.6);
    ctx.fillRect(-3.4, -45, 1.6, 1.6);
    ctx.shadowBlur = 0;
  }
  // Front arm + weapon
  ctx.save();
  ctx.translate(7, -36);
  ctx.rotate(sw * 0.5 - (o.attack ? Math.sin(o.attack * Math.PI) * 1.2 : 0));
  ctx.fillStyle = rgb(shade(main, 0.95));
  rr(ctx, -2.2, 0, 4.4, 15, 2);
  ctx.fill();
  ctx.fillStyle = rgb(skin);
  ctx.beginPath();
  ctx.arc(0, 15, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(0, 15);
  weaponDraw(ctx, o.weapon ?? (o.archetype === 'archer' ? 'bow' : o.archetype === 'caster' || o.archetype === 'healer' ? 'staff' : o.archetype === 'assassin' ? 'dagger' : o.archetype === 'brute' || o.archetype === 'guardian' ? 'axe' : undefined), accent, o.t, o.attack ?? 0);
  ctx.restore();
  ctx.restore();
}

function beast(ctx: CanvasRenderingContext2D, o: FigureOpts) {
  const main = hexToRgb(o.colors[0] ?? '#7a7068');
  const second = hexToRgb(o.colors[1] ?? '#4a4440');
  const eye = hexToRgb(o.colors[2] ?? '#ffcc40');
  const walking = !Number.isNaN(o.walk);
  const sw = walking ? Math.sin(o.walk * 1.4) : 0;
  const breathe = Math.sin(o.t * 3) * 0.6;
  ctx.save();
  // Legs
  ctx.fillStyle = rgb(shade(second, 0.8));
  for (const [x, ph] of [[-10, 0], [-5, Math.PI], [7, Math.PI], [12, 0]] as const) {
    ctx.save();
    ctx.translate(x, -12);
    ctx.rotate(Math.sin(o.walk * 1.4 + ph) * (walking ? 0.5 : 0));
    rr(ctx, -2, 0, 4, 12, 2);
    ctx.fill();
    ctx.restore();
  }
  // Tail
  ctx.strokeStyle = rgb(shade(main, 0.8));
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-14, -20);
  ctx.quadraticCurveTo(-24, -26 + sw * 3, -26, -16 + Math.sin(o.t * 4) * 3);
  ctx.stroke();
  // Body
  ctx.fillStyle = grad(ctx, -16, 16, main);
  ctx.beginPath();
  ctx.ellipse(0, -20 - breathe * 0.5, 16, 9 + breathe * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgb(shade(main, 1.2), 0.5);
  ctx.beginPath();
  ctx.ellipse(-2, -25, 10, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Head
  const hx = 15, hy = -26 + (o.attack ? -Math.sin(o.attack * Math.PI) * 4 : 0);
  ctx.fillStyle = grad(ctx, hx - 8, hx + 8, main);
  ctx.beginPath();
  ctx.ellipse(hx, hy, 8, 7, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(hx + 7, hy + 2, 5, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgb(shade(second, 0.9));
  ctx.beginPath();
  ctx.moveTo(hx - 4, hy - 5);
  ctx.lineTo(hx - 2, hy - 13);
  ctx.lineTo(hx + 1, hy - 5);
  ctx.fill();
  ctx.fillStyle = rgb(eye);
  ctx.shadowColor = rgb(eye);
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.arc(hx + 3, hy - 1.5, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function blobShape(ctx: CanvasRenderingContext2D, o: FigureOpts) {
  const main = hexToRgb(o.colors[0] ?? '#6aa040');
  const eye = hexToRgb(o.colors[2] ?? '#ffffff');
  const walking = !Number.isNaN(o.walk);
  const sq = walking ? Math.sin(o.walk * 2) * 0.12 : Math.sin(o.t * 3) * 0.05;
  ctx.save();
  ctx.scale(1 + sq, 1 - sq);
  const g = ctx.createRadialGradient(-4, -16, 2, 0, -10, 16);
  g.addColorStop(0, rgb(shade(main, 1.4), 0.95));
  g.addColorStop(0.7, rgb(main, 0.92));
  g.addColorStop(1, rgb(shade(main, 0.55), 0.92));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.quadraticCurveTo(-16, -22, 0, -24);
  ctx.quadraticCurveTo(16, -22, 14, 0);
  ctx.quadraticCurveTo(0, 3, -14, 0);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.ellipse(-5, -17, 4, 2.5, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgb(eye);
  ctx.beginPath();
  ctx.arc(-3.5, -11, 2.6, 0, Math.PI * 2);
  ctx.arc(4, -11, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(-3, -11, 1.2, 0, Math.PI * 2);
  ctx.arc(4.5, -11, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function flyer(ctx: CanvasRenderingContext2D, o: FigureOpts) {
  const main = hexToRgb(o.colors[0] ?? '#40404a');
  const second = hexToRgb(o.colors[1] ?? '#202028');
  const eye = hexToRgb(o.colors[2] ?? '#ff5040');
  const hover = -26 + Math.sin(o.t * 3) * 3;
  const flap = Math.sin(o.t * 14);
  ctx.save();
  ctx.translate(0, hover);
  ctx.fillStyle = rgb(shade(second, 0.9), 0.95);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.quadraticCurveTo(side * 14, -14 - flap * 8, side * 24, -4 - flap * 10);
    ctx.quadraticCurveTo(side * 14, 0, 0, 2);
    ctx.fill();
  }
  ctx.fillStyle = grad(ctx, -6, 6, main);
  ctx.beginPath();
  ctx.ellipse(0, 0, 6, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgb(eye);
  ctx.shadowColor = rgb(eye);
  ctx.shadowBlur = 6;
  ctx.fillRect(-3, -4, 2, 2);
  ctx.fillRect(1.5, -4, 2, 2);
  ctx.restore();
}

/** Draw a figure at the current transform origin (feet). */
export function drawFigure(ctx: CanvasRenderingContext2D, o: FigureOpts) {
  ctx.save();
  ctx.scale(o.scale * o.dir, o.scale);
  if (o.downed) {
    ctx.rotate(Math.PI / 2 * 0.95);
    ctx.translate(-6, 10);
    ctx.globalAlpha *= 0.85;
  }
  if (o.hurt && o.hurt > 0) ctx.translate(Math.sin(o.hurt * 40) * 2, 0);
  switch (o.shape) {
    case 'beast':
      beast(ctx, o);
      break;
    case 'blob':
      blobShape(ctx, o);
      break;
    case 'flyer':
      flyer(ctx, o);
      break;
    case 'hulk':
      humanoid(ctx, o, true);
      break;
    default:
      humanoid(ctx, o, false);
  }
  ctx.restore();
}

// ------------------------------------------------------------------------- image sprites

const images = new Map<string, HTMLImageElement | null>();

export function loadImage(url: string | undefined): HTMLImageElement | null {
  if (!url) return null;
  if (images.has(url)) {
    const img = images.get(url)!;
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }
  const img = new Image();
  img.src = url;
  images.set(url, img);
  img.onerror = () => {
    images.set(url, null);
    flushWaiters(url);
  };
  img.onload = () => flushWaiters(url);
  return null;
}

const waiters = new Map<string, (() => void)[]>();
function flushWaiters(url: string) {
  for (const cb of waiters.get(url) ?? []) cb();
  waiters.delete(url);
}

/** 'ok' once decoded, 'error' if it failed (draw the procedural figure), 'loading' meanwhile. */
export function imageState(url: string | undefined): 'none' | 'loading' | 'ok' | 'error' {
  if (!url) return 'none';
  if (!images.has(url)) loadImage(url);
  const img = images.get(url);
  if (img === null) return 'error';
  return img && img.complete && img.naturalWidth > 0 ? 'ok' : 'loading';
}

/** Call `cb` once the image finishes loading (or fails). */
export function onImageSettled(url: string, cb: () => void) {
  if (imageState(url) !== 'loading') return cb();
  waiters.set(url, [...(waiters.get(url) ?? []), cb]);
}

/** Painted pose frames of a generated character (each with its height relative to the standing pose). */
export interface PoseFrames {
  /** A walk-cycle strip: `frames` equal frames side by side, one full stride pair. */
  walk?: { img: HTMLImageElement; rel: number; frames: number };
  walk_a?: { img: HTMLImageElement; rel: number };
  walk_b?: { img: HTMLImageElement; rel: number };
  attack?: { img: HTMLImageElement; rel: number };
}

/** Painted walk-cycle speed relative to the gait phase. */
const STRIP_PACE = 0.7;

export function drawImageSprite(ctx: CanvasRenderingContext2D, base: HTMLImageElement, opts: { height: number; dir: 1 | -1; walk: number; amt?: number; t: number; downed?: boolean; hurt?: number; attack?: number; frames?: PoseFrames }) {
  const walking = !Number.isNaN(opts.walk);
  const m = walking ? opts.amt ?? 1 : 0;
  // Pick the painted frame: a four-beat walk (stride, pass, other stride, pass) and the attack pose.
  let img = base, rel = 1;
  /** Source rectangle within `img` (a strip frame), or the whole image. */
  let src: [number, number, number, number] | null = null;
  const f = opts.frames;
  const striking = !!opts.attack && opts.attack > 0.08 && opts.attack < 0.92;
  const cycle = walking && m > 0.3 && f?.walk && f.walk.img.complete && f.walk.img.naturalWidth > 0;
  if (f?.attack && striking) ({ img, rel } = f.attack);
  else if (cycle) {
    // One period of the walk phase is a full cycle (two steps): pick the frame for this moment of it.
    const n = f!.walk!.frames;
    // The gait phase runs at the procedural bob's pace; a painted cycle covers about 1.3 tiles, so feet don't skate.
    const t = opts.walk * STRIP_PACE;
    const phase = (((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
    const i = Math.floor(phase * n) % n;
    img = f!.walk!.img;
    rel = f!.walk!.rel;
    const fw = img.naturalWidth / n;
    src = [i * fw, 0, fw, img.naturalHeight];
  } else if (walking && m > 0.3 && f?.walk_a && f.walk_b) {
    const s = Math.sin(opts.walk);
    if (s > 0.38) ({ img, rel } = f.walk_a);
    else if (s < -0.38) ({ img, rel } = f.walk_b);
  }
  const framed = img !== base;
  const h = opts.height * rel;
  const w = ((src ? src[2] : img.naturalWidth) / img.naturalHeight) * h;
  // Idle breathing blended with a walking gait: a rise on each step, a slight compression at foot-fall.
  const idleBob = Math.sin(opts.t * 2) * 0.6, idleSq = 1 + Math.sin(opts.t * 2) * 0.008;
  // A painted walk cycle carries its own rise and fall: the procedural bounce is only for still poses.
  const stepBob = walking ? Math.abs(Math.sin(opts.walk)) * (src ? 0.4 : 2.6) : 0;
  const stepSq = walking && !src ? 1 - Math.pow(Math.cos(opts.walk), 8) * 0.035 : 1;
  const bob = idleBob * (1 - m) + stepBob * m;
  const squash = idleSq * (1 - m) + stepSq * m;
  ctx.save();
  if (opts.downed) {
    ctx.rotate(Math.PI / 2);
    ctx.globalAlpha *= 0.85;
  }
  if (opts.hurt && opts.hurt > 0) ctx.translate(Math.sin(opts.hurt * 40) * 2.5, 0);
  // Lean into the direction of travel plus a gentle side-to-side sway per step (painted poses lean less: the pose does it).
  const lean = opts.attack ? Math.sin(opts.attack * Math.PI) * (framed ? 0.05 : 0.18) : walking ? (framed ? 0.02 : 0.05 + Math.sin(opts.walk) * 0.025) * m : 0;
  // A painted strike lunges forward a little.
  if (framed && striking) ctx.translate(Math.sin(opts.attack! * Math.PI) * 6 * opts.dir, 0);
  ctx.rotate(lean * opts.dir);
  // Painted characters face left (as their art direction asks): mirrored to go right.
  ctx.scale(-opts.dir, 1);
  // Widen slightly as it squashes, so the volume reads as constant.
  const wq = w * (1 + (1 - squash) * 0.6);
  if (src) ctx.drawImage(img, src[0], src[1], src[2], src[3], -wq / 2, -h * squash - bob, wq, h * squash);
  else ctx.drawImage(img, -wq / 2, -h * squash - bob, wq, h * squash);
  ctx.restore();
}
