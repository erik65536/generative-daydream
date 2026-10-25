/** Drawing painted figures: loading their images, a still sprite's bob and lean, a placeholder while one loads. */

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

/**
 * A plain standing silhouette `h` px tall at the current origin (its feet): shown only while a figure's painting
 * loads, or for one whose painting failed.
 */
export function drawPlaceholder(ctx: CanvasRenderingContext2D, h: number, downed = false) {
  ctx.save();
  if (downed) ctx.rotate(Math.PI / 2);
  ctx.fillStyle = 'rgba(20, 22, 30, 0.55)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(-h * 0.16, -h * 0.78, h * 0.32, h * 0.78, h * 0.12);
  ctx.arc(0, -h * 0.87, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
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

/** 'ok' once decoded, 'error' if it failed (draw the placeholder), 'loading' meanwhile. */
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

/**
 * A still sprite (an actor without clip sheets yet, see actors.ts): the painted standing view, mirrored to face
 * the way it goes, with a breathing bob, a step bounce and a lean while walking, a lunge for an attack.
 */
export function drawImageSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, opts: { height: number; dir: 1 | -1; walk: number; amt?: number; t: number; downed?: boolean; hurt?: number; attack?: number }) {
  const walking = !Number.isNaN(opts.walk);
  const m = walking ? opts.amt ?? 1 : 0;
  const h = opts.height;
  const w = (img.naturalWidth / img.naturalHeight) * h;
  // Idle breathing blended with a walking gait: a rise on each step, a slight compression at foot-fall.
  const idleBob = Math.sin(opts.t * 2) * 0.6, idleSq = 1 + Math.sin(opts.t * 2) * 0.008;
  const stepBob = walking ? Math.abs(Math.sin(opts.walk)) * 2.6 : 0;
  const stepSq = walking ? 1 - Math.pow(Math.cos(opts.walk), 8) * 0.035 : 1;
  const bob = idleBob * (1 - m) + stepBob * m;
  const squash = idleSq * (1 - m) + stepSq * m;
  ctx.save();
  if (opts.downed) {
    ctx.rotate(Math.PI / 2);
    ctx.globalAlpha *= 0.85;
  }
  if (opts.hurt && opts.hurt > 0) ctx.translate(Math.sin(opts.hurt * 40) * 2.5, 0);
  // Lean into the direction of travel plus a gentle side-to-side sway per step, and into a blow.
  const lean = opts.attack ? Math.sin(opts.attack * Math.PI) * 0.18 : walking ? (0.05 + Math.sin(opts.walk) * 0.025) * m : 0;
  ctx.rotate(lean * opts.dir);
  // Painted characters face left (as their art direction asks): mirrored to go right.
  ctx.scale(-opts.dir, 1);
  // Widen slightly as it squashes, so the volume reads as constant.
  const wq = w * (1 + (1 - squash) * 0.6);
  ctx.drawImage(img, -wq / 2, -h * squash - bob, wq, h * squash);
  ctx.restore();
}
