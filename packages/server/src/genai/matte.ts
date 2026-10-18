/**
 * Sprite post-processing: cut the subject out, clean the alpha matte (models with native transparency still
 * leave haze, fog and glows around a subject, or an opaque backdrop panel), detect leftovers, trim and scale.
 */
import sharp from 'sharp';

export interface ProcessedImage {
  png: Buffer;
  width: number;
  height: number;
  anchorY?: number;
  /** Trimmed subject height as a fraction of the raw canvas height (pose frames are scaled by it). */
  figureRatio?: number;
  /** Automatic heuristic problems that call for another attempt (no vision model needed). */
  problems: string[];
  /** Softer concerns that lower the score but do not force a retry. */
  notes?: string[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flood-fill the background inward from a rectangle's border (by its dominant border colours) and clear it. */
function floodCutout(data: Buffer, w: number, h: number, tolerance: number, rect: Rect = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }): number {
  const px = (x: number, y: number) => (y * w + x) * 4;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const sample = (x: number, y: number) => {
    const i = px(x, y);
    if (data[i + 3]! < 20) return;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    counts.set(k, e);
  };
  for (let x = rect.x0; x <= rect.x1; x += 2) {
    sample(x, rect.y0);
    sample(x, rect.y1);
  }
  for (let y = rect.y0; y <= rect.y1; y += 2) {
    sample(rect.x0, y);
    sample(rect.x1, y);
  }
  const total = [...counts.values()].reduce((s, e) => s + e.n, 0);
  if (!total) return 0;
  // Background = the dominant border colour clusters (so a subject touching an edge is not mistaken for it).
  const samples = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .filter((e, i) => i === 0 || e.n / total > 0.12)
    .slice(0, 3)
    .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n] as const);
  const near = (i: number) => {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    for (const s of samples) if (Math.abs(r - s[0]) + Math.abs(g - s[1]) + Math.abs(b - s[2]) < tolerance * 2.2) return true;
    return false;
  };
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) return;
    const k = y * w + x;
    if (bg[k]) return;
    if (data[k * 4 + 3]! >= 20 && !near(k * 4)) return;
    bg[k] = 1;
    stack.push(k);
  };
  for (let x = rect.x0; x <= rect.x1; x++) {
    push(x, rect.y0);
    push(x, rect.y1);
  }
  for (let y = rect.y0; y <= rect.y1; y++) {
    push(rect.x0, y);
    push(rect.x1, y);
  }
  let cleared = 0;
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w, y = (k / w) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  for (let k = 0; k < w * h; k++)
    if (bg[k] && data[k * 4 + 3]! > 0) {
      data[k * 4 + 3] = 0;
      cleared++;
    }
  // Soften the new edge: subject pixels next to cleared background get partial alpha.
  for (let y = rect.y0 + 1; y < rect.y1; y++)
    for (let x = rect.x0 + 1; x < rect.x1; x++) {
      const k = y * w + x;
      if (bg[k] || !data[k * 4 + 3]) continue;
      const n = bg[k - 1]! + bg[k + 1]! + bg[k - w]! + bg[k + w]!;
      if (n) data[k * 4 + 3] = Math.round(data[k * 4 + 3]! * (1 - n * 0.2));
    }
  return cleared;
}

/** Grow a mask by `r` pixels (square neighbourhood), separably. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) run = x;
      if (x - run <= r) tmp[y * w + x] = 1;
    }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) run = x;
      if (run - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) run = y;
      if (y - run <= r) out[y * w + x] = 1;
    }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) run = y;
      if (run - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

interface MatteStats {
  rect: Rect | null;
  solid: number;
  /** The kept subject fills a rectangle with straight edges: an opaque backdrop panel survived. */
  backdrop: boolean;
}

/**
 * Keep only the subject: the large opaque components plus a thin soft edge around them. Removes the
 * semi-transparent fog, mist, glow and ground haze that native-alpha models leave around figures.
 */
function cleanMatte(data: Buffer, w: number, h: number): MatteStats {
  const N = w * h;
  const solid = new Uint8Array(N);
  for (let k = 0; k < N; k++) solid[k] = data[k * 4 + 3]! >= 200 ? 1 : 0;
  // Connected components of opaque pixels.
  const label = new Int32Array(N);
  const areas: number[] = [0];
  const stack: number[] = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!solid[k0] || label[k0]) continue;
    const id = areas.length;
    let area = 0;
    label[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!;
      area++;
      const x = k % w;
      if (x > 0 && solid[k - 1] && !label[k - 1]) (label[k - 1] = id), stack.push(k - 1);
      if (x < w - 1 && solid[k + 1] && !label[k + 1]) (label[k + 1] = id), stack.push(k + 1);
      if (k >= w && solid[k - w] && !label[k - w]) (label[k - w] = id), stack.push(k - w);
      if (k < N - w && solid[k + w] && !label[k + w]) (label[k + w] = id), stack.push(k + w);
    }
    areas.push(area);
  }
  const largest = Math.max(0, ...areas);
  if (!largest) return { rect: null, solid: 0, backdrop: false };
  const minArea = Math.max(largest * 0.02, 40);
  const kept = new Uint8Array(N);
  let rect: Rect | null = null;
  let count = 0;
  for (let k = 0; k < N; k++) {
    if (!label[k] || areas[label[k]!]! < minArea) continue;
    kept[k] = 1;
    count++;
    const x = k % w, y = (k / w) | 0;
    if (!rect) rect = { x0: x, y0: y, x1: x, y1: y };
    else {
      if (x < rect.x0) rect.x0 = x;
      if (x > rect.x1) rect.x1 = x;
      if (y < rect.y0) rect.y0 = y;
      if (y > rect.y1) rect.y1 = y;
    }
  }
  const edge = dilate(kept, w, h, 3);
  for (let k = 0; k < N; k++) {
    if (!edge[k]) data[k * 4 + 3] = 0;
    else if (!kept[k] && data[k * 4 + 3]! < 70) data[k * 4 + 3] = 0;
  }
  // Backdrop panel: the subject fills its bounding box and most rows/columns run edge to edge.
  let backdrop = false;
  if (rect) {
    const bw = rect.x1 - rect.x0 + 1, bh = rect.y1 - rect.y0 + 1;
    const fill = count / (bw * bh);
    let straightRows = 0, straightCols = 0;
    for (let y = rect.y0; y <= rect.y1; y++) if (kept[y * w + rect.x0] || kept[y * w + rect.x0 + 1]) if (kept[y * w + rect.x1] || kept[y * w + rect.x1 - 1]) straightRows++;
    for (let x = rect.x0; x <= rect.x1; x++) if (kept[rect.y0 * w + x] || kept[(rect.y0 + 1) * w + x]) if (kept[rect.y1 * w + x] || kept[(rect.y1 - 1) * w + x]) straightCols++;
    backdrop = fill > 0.8 && (straightRows / bh > 0.55 || straightCols / bw > 0.55);
  }
  return { rect, solid: count, backdrop };
}

/** Cut out, clean and trim a generated sprite, object or icon. */
export async function processSprite(input: Buffer, maxHeight = 256, tolerance = 34): Promise<ProcessedImage> {
  const meta = await sharp(input).metadata();
  const scale = Math.min(1, 640 / Math.max(meta.width ?? 640, meta.height ?? 640));
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .resize(Math.round((meta.width ?? 640) * scale), Math.round((meta.height ?? 640) * scale))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const px = (x: number, y: number) => (y * w + x) * 4;
  const problems: string[] = [];
  let borderClear = 0;
  for (let x = 0; x < w; x++) borderClear += (data[px(x, 0) + 3]! < 20 ? 1 : 0) + (data[px(x, h - 1) + 3]! < 20 ? 1 : 0);
  for (let y = 0; y < h; y++) borderClear += (data[px(0, y) + 3]! < 20 ? 1 : 0) + (data[px(w - 1, y) + 3]! < 20 ? 1 : 0);
  if (borderClear / (2 * (w + h)) < 0.6) floodCutout(data, w, h, tolerance);
  const stats = cleanMatte(data, w, h);
  // An opaque panel survived (only its rounded corners were transparent). Cutting it out afterwards shreds
  // subjects whose colours match it, so this calls for a fresh attempt instead.
  if (stats.backdrop) problems.push('an opaque background panel surrounds the subject');
  const rect = stats.rect;
  if (!rect) return { png: await sharp(input).png().toBuffer(), width: w, height: h, problems: ['no subject found'] };
  const frac = stats.solid / (w * h);
  if (frac < 0.03) problems.push('subject too small');
  if (frac > 0.75) problems.push('background was not removed (subject fills the image)');
  let edgeTouch = 0, bottomTouch = 0;
  for (let y = 0; y < h; y++) edgeTouch += (data[px(0, y) + 3]! > 40 ? 1 : 0) + (data[px(w - 1, y) + 3]! > 40 ? 1 : 0);
  for (let x = 0; x < w; x++) {
    if (data[px(x, 0) + 3]! > 40) edgeTouch++;
    if (data[px(x, h - 1) + 3]! > 40) bottomTouch++;
  }
  if (edgeTouch > (w + h) * 0.08 || bottomTouch > w * 0.12) problems.push('subject is cut off by the image border');
  const notes: string[] = [];
  const look = surfaceStats(data, w, h, rect);
  // Fog, mist or glow pooled around the subject: a smooth opaque skirt spreading beyond its body.
  // A soft signal only: the checker has the final say.
  if (look.skirt > 0.06 && look.skirtSmooth > 0.6) notes.push('possible fog, mist or glow around the subject');
  // Readability: very dark subjects vanish on dark maps.
  if (look.luma < 30) notes.push('subject is very dark and may not read on the map');
  const pad = 4;
  const x0 = Math.max(0, rect.x0 - pad), y0 = Math.max(0, rect.y0 - pad);
  const x1 = Math.min(w - 1, rect.x1 + pad), y1 = Math.min(h - 1, rect.y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: cw, height: ch })
    .resize({ height: Math.min(maxHeight, ch), withoutEnlargement: true })
    .png()
    .toBuffer();
  const m2 = await sharp(png).metadata();
  return { png, width: m2.width ?? cw, height: m2.height ?? ch, anchorY: 0.97, figureRatio: (rect.y1 - rect.y0 + 1) / h, problems, notes };
}

/**
 * Brightness of the opaque subject, and its "skirt": opaque pixels in the lower part of the image that spread
 * sideways beyond the body above them. Fog, mist and glow pool around a subject's base like that, and are
 * smooth; solid objects and smoothly shaded art keep within their own silhouette. Measured at a fixed height
 * so the result does not depend on the image's resolution.
 */
export function surfaceStats(data: Buffer, w: number, h: number, rect: Rect) {
  const S = 160 / Math.max(1, rect.y1 - rect.y0 + 1);
  const sw = Math.max(4, Math.round((rect.x1 - rect.x0 + 1) * S)), sh = 160;
  const at = (x: number, y: number) => ((Math.min(rect.y1, rect.y0 + Math.floor(y / S)) * w + Math.min(rect.x1, rect.x0 + Math.floor(x / S))) * 4);
  const L = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  const opaque = (x: number, y: number) => data[at(x, y) + 3]! >= 200;
  let n = 0, luma = 0;
  // Body span: the 10th-90th percentile of opaque columns in the middle band of the subject.
  const cols: number[] = [];
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      if (!opaque(x, y)) continue;
      n++;
      luma += L(at(x, y));
      if (y >= sh * 0.25 && y < sh * 0.7) cols.push(x);
    }
  cols.sort((p, q) => p - q);
  const left = cols.length ? cols[Math.floor(cols.length * 0.1)]! : 0;
  const right = cols.length ? cols[Math.floor(cols.length * 0.9)]! : sw - 1;
  const margin = Math.max(2, (right - left) * 0.1);
  let skirt = 0, skirtSmooth = 0;
  for (let y = Math.floor(sh * 0.7); y < sh; y++)
    for (let x = 1; x < sw - 1; x++) {
      if ((x >= left - margin && x <= right + margin) || !opaque(x, y)) continue;
      skirt++;
      const c = L(at(x, y));
      const d = Math.max(Math.abs(c - L(at(x - 1, y))), Math.abs(c - L(at(x + 1, y))), Math.abs(c - L(at(x, Math.max(0, y - 1)))), Math.abs(c - L(at(x, Math.min(sh - 1, y + 1)))));
      if (d < 4) skirtSmooth++;
    }
  return { skirt: skirt / Math.max(1, n), skirtSmooth: skirtSmooth / Math.max(1, skirt), luma: luma / Math.max(1, n) };
}

/** What the checker sees: the cutout on loud magenta (left) and its alpha mask (right), so leftovers show. */
export async function inspectionView(png: Buffer, size = 448): Promise<Buffer> {
  const subject = await sharp(png).resize(size, size, { fit: 'contain', background: { r: 255, g: 0, b: 255, alpha: 1 } }).flatten({ background: '#ff00ff' }).png().toBuffer();
  const mask = await sharp(png)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extractChannel('alpha')
    .toColourspace('b-w')
    .png()
    .toBuffer();
  return sharp({ create: { width: size * 2 + 16, height: size, channels: 3, background: '#202020' } })
    .composite([{ input: subject, left: 0, top: 0 }, { input: mask, left: size + 16, top: 0 }])
    .png()
    .toBuffer();
}

/** Reference image for pose variants: the approved sprite on plain light grey, framed like a fresh generation. */
export async function referenceFrame(png: Buffer, outW: number, outH: number): Promise<{ png: Buffer; figureRatio: number }> {
  const m = await sharp(png).metadata();
  const ratio = 0.8;
  const H = Math.round((m.height ?? 256) / ratio);
  const W = Math.round((H * outW) / outH);
  const left = Math.max(0, Math.round((W - (m.width ?? 128)) / 2));
  const top = Math.round(H * 0.92 - (m.height ?? 256));
  const out = await sharp({ create: { width: Math.max(W, (m.width ?? 128) + 8), height: H, channels: 4, background: '#d6d6d6' } })
    .composite([{ input: png, left, top: Math.max(0, top) }])
    .flatten({ background: '#d6d6d6' })
    .png()
    .toBuffer();
  return { png: out, figureRatio: ratio };
}
