/** Soft coloured outlines around sprites: what can be used (gold), spotted traps (red). */

const cache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();
const PAD = 6;

/** An outline canvas for `src` (cached): the sprite's silhouette grown by a few pixels and blurred, in `color`. */
export function outlineOf(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  let byColor = cache.get(src);
  if (!byColor) cache.set(src, (byColor = new Map()));
  const hit = byColor.get(color);
  if (hit) return hit;
  const w = src.width + PAD * 2, h = src.height + PAD * 2;
  // Solid silhouette in the outline colour.
  const sil = document.createElement('canvas');
  sil.width = src.width;
  sil.height = src.height;
  const sc = sil.getContext('2d')!;
  sc.drawImage(src, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = color;
  sc.fillRect(0, 0, sil.width, sil.height);
  // Grow it in every direction, soften, then cut the sprite itself out so only the rim remains.
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const oc = out.getContext('2d')!;
  oc.filter = 'blur(1.5px)';
  for (let a = 0; a < 12; a++) oc.drawImage(sil, PAD + Math.cos((a / 12) * Math.PI * 2) * 2.5, PAD + Math.sin((a / 12) * Math.PI * 2) * 2.5);
  oc.filter = 'none';
  oc.globalCompositeOperation = 'destination-out';
  oc.drawImage(src, PAD, PAD);
  byColor.set(color, out);
  return out;
}

/** Draw the outline for a sprite drawn at (x, y) top-left. */
export function drawOutline(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  const o = outlineOf(src, color);
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(o, x - PAD, y - PAD);
  ctx.restore();
}

export const HIGHLIGHT = { use: '#ffd877', trap: '#ff4a3a', loot: '#ffe08a' };
