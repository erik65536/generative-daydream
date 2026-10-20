/**
 * Cutting characters, objects and icons out of their painting. Krea paints each one on a plain chroma-key backdrop
 * (picked per subject by the prompt writer) and BiRefNet, in the same ComfyUI workflow, says where the subject is:
 * the workflow returns the untouched painting with BiRefNet's mask as its alpha. Here:
 *
 *  - the backdrop's colour field B is estimated from the pixels joined to the image border;
 *  - the key: each pixel's opacity from where its colour lies between B and the nearby subject colour F,
 *    alpha = (C-B)·(F-B)/|F-B|², the backdrop's own shadows (C ≈ s·B) counting as backdrop;
 *  - the cut: the model mask says where the subject is, the key how opaque its edge pixels are; sizeable patches
 *    of backdrop inside the subject (the middle of a ring, gaps in a swarm) are cut out;
 *  - the backdrop colour is un-mixed from soft edges, F = (C - (1-a)·B) / a, so no coloured fringe is left;
 *  - the score compares the cut with the key: backdrop left behind, subject cut away. Separate pieces are fine.
 */
import sharp from 'sharp';

/** The chroma-key backdrops, as image models render them reliably (named with their exact colour). */
export const KEY_COLOURS = {
  green: { name: 'pure chroma-key green (#00b140)', hex: '#00b140' },
  blue: { name: 'pure chroma-key blue (#0047bb)', hex: '#0047bb' },
  magenta: { name: 'pure bright magenta (#ff00ff)', hex: '#ff00ff' },
} as const;
export type KeyColour = keyof typeof KEY_COLOURS;
export const KEY_NAMES = Object.keys(KEY_COLOURS) as [KeyColour, ...KeyColour[]];

/** Ends every asset prompt. */
export const backdropSentence = (key: KeyColour) =>
  `The subject is isolated on a perfectly plain, flat, evenly lit ${KEY_COLOURS[key].name} studio background that fills the whole frame from edge to edge, with nothing else in the image.`;

/** Gates of the score (shares; see `Cutout`). */
export const LIMITS = { leftover: 0.025, missing: 0.06 };

export interface Cutout {
  /** Full-size RGBA, edges decontaminated. */
  data: Buffer;
  width: number;
  height: number;
  /** The key could judge this image: the backdrop is saturated and rarely seen inside the subject. */
  judgeable: boolean;
  /** Opacity given to backdrop-coloured pixels, as a share of the cutout's opacity (background left behind). */
  leftover: number;
  /** Subject opacity the cut dropped, as a share of the key's subject (subject missing). */
  missing: number;
  /** Separate opaque pieces that are mostly backdrop colour. */
  bgPieces: number;
}

interface RGB {
  w: number;
  h: number;
  d: Float32Array;
}

/** Box blur of a plane, `passes` times (≈ Gaussian). */
function blur(src: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  const a = Float32Array.from(src);
  const b = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))]!;
      for (let x = 0; x < w; x++) {
        b[row + x] = s / n;
        s += a[row + Math.min(w - 1, x + r + 1)]! - a[row + Math.max(0, x - r)]!;
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x]!;
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / n;
        s += b[Math.min(h - 1, y + r + 1) * w + x]! - b[Math.max(0, y - r) * w + x]!;
      }
    }
  }
  return a;
}

/** Binary dilation by a square of radius r. */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (m[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}
const erode = (m: Uint8Array, w: number, h: number, r: number) => dilate(m.map((v) => 1 - v), w, h, r).map((v) => 1 - v);

/** 4-connected components of `m`; calls `each` with every component's pixel list. */
function components(m: Uint8Array, w: number, h: number, each: (pixels: number[]) => void) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!m[k0] || seen[k0]) continue;
    const comp: number[] = [];
    seen[k0] = 1;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % w;
      if (x > 0 && m[k - 1] && !seen[k - 1]) (seen[k - 1] = 1), stack.push(k - 1);
      if (x < w - 1 && m[k + 1] && !seen[k + 1]) (seen[k + 1] = 1), stack.push(k + 1);
      if (k >= w && m[k - w] && !seen[k - w]) (seen[k - w] = 1), stack.push(k - w);
      if (k < N - w && m[k + w] && !seen[k + w]) (seen[k + w] = 1), stack.push(k + w);
    }
    each(comp);
  }
}

/**
 * The backdrop's colour field: the border's median colour, refined from the pixels near it that join the border
 * (so subject colours close to it are not taken for backdrop) away from `exclude`, and filled in behind the
 * subject by diffusion on a coarse grid.
 */
function backdropField(img: RGB, exclude: Uint8Array) {
  const { w, h, d } = img;
  const N = w * h;
  const border: number[][] = [[], [], []];
  const sampleBorder = (x: number, y: number) => {
    for (let c = 0; c < 3; c++) border[c]!.push(d[(y * w + x) * 3 + c]!);
  };
  for (let x = 0; x < w; x += 2) for (const y of [0, 1, h - 2, h - 1]) sampleBorder(x, y);
  for (let y = 0; y < h; y += 2) for (const x of [0, 1, w - 2, w - 1]) sampleBorder(x, y);
  const med = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1]!) as [number, number, number];
  const distMed = (k: number) => Math.hypot(d[k * 3]! - med[0], d[k * 3 + 1]! - med[1], d[k * 3 + 2]! - med[2]);
  const near = (k: number) => !exclude[k] && distMed(k) < 45;
  const conn = new Uint8Array(N);
  const stack: number[] = [];
  const seed = (k: number) => {
    if (!conn[k] && near(k)) (conn[k] = 1), stack.push(k);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < N - w) seed(k + w);
  }
  const G = 16, gw = Math.ceil(w / G), gh = Math.ceil(h / G);
  const sum = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh);
  const dev: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!conn[k]) continue;
      const gk = ((y / G) | 0) * gw + ((x / G) | 0);
      for (let c = 0; c < 3; c++) sum[gk * 3 + c] += d[k * 3 + c]!;
      cnt[gk]++;
      if ((x < 4 || y < 4 || x >= w - 4 || y >= h - 4) && (x + y) % 3 === 0) dev.push(distMed(k));
    }
  dev.sort((a, b) => a - b);
  const noise = Math.max(6, dev.length ? dev[Math.floor(dev.length * 0.9)]! : 8);
  const known = new Uint8Array(gw * gh);
  const grid = new Float32Array(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) {
    known[i] = cnt[i]! >= G * G * 0.25 ? 1 : 0;
    for (let c = 0; c < 3; c++) grid[i * 3 + c] = known[i] ? sum[i * 3 + c]! / cnt[i]! : med[c]!;
  }
  for (let it = 0; it < 400; it++)
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        const i = gy * gw + gx;
        if (known[i]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          if (gx > 0) (s += grid[(i - 1) * 3 + c]!), n++;
          if (gx < gw - 1) (s += grid[(i + 1) * 3 + c]!), n++;
          if (gy > 0) (s += grid[(i - gw) * 3 + c]!), n++;
          if (gy < gh - 1) (s += grid[(i + gw) * 3 + c]!), n++;
          grid[i * 3 + c] = s / n;
        }
      }
  const B = new Float32Array(N * 3);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / G - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / G - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++)
        B[(y * w + x) * 3 + c] = (1 - ty) * ((1 - tx) * grid[(y0 * gw + x0) * 3 + c]! + tx * grid[(y0 * gw + x1) * 3 + c]!) + ty * ((1 - tx) * grid[(y1 * gw + x0) * 3 + c]! + tx * grid[(y1 * gw + x1) * 3 + c]!);
    }
  }
  return { B, noise, chroma: Math.max(...med) - Math.min(...med) };
}

interface Key {
  alpha: Float32Array;
  /** The backdrop or its shadow. */
  bgLike: Uint8Array;
  /** The key's alpha can be trusted here. */
  sure: Uint8Array;
  B: Float32Array;
  chroma: number;
  /** The nearby clear subject colour (RGB; NaN where none is near). */
  F: Float32Array;
}

/** The key: opacity of every pixel from the known backdrop. */
function keyAlpha(img: RGB, exclude: Uint8Array): Key {
  const { w, h, d } = img;
  const N = w * h;
  const { B, noise, chroma } = backdropField(img, exclude);
  const tight = Math.max(12, noise * 1.6);
  const bgLike = new Uint8Array(N);
  const dist = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const r = d[k * 3]!, g = d[k * 3 + 1]!, b = d[k * 3 + 2]!;
    const R = B[k * 3]!, G = B[k * 3 + 1]!, Bb = B[k * 3 + 2]!;
    dist[k] = Math.hypot(r - R, g - G, b - Bb);
    if (dist[k]! < tight) bgLike[k] = 1;
    else if (chroma > 50) {
      // A shadow or light falloff on a coloured backdrop: C ≈ s·B.
      const s = (r * R + g * G + b * Bb) / (R * R + G * G + Bb * Bb);
      if (s > 0.5 && s < 1.05 && Math.hypot(r - s * R, g - s * G, b - s * Bb) < 3 + 0.07 * s * Math.hypot(R, G, Bb)) bgLike[k] = 1;
    }
  }
  // Mixed pixels only occur next to the backdrop; deeper inside, any colour unlike the backdrop is the subject.
  const nearBg = dilate(bgLike, w, h, Math.max(2, Math.round(Math.max(w, h) / 300)));
  // Clearly-subject pixels (away from the backdrop), and the local subject colour F (a normalised blur of them).
  const HI = 70;
  const fg = new Float32Array(N);
  for (let k = 0; k < N; k++) fg[k] = !nearBg[k] && dist[k]! > HI ? 1 : 0;
  const rad = Math.max(3, Math.round(Math.max(w, h) / 220));
  const wsum = blur(fg, w, h, rad);
  const F = [0, 1, 2].map((c) => blur(Float32Array.from(fg, (v, k) => v * d[k * 3 + c]!), w, h, rad));
  const alpha = new Float32Array(N);
  const sure = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (bgLike[k]) {
      sure[k] = 1;
      continue;
    }
    if (fg[k] || (!nearBg[k] && dist[k]! > 2 * tight)) {
      alpha[k] = 1;
      sure[k] = 1;
      continue;
    }
    const ws = wsum[k]!;
    if (ws > 0.02) {
      const fr = F[0]![k]! / ws - B[k * 3]!, fgr = F[1]![k]! / ws - B[k * 3 + 1]!, fb = F[2]![k]! / ws - B[k * 3 + 2]!;
      const n2 = fr * fr + fgr * fgr + fb * fb;
      if (n2 > 50 * 50) {
        alpha[k] = Math.min(1, Math.max(0, ((d[k * 3]! - B[k * 3]!) * fr + (d[k * 3 + 1]! - B[k * 3 + 1]!) * fgr + (d[k * 3 + 2]! - B[k * 3 + 2]!) * fb) / n2));
        sure[k] = 1;
        continue;
      }
    }
    // Faint content far from any clear subject colour (a wisp): opacity by distance alone, not trusted.
    alpha[k] = Math.min(1, Math.max(0, (dist[k]! - tight) / (HI - tight)));
  }
  const Fc = new Float32Array(N * 3).fill(NaN);
  for (let k = 0; k < N; k++) if (wsum[k]! > 0.02) for (let c = 0; c < 3; c++) Fc[k * 3 + c] = F[c]![k]! / wsum[k]!;
  return { alpha, bgLike, sure, B, chroma, F: Fc };
}

/** Cut a painting out: `png` is the painting with the cutter model's mask as its alpha channel. */
export async function cutout(png: Buffer): Promise<Cutout> {
  const { data: raw, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = w * h;
  const d = new Float32Array(N * 3);
  const model = new Float32Array(N);
  let any = false;
  for (let k = 0; k < N; k++) {
    for (let c = 0; c < 3; c++) d[k * 3 + c] = raw[k * 4 + c]!;
    model[k] = raw[k * 4 + 3]! / 255;
    if (raw[k * 4 + 3]! < 250) any = true;
  }
  if (!any) throw new Error('the image came back without a cutout mask: the ComfyUI workflow must save the painting with the cutter mask as alpha (config/comfyui/krea2_cutout.json)');
  const img = { w, h, d };
  const key = keyAlpha(img, dilate(Uint8Array.from(model, (v) => (v > 0.05 ? 1 : 0)), w, h, 6));

  // The model says where the subject is (its mask grown a little); within it the key says how opaque.
  const region = dilate(Uint8Array.from(model, (v) => (v > 0.1 ? 1 : 0)), w, h, Math.max(4, Math.round(Math.max(w, h) / 150)));
  // The confident inside of the mask, a few pixels in from its outline (the cutter's outline often runs over the backdrop).
  const core = erode(Uint8Array.from(model, (v) => (v > 0.95 ? 1 : 0)), w, h, Math.max(4, Math.round(Math.max(w, h) / 200)));
  // Backdrop inside the confident subject: sizeable patches are holes the cutter filled in (the middle of a ring, the
  // gaps in a swarm); backdrop colour scattered through the subject means its colours clash with the key, which
  // then cannot tell them apart.
  const hole = new Uint8Array(N);
  let coreN = 0, scattered = 0;
  for (let k = 0; k < N; k++) coreN += core[k]!;
  components(Uint8Array.from(core, (v, k) => v & key.bgLike[k]!), w, h, (px) => {
    if (px.length >= N * 0.0008) for (const k of px) hole[k] = 1;
    else scattered += px.length;
  });
  const judgeable = key.chroma > 50 && scattered / Math.max(1, coreN) < 0.03;
  if (!judgeable) hole.fill(0);
  const holeRim = dilate(hole, w, h, 3);
  const alpha = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (!region[k]) continue;
    alpha[k] = !judgeable || (core[k] && !holeRim[k]) || !key.sure[k] ? model[k]! : key.alpha[k]!;
  }

  // Score against the key.
  let area = 0, keyArea = 0, extra = 0, lost = 0;
  for (let k = 0; k < N; k++) {
    const a = alpha[k]!;
    area += a;
    if (!key.sure[k]) {
      keyArea += a;
      continue;
    }
    const ka = key.alpha[k]!;
    keyArea += ka;
    if (a > ka) extra += a - ka;
    else lost += ka - a;
  }
  let bgPieces = 0;
  components(Uint8Array.from(alpha, (v) => (v > 0.5 ? 1 : 0)), w, h, (px) => {
    if (px.length < N * 0.0005) return;
    let bg = 0;
    for (const k of px) bg += key.bgLike[k]!;
    if (bg / px.length > 0.6) bgPieces++;
  });

  // Un-mix the backdrop from partly transparent pixels: F = (C - (1-a)·B) / a. Where the nearby subject colour is
  // known, the result stays between the pixel's colour and it (an underestimated alpha would otherwise overshoot into
  // the backdrop's complement: teal edges on crimson), and any backdrop hue beyond the subject's own is removed
  // (an overestimated alpha would otherwise leave a tinted fringe).
  const out = Buffer.alloc(N * 4);
  const hue = [0, 1, 2].map((c) => key.B[c]! - (key.B[0]! + key.B[1]! + key.B[2]!) / 3);
  const hn = Math.hypot(hue[0]!, hue[1]!, hue[2]!) || 1;
  const u = hue.map((v) => v / hn);
  const chromaOf = (r: number, g: number, b: number) => {
    const m = (r + g + b) / 3;
    return (r - m) * u[0]! + (g - m) * u[1]! + (b - m) * u[2]!;
  };
  // Opaque pixels along the outline get the same hue correction: a soft glow the painting blended into the backdrop
  // (around glass, a lit lantern) is opaque to the cutter but tinted by the backdrop.
  const outline = dilate(Uint8Array.from(alpha, (a) => (a < 0.5 ? 1 : 0)), w, h, Math.max(3, Math.round(Math.max(w, h) / 150)));
  const f = key.F;
  const v = [0, 0, 0];
  for (let k = 0; k < N; k++) {
    const a = alpha[k]!;
    for (let c = 0; c < 3; c++) v[c] = d[k * 3 + c]!;
    const known = !Number.isNaN(f[k * 3]!);
    if (a > 0.02 && a < 0.98) {
      for (let c = 0; c < 3; c++) v[c] = (d[k * 3 + c]! - (1 - a) * key.B[k * 3 + c]!) / a;
      if (known)
        for (let c = 0; c < 3; c++) {
          const lo = Math.min(d[k * 3 + c]!, f[k * 3 + c]!), hi = Math.max(d[k * 3 + c]!, f[k * 3 + c]!);
          v[c] = Math.min(hi, Math.max(lo, v[c]!));
        }
    }
    if (known && a > 0.02 && (a < 0.98 || outline[k])) {
      const spill = chromaOf(v[0]!, v[1]!, v[2]!) - Math.max(0, chromaOf(f[k * 3]!, f[k * 3 + 1]!, f[k * 3 + 2]!));
      if (spill > 0) for (let c = 0; c < 3; c++) v[c] -= spill * u[c]!;
    }
    for (let c = 0; c < 3; c++) out[k * 4 + c] = Math.max(0, Math.min(255, Math.round(v[c]!)));
    out[k * 4 + 3] = a < 0.01 ? 0 : Math.round(a * 255);
  }
  return { data: out, width: w, height: h, judgeable, leftover: extra / Math.max(1, area), missing: lost / Math.max(1, keyArea), bgPieces };
}

/** What the score says is wrong with a cutout (empty when it passes). */
export function cutoutProblems(c: Cutout): string[] {
  const out: string[] = [];
  if (!c.judgeable) out.push('the backdrop colour clashes with the subject');
  else {
    if (c.leftover > LIMITS.leftover || c.bgPieces) out.push('background was left around the subject');
    if (c.missing > LIMITS.missing) out.push('part of the subject was cut away');
  }
  return out;
}

export interface FinishedImage {
  png: Buffer;
  width: number;
  height: number;
  /** Where the subject stands, as a share of the image height from the top. */
  anchorY: number;
  /** Problems that call for another attempt. */
  problems: string[];
  /** Softer concerns that lower the score. */
  notes: string[];
}

/** Trim a cutout to its subject (with a small margin) and scale it to at most `maxHeight`; check its framing. */
export async function finishCutout(c: Cutout, maxHeight: number): Promise<FinishedImage> {
  const { data, width: w, height: h } = c;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, solid = 0, luma = 0;
  let edge = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x, a = data[k * 4 + 3]!;
      if (a < 24) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (a > 200) (solid++, (luma += 0.2126 * data[k * 4]! + 0.7152 * data[k * 4 + 1]! + 0.0722 * data[k * 4 + 2]!));
      if (a > 100 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) edge++;
    }
  const problems: string[] = [], notes: string[] = [];
  if (x1 < 0) return { png: await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), width: w, height: h, anchorY: 0.97, problems: ['no subject found'], notes };
  if (solid / (w * h) < 0.02) problems.push('subject too small');
  if (edge > (w + h) * 0.04) problems.push('subject is cut off by the image border');
  if (luma / Math.max(1, solid) < 30) notes.push('subject is very dark and may not read on the map');
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02) + 2;
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  const cw = Math.min(w - 1, x1 + pad) - left + 1, ch = Math.min(h - 1, y1 + pad) - top + 1;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .resize({ height: Math.min(maxHeight, ch), withoutEnlargement: true, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const m = await sharp(png).metadata();
  return { png, width: m.width ?? cw, height: m.height ?? ch, anchorY: (y1 - top + 0.5) / ch, problems, notes };
}
