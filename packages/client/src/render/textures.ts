/**
 * Seamless procedural textures for every tileset role, styled by the tileset's material and colored by
 * its (generated) palette. Generated image assets replace these when available.
 */
import type { TilesetDef, TileRole } from '@gd/shared';

export const TEX = 128;

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgb(c: RGB, a = 1) {
  return a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function shade(c: RGB, f: number): RGB {
  return f >= 1 ? mix(c, [255, 255, 255], Math.min(1, f - 1)) : [c[0] * f, c[1] * f, c[2] * f];
}

/** Small deterministic PRNG. */
export function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function strHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Tileable value noise on a torus of `period` cells. */
function tileNoise(size: number, period: number, rnd: () => number): Float32Array {
  const g = new Float32Array(period * period).map(() => rnd());
  const out = new Float32Array(size * size);
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * period, fy = (y / size) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = s(fx - x0), ty = s(fy - y0);
      const i = (xx: number, yy: number) => g[((yy % period) + period) % period * period + (((xx % period) + period) % period)]!;
      const a = i(x0, y0), b = i(x0 + 1, y0), c = i(x0, y0 + 1), d = i(x0 + 1, y0 + 1);
      out[y * size + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  return out;
}

function fbm(size: number, rnd: () => number, periods = [4, 8, 16, 32]): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  periods.forEach((p, i) => {
    const amp = 1 / (i + 1);
    total += amp;
    const n = tileNoise(size, p, rnd);
    for (let k = 0; k < out.length; k++) out[k]! += n[k]! * amp;
  });
  for (let k = 0; k < out.length; k++) out[k]! /= total;
  return out;
}

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Paint base color with noise modulation into a canvas. */
function noiseFill(ctx: CanvasRenderingContext2D, base: RGB, dark: RGB, light: RGB, rnd: () => number, contrast = 1, periods?: number[]) {
  const n = fbm(TEX, rnd, periods);
  const img = ctx.createImageData(TEX, TEX);
  for (let i = 0; i < TEX * TEX; i++) {
    const v = (n[i]! - 0.5) * 2 * contrast;
    const c = v < 0 ? mix(base, dark, Math.min(1, -v)) : mix(base, light, Math.min(1, v * 0.8));
    const grain = (rnd() - 0.5) * 10;
    img.data[i * 4] = c[0] + grain;
    img.data[i * 4 + 1] = c[1] + grain;
    img.data[i * 4 + 2] = c[2] + grain;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw something wrapped on all edges so the texture stays seamless. */
function wrapped(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fn: (x: number, y: number) => void) {
  for (const dx of [-TEX, 0, TEX])
    for (const dy of [-TEX, 0, TEX]) {
      const xx = x + dx, yy = y + dy;
      if (xx + r < 0 || yy + r < 0 || xx - r > TEX || yy - r > TEX) continue;
      fn(xx, yy);
    }
}

type Style = TilesetDef['style'];

function palette(colors: string[]): { base: RGB; dark: RGB; light: RGB } {
  const base = hexToRgb(colors[0] ?? '#777777');
  const dark = colors[1] ? hexToRgb(colors[1]) : shade(base, 0.7);
  const light = colors[2] ? hexToRgb(colors[2]) : shade(base, 1.25);
  return { base, dark: mix(dark, shade(base, 0.6), 0.3), light };
}

function grass(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number, flowers: number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.8);
  // Blades
  for (let i = 0; i < 900; i++) {
    const x = rnd() * TEX, y = rnd() * TEX;
    const c = rnd() < 0.5 ? shade(p.base, 0.72 + rnd() * 0.15) : shade(p.light, 0.95 + rnd() * 0.15);
    const len = 2 + rnd() * 4;
    const lean = (rnd() - 0.5) * 2.5;
    ctx.strokeStyle = rgb(c, 0.55);
    ctx.lineWidth = 1;
    wrapped(ctx, x, y, 6, (xx, yy) => {
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx + lean, yy - len);
      ctx.stroke();
    });
  }
  const flowerColors: RGB[] = [[240, 230, 120], [240, 160, 190], [200, 180, 250], [255, 255, 255]];
  for (let i = 0; i < flowers; i++) {
    const x = rnd() * TEX, y = rnd() * TEX;
    const c = flowerColors[Math.floor(rnd() * flowerColors.length)]!;
    wrapped(ctx, x, y, 3, (xx, yy) => {
      ctx.fillStyle = rgb(c, 0.9);
      ctx.beginPath();
      ctx.arc(xx, yy, 1 + rnd() * 0.8, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function dirt(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number, pebbles: number, ruts = false) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.9, [4, 8, 16, 32, 64]);
  if (ruts) {
    ctx.strokeStyle = rgb(shade(p.base, 0.75), 0.35);
    ctx.lineWidth = 5;
    for (const y of [TEX * 0.3, TEX * 0.7]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= TEX; x += 16) ctx.lineTo(x, y + Math.sin((x / TEX) * Math.PI * 2) * 2);
      ctx.stroke();
    }
  }
  for (let i = 0; i < pebbles; i++) {
    const x = rnd() * TEX, y = rnd() * TEX, r = 0.8 + rnd() * 2.2;
    const c = mix(p.dark, p.light, rnd());
    wrapped(ctx, x, y, r + 2, (xx, yy) => {
      ctx.fillStyle = rgb(shade(c, 0.6), 0.5);
      ctx.beginPath();
      ctx.ellipse(xx + 0.6, yy + 0.8, r, r * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgb(c, 0.95);
      ctx.beginPath();
      ctx.ellipse(xx, yy, r, r * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function flagstones(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number, cell = 32, irregular = true) {
  noiseFill(ctx, shade(p.base, 0.7), p.dark, p.base, rnd, 0.5);
  const rows = TEX / cell;
  for (let r = 0; r < rows; r++) {
    const offset = irregular ? (r % 2) * (cell / 2) : 0;
    for (let c = -1; c <= rows; c++) {
      const x = c * cell + offset, y = r * cell;
      const tone = mix(p.base, rnd() < 0.5 ? p.dark : p.light, rnd() * 0.45);
      const inset = 1.5;
      wrapped(ctx, x + cell / 2, y + cell / 2, cell, (xx, yy) => {
        const x0 = xx - cell / 2 + inset, y0 = yy - cell / 2 + inset, w = cell - inset * 2, h = cell - inset * 2;
        const g = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
        g.addColorStop(0, rgb(shade(tone, 1.12)));
        g.addColorStop(1, rgb(shade(tone, 0.88)));
        ctx.fillStyle = g;
        ctx.beginPath();
        const j = irregular ? 2.5 : 0;
        ctx.moveTo(x0 + rnd() * j, y0 + rnd() * j);
        ctx.lineTo(x0 + w - rnd() * j, y0 + rnd() * j);
        ctx.lineTo(x0 + w - rnd() * j, y0 + h - rnd() * j);
        ctx.lineTo(x0 + rnd() * j, y0 + h - rnd() * j);
        ctx.closePath();
        ctx.fill();
      });
    }
  }
  // Grit and cracks
  const n = fbm(TEX, rnd, [8, 16, 32]);
  const img = ctx.getImageData(0, 0, TEX, TEX);
  for (let i = 0; i < TEX * TEX; i++) {
    const v = (n[i]! - 0.5) * 30 + (rnd() - 0.5) * 12;
    img.data[i * 4] += v;
    img.data[i * 4 + 1] += v;
    img.data[i * 4 + 2] += v;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = rgb(shade(p.dark, 0.6), 0.5);
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) {
    let x = rnd() * TEX, y = rnd() * TEX;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (rnd() - 0.5) * 10;
      y += (rnd() - 0.5) * 10;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function sand(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.45, [2, 4, 8]);
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 18; i++) {
    const y0 = (i / 18) * TEX;
    ctx.strokeStyle = rgb(i % 2 ? shade(p.base, 0.88) : shade(p.light, 1.02), 0.45);
    ctx.beginPath();
    for (let x = 0; x <= TEX; x += 4) {
      const y = y0 + Math.sin((x / TEX) * Math.PI * 4 + i) * 2.5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function snow(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.5);
  for (let i = 0; i < 160; i++) {
    const x = rnd() * TEX, y = rnd() * TEX;
    ctx.fillStyle = `rgba(255,255,255,${0.4 + rnd() * 0.6})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function planks(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  const h = 16;
  for (let r = 0; r < TEX / h; r++) {
    const tone = mix(p.base, rnd() < 0.5 ? p.dark : p.light, rnd() * 0.4);
    ctx.fillStyle = rgb(tone);
    ctx.fillRect(0, r * h, TEX, h);
    // grain
    for (let g = 0; g < 9; g++) {
      ctx.strokeStyle = rgb(shade(tone, 0.8 + rnd() * 0.15), 0.5);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      const y = r * h + 1 + rnd() * (h - 2);
      ctx.moveTo(0, y);
      for (let x = 0; x <= TEX; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.07 + g) * 0.8);
      ctx.stroke();
    }
    ctx.fillStyle = rgb(shade(tone, 0.55));
    ctx.fillRect(0, r * h + h - 1.5, TEX, 1.5);
    const seam = (r * 37) % TEX;
    ctx.fillRect(seam, r * h, 1.5, h);
    ctx.fillRect((seam + TEX / 2) % TEX, r * h, 1.5, h);
    ctx.fillStyle = rgb(shade(tone, 0.4), 0.9);
    ctx.beginPath();
    ctx.arc(seam + 4, r * h + h / 2, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

function metal(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number, grate: boolean) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.25, [8, 16]);
  const s = 32;
  for (let y = 0; y < TEX; y += s)
    for (let x = 0; x < TEX; x += s) {
      const g = ctx.createLinearGradient(x, y, x + s, y + s);
      g.addColorStop(0, rgb(shade(p.base, 1.12), 0.6));
      g.addColorStop(1, rgb(shade(p.base, 0.85), 0.6));
      ctx.fillStyle = g;
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = rgb(shade(p.dark, 0.6));
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, s - 1.5, s - 1.5);
      ctx.fillStyle = rgb(shade(p.light, 1.1));
      for (const [rx, ry] of [[4, 4], [s - 4, 4], [4, s - 4], [s - 4, s - 4]] as const) {
        ctx.beginPath();
        ctx.arc(x + rx, y + ry, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (grate) {
        ctx.fillStyle = rgb(shade(p.dark, 0.4), 0.8);
        for (let k = 6; k < s - 6; k += 4) ctx.fillRect(x + 6, y + k, s - 12, 1.6);
      }
    }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 20; i++) {
    const x = rnd() * TEX, y = rnd() * TEX;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 14, y + (rnd() - 0.5) * 4);
    ctx.stroke();
  }
}

function crystal(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.9);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * TEX, y = rnd() * TEX, r = 2 + rnd() * 6;
    wrapped(ctx, x, y, r + 2, (xx, yy) => {
      ctx.fillStyle = rgb(shade(p.light, 1.2), 0.35 + rnd() * 0.3);
      ctx.beginPath();
      ctx.moveTo(xx, yy - r);
      ctx.lineTo(xx + r * 0.6, yy);
      ctx.lineTo(xx, yy + r);
      ctx.lineTo(xx - r * 0.6, yy);
      ctx.closePath();
      ctx.fill();
    });
  }
}

function veins(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 1);
  ctx.strokeStyle = rgb(shade(p.dark, 0.7), 0.6);
  for (let i = 0; i < 14; i++) {
    ctx.lineWidth = 0.5 + rnd() * 1.5;
    let x = rnd() * TEX, y = rnd() * TEX;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += (rnd() - 0.5) * 18;
      y += (rnd() - 0.5) * 18;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function voidTex(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 1.1, [2, 4, 8]);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.8})`;
    ctx.fillRect(rnd() * TEX, rnd() * TEX, 1, 1);
  }
}

function water(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.7, [2, 4, 8]);
  ctx.strokeStyle = rgb(shade(p.light, 1.2), 0.25);
  ctx.lineWidth = 1;
  for (let i = 0; i < 30; i++) {
    const x = rnd() * TEX, y = rnd() * TEX, w = 6 + rnd() * 14;
    wrapped(ctx, x, y, w, (xx, yy) => {
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.quadraticCurveTo(xx + w / 2, yy - 2, xx + w, yy);
      ctx.stroke();
    });
  }
}

function brickWall(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number, bw = 24, bh = 12) {
  ctx.fillStyle = rgb(shade(p.dark, 0.6));
  ctx.fillRect(0, 0, TEX, TEX);
  for (let r = 0; r < TEX / bh; r++) {
    const off = (r % 2) * (bw / 2);
    for (let c = -1; c <= TEX / bw; c++) {
      const tone = mix(p.base, rnd() < 0.5 ? p.dark : p.light, rnd() * 0.35);
      const x = c * bw + off + 1, y = r * bh + 1;
      ctx.fillStyle = rgb(tone);
      ctx.fillRect(x, y, bw - 2, bh - 2);
      ctx.fillStyle = rgb(shade(tone, 1.15), 0.6);
      ctx.fillRect(x, y, bw - 2, 1.5);
    }
  }
  const n = fbm(TEX, rnd, [8, 16]);
  const img = ctx.getImageData(0, 0, TEX, TEX);
  for (let i = 0; i < TEX * TEX; i++) {
    const v = (n[i]! - 0.5) * 26;
    img.data[i * 4] += v;
    img.data[i * 4 + 1] += v;
    img.data[i * 4 + 2] += v;
  }
  ctx.putImageData(img, 0, 0);
}

function roof(ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, rnd: () => number) {
  const base = mix(p.dark, [120, 50, 40], 0.45);
  ctx.fillStyle = rgb(shade(base, 0.5));
  ctx.fillRect(0, 0, TEX, TEX);
  const h = 10;
  for (let r = 0; r < TEX / h; r++)
    for (let c = -1; c < TEX / 12 + 1; c++) {
      const tone = shade(base, 0.8 + rnd() * 0.35);
      const x = c * 12 + (r % 2) * 6, y = r * h;
      ctx.fillStyle = rgb(tone);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 11, y);
      ctx.lineTo(x + 11, y + h - 2);
      ctx.quadraticCurveTo(x + 5.5, y + h + 1, x, y + h - 2);
      ctx.closePath();
      ctx.fill();
    }
}

/** Generate the procedural texture for a role. */
export function proceduralTexture(ts: TilesetDef, role: TileRole | 'roof'): HTMLCanvasElement {
  const c = makeCanvas(TEX);
  const ctx = c.getContext('2d')!;
  const rnd = prng(strHash(`${ts.id}:${role}`));
  const def = role === 'roof' ? ts.roles.wall : ts.roles[role];
  const p = palette(def?.colors ?? ['#777777']);
  const style: Style = ts.style;
  if (role === 'roof') roof(ctx, p, rnd);
  else if (role === 'water') water(ctx, p, rnd);
  else if (role === 'wall') {
    if (style === 'wood') planks(ctx, p, rnd);
    else if (style === 'metal') metal(ctx, p, rnd, false);
    else if (style === 'crystal') crystal(ctx, p, rnd);
    else if (style === 'flesh') veins(ctx, p, rnd);
    else brickWall(ctx, p, rnd, style === 'stone' ? 28 : 22, style === 'stone' ? 14 : 11);
  } else {
    const alt = role === 'floorAlt';
    const path = role === 'path';
    switch (style) {
      case 'grass':
        if (path) dirt(ctx, p, rnd, 70, true);
        else grass(ctx, p, rnd, alt ? 70 : 6);
        break;
      case 'dirt':
        if (alt) grass(ctx, p, rnd, 3);
        else dirt(ctx, p, rnd, path ? 90 : 40, path);
        break;
      case 'stone':
        if (path) flagstones(ctx, p, rnd, 21, true);
        else if (alt) dirt(ctx, p, rnd, 60);
        else flagstones(ctx, p, rnd, 32, true);
        break;
      case 'sand':
        if (path) dirt(ctx, p, rnd, 50, true);
        else sand(ctx, p, rnd);
        break;
      case 'snow':
        if (path) dirt(ctx, p, rnd, 30, true);
        else snow(ctx, p, rnd);
        break;
      case 'wood':
        if (alt) grass(ctx, { ...p, base: shade(p.base, 1) }, rnd, 0), noiseFill(ctx, p.base, p.dark, p.light, rnd, 0.4, [16, 32]);
        else planks(ctx, p, rnd);
        break;
      case 'metal':
        metal(ctx, p, rnd, alt);
        break;
      case 'crystal':
        if (path) flagstones(ctx, p, rnd, 24, false);
        else crystal(ctx, p, rnd);
        break;
      case 'flesh':
        veins(ctx, p, rnd);
        break;
      case 'void':
        if (path) flagstones(ctx, p, rnd, 32, false);
        else voidTex(ctx, p, rnd);
        break;
    }
  }
  return c;
}

/** Turn a loaded image asset into a texture canvas. */
export function imageTexture(img: HTMLImageElement): HTMLCanvasElement {
  const c = makeCanvas(TEX);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, TEX, TEX);
  return c;
}
