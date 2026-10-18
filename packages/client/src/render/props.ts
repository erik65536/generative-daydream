/**
 * Procedurally drawn isometric props and features. Each is rendered once into a cached canvas
 * with an anchor at the tile's ground center.
 */
import type { TilesetDef } from '@gd/shared';
import { hexToRgb, mix, prng, rgb, shade, strHash } from './textures';

export interface Sprite {
  canvas: HTMLCanvasElement;
  ax: number;
  ay: number;
}

const cache = new Map<string, Sprite>();

function make(w: number, h: number, ax: number, ay: number, draw: (ctx: CanvasRenderingContext2D) => void): Sprite {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.translate(ax, ay);
  draw(ctx);
  return { canvas: c, ax, ay };
}

const col = (ts: TilesetDef, role: keyof TilesetDef['roles'], i: number, fb: string) => hexToRgb(ts.roles[role]?.colors[i] ?? ts.roles[role]?.colors[0] ?? fb);

function shadow(ctx: CanvasRenderingContext2D, rx: number, ry: number, a = 0.35) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.save();
  ctx.scale(1, ry / rx);
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: [number, number, number], rnd: () => number) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, rgb(shade(c, 1.28)));
  g.addColorStop(0.6, rgb(c));
  g.addColorStop(1, rgb(shade(c, 0.62)));
  ctx.fillStyle = g;
  ctx.beginPath();
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.86 + rnd() * 0.22);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.9;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.quadraticCurveTo(x + Math.cos(a - 0.35) * rr * 1.08, y + Math.sin(a - 0.35) * rr, px, py);
  }
  ctx.fill();
}

/**
 * The large blocker for built or enclosed places without generated art: a plain isometric block in the
 * role's colours (whatever it stands for there: shelving, machinery, partitions), rather than a tree.
 */
export function blockSprite(ts: TilesetDef, variant: number): Sprite {
  const key = `block:${ts.id}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const c = col(ts, 'tree', 0, '#6a6a72');
  const h = 34 + rnd() * 30, w = 26, d = 13;
  s = make(80, 120, 40, 100, (ctx) => {
    shadow(ctx, 30, 12, 0.35);
    // Left face, right face, top.
    ctx.fillStyle = rgb(shade(c, 0.72));
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(0, d - h);
    ctx.lineTo(-w, -h);
    ctx.fill();
    ctx.fillStyle = rgb(shade(c, 0.55));
    ctx.beginPath();
    ctx.moveTo(w, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(0, d - h);
    ctx.lineTo(w, -h);
    ctx.fill();
    ctx.fillStyle = rgb(shade(c, 1.05));
    ctx.beginPath();
    ctx.moveTo(-w, -h);
    ctx.lineTo(0, d - h);
    ctx.lineTo(w, -h);
    ctx.lineTo(0, -d - h);
    ctx.fill();
    // A few panel lines so it reads as something made.
    ctx.strokeStyle = rgb(shade(c, 0.45));
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-w, -h * (i / 3));
      ctx.lineTo(0, d - h * (i / 3));
      ctx.lineTo(w, -h * (i / 3));
      ctx.stroke();
    }
  });
  cache.set(key, s);
  return s;
}

export function treeSprite(ts: TilesetDef, variant: number): Sprite {
  const key = `tree:${ts.id}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const leaf = col(ts, 'tree', 0, '#3e6a2e');
  const leaf2 = col(ts, 'tree', 1, '#2e5a26');
  const trunk = col(ts, 'tree', 2, '#5a3a22');
  const style = ts.style;
  const tall = 70 + rnd() * 30;
  s = make(140, 190, 70, 172, (ctx) => {
    shadow(ctx, 34, 14, 0.4);
    if (style === 'metal') {
      // Antenna / mast
      ctx.fillStyle = rgb(shade(leaf, 0.7));
      ctx.fillRect(-3, -tall, 6, tall);
      ctx.fillStyle = rgb(leaf);
      ctx.fillRect(-1, -tall, 2, tall);
      ctx.strokeStyle = rgb(shade(leaf, 0.9));
      ctx.lineWidth = 2;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-12 + i * 2, -tall * (i / 4));
        ctx.lineTo(12 - i * 2, -tall * (i / 4));
        ctx.stroke();
      }
      ctx.fillStyle = rgb(trunk);
      ctx.shadowColor = rgb(trunk);
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, -tall - 3, 3.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (style === 'crystal' || style === 'void') {
      for (let i = 0; i < 4; i++) {
        const h = tall * (0.5 + rnd() * 0.5), w = 7 + rnd() * 8, x = (rnd() - 0.5) * 22;
        const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
        g.addColorStop(0, rgb(shade(leaf, 0.7), 0.95));
        g.addColorStop(0.5, rgb(shade(leaf, 1.35), 0.95));
        g.addColorStop(1, rgb(shade(leaf2, 0.8), 0.95));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - w, 0);
        ctx.lineTo(x - w * 0.4, -h);
        ctx.lineTo(x + w * 0.2, -h - 8);
        ctx.lineTo(x + w, 0);
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    if (style === 'stone' || style === 'flesh') {
      // Stalagmite
      const g = ctx.createLinearGradient(-16, 0, 16, 0);
      g.addColorStop(0, rgb(shade(leaf, 0.6)));
      g.addColorStop(0.45, rgb(shade(leaf, 1.15)));
      g.addColorStop(1, rgb(shade(leaf, 0.5)));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-18, 2);
      ctx.quadraticCurveTo(-8, -tall * 0.5, -2, -tall * 0.85);
      ctx.lineTo(2, -tall * 0.85);
      ctx.quadraticCurveTo(10, -tall * 0.5, 18, 2);
      ctx.closePath();
      ctx.fill();
      return;
    }
    // Trunk
    const tw = 5 + rnd() * 3;
    const tg = ctx.createLinearGradient(-tw, 0, tw, 0);
    tg.addColorStop(0, rgb(shade(trunk, 0.7)));
    tg.addColorStop(0.5, rgb(shade(trunk, 1.15)));
    tg.addColorStop(1, rgb(shade(trunk, 0.55)));
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(-tw - 2, 2);
    ctx.lineTo(-tw * 0.6, -tall * 0.55);
    ctx.lineTo(tw * 0.6, -tall * 0.55);
    ctx.lineTo(tw + 2, 2);
    ctx.closePath();
    ctx.fill();
    if (style === 'snow' || rnd() < 0.35 && style !== 'sand') {
      // Conifer layers
      const layers = 4;
      for (let i = 0; i < layers; i++) {
        const y = -tall * 0.25 - i * (tall * 0.2);
        const w = 34 - i * 7;
        const c = mix(leaf2, leaf, i / layers);
        const g = ctx.createLinearGradient(-w, y, w, y);
        g.addColorStop(0, rgb(shade(c, 0.7)));
        g.addColorStop(0.4, rgb(shade(c, 1.15)));
        g.addColorStop(1, rgb(shade(c, 0.6)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-w, y + 8);
        ctx.lineTo(0, y - tall * 0.3);
        ctx.lineTo(w, y + 8);
        ctx.quadraticCurveTo(0, y + 14, -w, y + 8);
        ctx.fill();
        if (style === 'snow') {
          ctx.fillStyle = 'rgba(240,248,255,0.85)';
          ctx.beginPath();
          ctx.moveTo(-w * 0.5, y - tall * 0.12);
          ctx.lineTo(0, y - tall * 0.3);
          ctx.lineTo(w * 0.3, y - tall * 0.16);
          ctx.closePath();
          ctx.fill();
        }
      }
      return;
    }
    if (style === 'sand') {
      // Palm
      ctx.strokeStyle = rgb(leaf);
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, -tall * 0.6);
        ctx.quadraticCurveTo(Math.cos(a) * 20, -tall * 0.72, Math.cos(a) * 34, -tall * 0.55 + Math.abs(Math.sin(a)) * 10);
        ctx.stroke();
      }
      return;
    }
    // Broadleaf canopy
    const cy = -tall * 0.62;
    blob(ctx, -14, cy + 8, 22, shade(leaf2, 0.9), rnd);
    blob(ctx, 14, cy + 6, 22, shade(leaf2, 0.95), rnd);
    blob(ctx, 0, cy - 12, 26, leaf, rnd);
    blob(ctx, -8, cy - 4, 18, shade(leaf, 1.08), rnd);
    // Highlights
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = rgb(shade(leaf, 1.4), 0.35);
      ctx.beginPath();
      ctx.arc(-14 + rnd() * 26, cy - 24 + rnd() * 26, 1.5 + rnd() * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  cache.set(key, s);
  return s;
}

export function rockSprite(ts: TilesetDef, variant: number, small = false): Sprite {
  const key = `rock:${ts.id}:${variant}:${small}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const c = col(ts, 'rock', 0, '#8a8680');
  s = make(80, 70, 40, 52, (ctx) => {
    const k = small ? 0.6 : 1;
    shadow(ctx, 24 * k, 10 * k, 0.4);
    if (ts.style === 'metal' || ts.style === 'wood') {
      // Crate
      const w = 15 * k, h = 20 * k;
      const top = shade(c, 1.15), left = shade(c, 0.85), right = shade(c, 0.65);
      ctx.fillStyle = rgb(left);
      ctx.beginPath();
      ctx.moveTo(-w * 2, 0);
      ctx.lineTo(0, w);
      ctx.lineTo(0, w - h);
      ctx.lineTo(-w * 2, -h);
      ctx.fill();
      ctx.fillStyle = rgb(right);
      ctx.beginPath();
      ctx.moveTo(w * 2, 0);
      ctx.lineTo(0, w);
      ctx.lineTo(0, w - h);
      ctx.lineTo(w * 2, -h);
      ctx.fill();
      ctx.fillStyle = rgb(top);
      ctx.beginPath();
      ctx.moveTo(0, w - h);
      ctx.lineTo(-w * 2, -h);
      ctx.lineTo(0, -w - h);
      ctx.lineTo(w * 2, -h);
      ctx.fill();
      ctx.strokeStyle = rgb(shade(c, 0.45));
      ctx.lineWidth = 1.2;
      ctx.stroke();
      return;
    }
    const pts: [number, number][] = [];
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI;
      pts.push([Math.cos(a) * (18 + rnd() * 6) * k, Math.sin(a) * (18 + rnd() * 10) * k + 4]);
    }
    const g = ctx.createLinearGradient(-20 * k, -24 * k, 18 * k, 6);
    g.addColorStop(0, rgb(shade(c, 1.25)));
    g.addColorStop(0.55, rgb(c));
    g.addColorStop(1, rgb(shade(c, 0.55)));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.quadraticCurveTo(0, 10 * k, pts[0]![0], pts[0]![1]);
    ctx.fill();
    ctx.strokeStyle = rgb(shade(c, 0.5), 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-4 * k, -14 * k);
    ctx.lineTo(2 * k, -4 * k);
    ctx.lineTo(-2 * k, 4 * k);
    ctx.stroke();
    if (ts.style === 'snow') {
      ctx.fillStyle = 'rgba(245,250,255,0.9)';
      ctx.beginPath();
      ctx.ellipse(-2 * k, -16 * k, 12 * k, 5 * k, -0.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  cache.set(key, s);
  return s;
}

export function plantSprite(ts: TilesetDef, variant: number): Sprite {
  const key = `plant:${ts.id}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const c0 = col(ts, 'plant', 0, '#7ab04a');
  const c1 = col(ts, 'plant', 1, '#e0d060');
  const c2 = col(ts, 'plant', 2, '#d06a8a');
  s = make(50, 44, 25, 34, (ctx) => {
    const n = 5 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const x = (rnd() - 0.5) * 22, y = (rnd() - 0.5) * 8;
      const h = 6 + rnd() * 10;
      ctx.strokeStyle = rgb(shade(c0, 0.75 + rnd() * 0.5));
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + (rnd() - 0.5) * 8, y - h * 0.6, x + (rnd() - 0.5) * 6, y - h);
      ctx.stroke();
    }
    if (variant % 2 === 0) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = rgb(rnd() < 0.5 ? c1 : c2);
        ctx.beginPath();
        ctx.arc((rnd() - 0.5) * 18, -6 - rnd() * 8, 2 + rnd() * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  cache.set(key, s);
  return s;
}

export function rubbleSprite(ts: TilesetDef, variant: number): Sprite {
  const key = `rubble:${ts.id}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const c = ts.roles.rubble?.colors?.length ? col(ts, 'rubble', 0, '#8a8680') : col(ts, 'rock', 0, '#8a8680');
  s = make(60, 30, 30, 18, (ctx) => {
    for (let i = 0; i < 7; i++) {
      const x = (rnd() - 0.5) * 30, y = (rnd() - 0.5) * 10, r = 2 + rnd() * 4;
      ctx.fillStyle = rgb(shade(c, 0.6));
      ctx.beginPath();
      ctx.ellipse(x + 1, y + 1, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgb(shade(c, 0.9 + rnd() * 0.4));
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  cache.set(key, s);
  return s;
}

export function pillarSprite(ts: TilesetDef): Sprite {
  const key = `pillar:${ts.id}`;
  let s = cache.get(key);
  if (s) return s;
  const c = col(ts, 'pillar', 0, '#8a8378');
  s = make(60, 150, 30, 134, (ctx) => {
    shadow(ctx, 22, 10, 0.4);
    const h = 104;
    const g = ctx.createLinearGradient(-13, 0, 13, 0);
    g.addColorStop(0, rgb(shade(c, 0.6)));
    g.addColorStop(0.4, rgb(shade(c, 1.2)));
    g.addColorStop(1, rgb(shade(c, 0.5)));
    ctx.fillStyle = g;
    ctx.fillRect(-12, -h, 24, h);
    ctx.fillStyle = rgb(shade(c, 1.05));
    ctx.fillRect(-16, -h - 8, 32, 9);
    ctx.fillRect(-16, -8, 32, 9);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = -8; x <= 8; x += 5) ctx.fillRect(x, -h, 1.5, h - 8);
  });
  cache.set(key, s);
  return s;
}

export function lightSprite(ts: TilesetDef, indoor: boolean): Sprite {
  const key = `light:${ts.id}:${indoor}`;
  let s = cache.get(key);
  if (s) return s;
  const post = col(ts, 'light', 0, '#5a4a3a');
  const flame = col(ts, 'light', 1, '#ffd080');
  s = make(50, 120, 25, 104, (ctx) => {
    shadow(ctx, 12, 5, 0.4);
    if (indoor || ts.style === 'stone' || ts.style === 'flesh' || ts.style === 'dirt') {
      // Brazier
      ctx.fillStyle = rgb(shade(post, 0.8));
      ctx.fillRect(-2, -26, 4, 26);
      ctx.fillStyle = rgb(post);
      ctx.beginPath();
      ctx.moveTo(-11, -30);
      ctx.lineTo(11, -30);
      ctx.lineTo(7, -22);
      ctx.lineTo(-7, -22);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.fillStyle = rgb(shade(post, 0.9));
    ctx.fillRect(-2.5, -70, 5, 70);
    ctx.fillStyle = rgb(post);
    ctx.fillRect(-6, -76, 12, 4);
    ctx.fillStyle = rgb(shade(flame, 1.1), 0.95);
    ctx.fillRect(-5, -88, 10, 12);
    ctx.fillStyle = rgb(shade(post, 0.7));
    ctx.fillRect(-7, -91, 14, 3);
  });
  cache.set(key, s);
  return s;
}

export function furnitureSprite(ts: TilesetDef, variant: number): Sprite {
  const key = `furn:${ts.id}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const rnd = prng(strHash(key));
  const c = col(ts, 'furniture', 0, '#7a5a3a');
  const kind = variant % 3;
  s = make(80, 110, 40, 86, (ctx) => {
    shadow(ctx, 24, 10, 0.35);
    const box = (w: number, d: number, h: number, base: [number, number, number], y0 = 0) => {
      ctx.fillStyle = rgb(shade(base, 0.8));
      ctx.beginPath();
      ctx.moveTo(-w, y0);
      ctx.lineTo(0, y0 + d);
      ctx.lineTo(0, y0 + d - h);
      ctx.lineTo(-w, y0 - h);
      ctx.fill();
      ctx.fillStyle = rgb(shade(base, 0.6));
      ctx.beginPath();
      ctx.moveTo(w, y0);
      ctx.lineTo(0, y0 + d);
      ctx.lineTo(0, y0 + d - h);
      ctx.lineTo(w, y0 - h);
      ctx.fill();
      ctx.fillStyle = rgb(shade(base, 1.12));
      ctx.beginPath();
      ctx.moveTo(0, y0 + d - h);
      ctx.lineTo(-w, y0 - h);
      ctx.lineTo(0, y0 - d - h);
      ctx.lineTo(w, y0 - h);
      ctx.fill();
    };
    if (kind === 0) {
      // Shelf with items
      box(24, 12, 54, c);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = rgb([100 + rnd() * 150, 80 + rnd() * 120, 60 + rnd() * 120]);
        ctx.fillRect(-20 + i * 6, -40 + (i % 2) * 18, 4, 9);
      }
    } else if (kind === 1) {
      // Table
      box(24, 12, 4, c, -16);
      ctx.fillStyle = rgb(shade(c, 0.5));
      ctx.fillRect(-20, -16, 3, 16);
      ctx.fillRect(17, -16, 3, 16);
      ctx.fillStyle = rgb([220, 210, 190]);
      ctx.beginPath();
      ctx.ellipse(-4, -22, 5, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Barrel / console
      if (ts.style === 'metal') {
        box(16, 8, 30, c);
        ctx.fillStyle = 'rgba(80,220,255,0.85)';
        ctx.fillRect(-12, -32, 10, 6);
      } else {
        const g = ctx.createLinearGradient(-12, 0, 12, 0);
        g.addColorStop(0, rgb(shade(c, 0.6)));
        g.addColorStop(0.5, rgb(shade(c, 1.15)));
        g.addColorStop(1, rgb(shade(c, 0.5)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, 0, 12, 6, 0, 0, Math.PI);
        ctx.lineTo(-12, -28);
        ctx.ellipse(0, -28, 12, 6, 0, Math.PI, 0, true);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rgb(shade(c, 0.8));
        ctx.beginPath();
        ctx.ellipse(0, -28, 12, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,40,40,0.6)';
        ctx.lineWidth = 2;
        for (const y of [-6, -22]) {
          ctx.beginPath();
          ctx.ellipse(0, y, 12, 6, 0, 0, Math.PI);
          ctx.stroke();
        }
      }
    }
  });
  cache.set(key, s);
  return s;
}

// ------------------------------------------------------------------------------- features

export function featureSprite(kind: string, ts: TilesetDef, state: { opened?: boolean; toggled?: boolean; disarmed?: boolean; empty?: boolean; locked?: boolean }, facing?: string): Sprite {
  const key = `f:${kind}:${ts.id}:${JSON.stringify(state)}:${facing ?? ''}`;
  let s = cache.get(key);
  if (s) return s;
  switch (kind) {
    case 'chest': {
      const c = col(ts, 'chest', 0, '#8a5a2a');
      const trim = col(ts, 'chest', 1, '#d0a040');
      s = make(70, 70, 35, 50, (ctx) => {
        shadow(ctx, 20, 8, 0.4);
        const w = 16, d = 8, h = 14;
        ctx.fillStyle = rgb(shade(c, 0.85));
        ctx.beginPath();
        ctx.moveTo(-w, 0);
        ctx.lineTo(w * 0.2, d);
        ctx.lineTo(w * 0.2, d - h);
        ctx.lineTo(-w, -h);
        ctx.fill();
        ctx.fillStyle = rgb(shade(c, 0.6));
        ctx.beginPath();
        ctx.moveTo(w, -2);
        ctx.lineTo(w * 0.2, d);
        ctx.lineTo(w * 0.2, d - h);
        ctx.lineTo(w, -h - 2);
        ctx.fill();
        if (state.opened) {
          ctx.fillStyle = rgb(shade(c, 0.35));
          ctx.beginPath();
          ctx.moveTo(w * 0.2, d - h);
          ctx.lineTo(-w, -h);
          ctx.lineTo(-w * 0.2, -h - d);
          ctx.lineTo(w, -h - 2);
          ctx.fill();
          ctx.fillStyle = rgb(shade(c, 1.05));
          ctx.beginPath();
          ctx.moveTo(-w, -h);
          ctx.lineTo(-w * 0.2, -h - d);
          ctx.lineTo(-w * 0.1, -h - d - 14);
          ctx.lineTo(-w - 0.5, -h - 15);
          ctx.fill();
          if (!state.empty) {
            ctx.fillStyle = 'rgba(255,215,90,0.9)';
            ctx.beginPath();
            ctx.ellipse(0, -h - 1, 8, 3, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.fillStyle = rgb(shade(c, 1.15));
          ctx.beginPath();
          ctx.moveTo(w * 0.2, d - h);
          ctx.lineTo(-w, -h);
          ctx.quadraticCurveTo(-w * 0.4, -h - d - 8, -w * 0.2 + 2, -h - d - 2);
          ctx.lineTo(w, -h - 2);
          ctx.quadraticCurveTo(w * 0.8, -h + 2, w * 0.2, d - h);
          ctx.fill();
          ctx.strokeStyle = rgb(trim);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-w * 0.4, -h + 3);
          ctx.lineTo(-w * 0.4, 3);
          ctx.stroke();
          ctx.fillStyle = rgb(trim);
          ctx.fillRect(-w * 0.4 - 2.5, -h + 4, 5, 5);
          if (state.locked) {
            ctx.fillStyle = '#c8c8d0';
            ctx.beginPath();
            ctx.arc(-w * 0.4, -h + 11, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });
      break;
    }
    case 'door': {
      const c = col(ts, 'door', 0, '#6a4a2a');
      s = make(60, 100, 30, 80, (ctx) => {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.moveTo(-14, 6);
        ctx.lineTo(-14, -34);
        ctx.quadraticCurveTo(0, -50, 14, -34);
        ctx.lineTo(14, 6);
        ctx.closePath();
        ctx.fill();
        const g = ctx.createLinearGradient(-12, 0, 12, 0);
        g.addColorStop(0, rgb(shade(c, 0.7)));
        g.addColorStop(0.5, rgb(shade(c, 1.15)));
        g.addColorStop(1, rgb(shade(c, 0.6)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-11, 4);
        ctx.lineTo(-11, -32);
        ctx.quadraticCurveTo(0, -45, 11, -32);
        ctx.lineTo(11, 4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        for (const x of [-4, 3]) {
          ctx.beginPath();
          ctx.moveTo(x, 4);
          ctx.lineTo(x, -38);
          ctx.stroke();
        }
        ctx.fillStyle = '#d8c070';
        ctx.beginPath();
        ctx.arc(7, -14, 1.8, 0, Math.PI * 2);
        ctx.fill();
      });
      break;
    }
    case 'exit': {
      s = make(80, 80, 40, 50, (ctx) => {
        if (facing) {
          // Edge exit: glowing chevrons
          ctx.strokeStyle = 'rgba(255,230,160,0.85)';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.shadowColor = 'rgba(255,200,120,0.9)';
          ctx.shadowBlur = 8;
          for (let i = 0; i < 2; i++) {
            ctx.beginPath();
            ctx.moveTo(-10, -4 - i * 8);
            ctx.lineTo(0, -12 - i * 8);
            ctx.lineTo(10, -4 - i * 8);
            ctx.stroke();
          }
          return;
        }
        // Dungeon entrance / stairs
        const c = col(ts, 'exit', 0, '#3a3030');
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 26, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = rgb(shade(c, 1.4 - i * 0.25));
          ctx.beginPath();
          ctx.ellipse(-4 + i * 3, -2 + i * 2.5, 18 - i * 4, 5 - i, 0, Math.PI, 0);
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,220,150,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, 27, 14, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
      break;
    }
    case 'shrine': {
      const c = col(ts, 'shrine', 0, '#c0c0d0');
      const glow = col(ts, 'shrine', 1, '#80e0ff');
      s = make(80, 120, 40, 96, (ctx) => {
        shadow(ctx, 24, 10, 0.4);
        ctx.fillStyle = rgb(shade(c, 0.7));
        ctx.beginPath();
        ctx.moveTo(-22, 0);
        ctx.lineTo(0, 11);
        ctx.lineTo(22, 0);
        ctx.lineTo(22, -10);
        ctx.lineTo(0, 1);
        ctx.lineTo(-22, -10);
        ctx.fill();
        ctx.fillStyle = rgb(shade(c, 1.05));
        ctx.beginPath();
        ctx.moveTo(-22, -10);
        ctx.lineTo(0, 1);
        ctx.lineTo(22, -10);
        ctx.lineTo(0, -21);
        ctx.fill();
        ctx.fillStyle = rgb(shade(c, 0.85));
        ctx.fillRect(-6, -48, 12, 34);
        ctx.shadowColor = rgb(glow);
        ctx.shadowBlur = 14;
        ctx.fillStyle = rgb(shade(glow, 1.2));
        ctx.beginPath();
        ctx.moveTo(0, -74);
        ctx.lineTo(8, -60);
        ctx.lineTo(0, -48);
        ctx.lineTo(-8, -60);
        ctx.closePath();
        ctx.fill();
      });
      break;
    }
    case 'sign': {
      const c = col(ts, 'sign', 0, '#7a5a3a');
      const board = col(ts, 'sign', 1, '#e0d0b0');
      s = make(60, 90, 30, 74, (ctx) => {
        shadow(ctx, 10, 4, 0.4);
        ctx.fillStyle = rgb(shade(c, 0.8));
        ctx.fillRect(-2, -44, 4, 44);
        ctx.fillStyle = rgb(mix(c, board, 0.5));
        ctx.beginPath();
        ctx.moveTo(-18, -52);
        ctx.lineTo(18, -46);
        ctx.lineTo(18, -32);
        ctx.lineTo(-18, -38);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,30,20,0.6)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(-13, -47 + i * 4 + i * 0.6);
          ctx.lineTo(12, -42 + i * 4 + i * 0.6);
          ctx.stroke();
        }
      });
      break;
    }
    case 'lever': {
      const c = col(ts, 'lever', 0, '#6a6a70');
      const knob = col(ts, 'lever', 1, '#d04040');
      s = make(60, 70, 30, 50, (ctx) => {
        shadow(ctx, 12, 5, 0.4);
        ctx.fillStyle = rgb(shade(c, 0.8));
        ctx.fillRect(-10, -10, 20, 10);
        ctx.fillStyle = rgb(c);
        ctx.fillRect(-10, -14, 20, 4);
        const a = state.toggled ? 0.6 : -0.6;
        ctx.strokeStyle = rgb(shade(c, 1.2));
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -12);
        ctx.lineTo(Math.sin(a) * 22, -12 - Math.cos(a) * 22);
        ctx.stroke();
        ctx.fillStyle = rgb(knob);
        ctx.beginPath();
        ctx.arc(Math.sin(a) * 22, -12 - Math.cos(a) * 22, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      break;
    }
    case 'gate': {
      const c = col(ts, 'wall', 0, '#6a6a70');
      s = make(80, 120, 40, 90, (ctx) => {
        if (state.toggled) {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(-24, -6, 48, 6);
          return;
        }
        ctx.strokeStyle = rgb(shade(c, 0.9));
        ctx.lineWidth = 3;
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(i * 7, 4 + i * 3.5);
          ctx.lineTo(i * 7, -56 + i * 3.5);
          ctx.stroke();
        }
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-24, -44 - 12);
        ctx.lineTo(24, -44 + 12);
        ctx.stroke();
      });
      break;
    }
    case 'lore': {
      s = make(50, 60, 25, 40, (ctx) => {
        ctx.shadowColor = state.opened ? 'transparent' : 'rgba(255,230,140,0.9)';
        ctx.shadowBlur = state.opened ? 0 : 10;
        ctx.fillStyle = state.opened ? '#bfb39a' : '#efe2c0';
        ctx.beginPath();
        ctx.moveTo(-12, -4);
        ctx.lineTo(4, 4);
        ctx.lineTo(12, -2);
        ctx.lineTo(-4, -10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(80,60,40,0.6)';
        ctx.lineWidth = 0.8;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(-8 + i * 2, -5 - i);
          ctx.lineTo(4 + i * 2, 1 - i);
          ctx.stroke();
        }
      });
      break;
    }
    case 'bed': {
      const c = col(ts, 'bed', 0, '#7a4a3a');
      const sheet = col(ts, 'bed', 1, '#d0c0a0');
      s = make(90, 70, 45, 46, (ctx) => {
        shadow(ctx, 30, 12, 0.35);
        ctx.fillStyle = rgb(shade(c, 0.7));
        ctx.beginPath();
        ctx.moveTo(-30, -2);
        ctx.lineTo(0, 13);
        ctx.lineTo(28, -1);
        ctx.lineTo(28, -9);
        ctx.lineTo(0, 5);
        ctx.lineTo(-30, -10);
        ctx.fill();
        ctx.fillStyle = rgb(sheet);
        ctx.beginPath();
        ctx.moveTo(-30, -10);
        ctx.lineTo(0, 5);
        ctx.lineTo(28, -9);
        ctx.lineTo(-2, -24);
        ctx.fill();
        ctx.fillStyle = rgb(shade(sheet, 1.15));
        ctx.beginPath();
        ctx.ellipse(-16, -15, 8, 4, 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgb(shade(c, 1));
        ctx.fillRect(-32, -24, 4, 16);
      });
      break;
    }
    case 'craft_station': {
      s = make(70, 70, 35, 50, (ctx) => {
        shadow(ctx, 20, 8, 0.4);
        ctx.fillStyle = '#4a4a52';
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.lineTo(8, 0);
        ctx.lineTo(5, -14);
        ctx.lineTo(-5, -14);
        ctx.fill();
        ctx.fillStyle = '#6a6a74';
        ctx.beginPath();
        ctx.moveTo(-20, -14);
        ctx.lineTo(16, -14);
        ctx.quadraticCurveTo(22, -16, 22, -20);
        ctx.lineTo(-14, -22);
        ctx.quadraticCurveTo(-20, -20, -20, -14);
        ctx.fill();
        ctx.fillStyle = '#8a8a96';
        ctx.fillRect(-14, -24, 30, 3);
      });
      break;
    }
    case 'waypoint': {
      s = make(90, 60, 45, 30, (ctx) => {
        ctx.strokeStyle = 'rgba(160,220,255,0.85)';
        ctx.shadowColor = 'rgba(120,200,255,1)';
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, 26, 13, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, 0, 17, 8.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 17, Math.sin(a) * 8.5);
          ctx.lineTo(Math.cos(a) * 26, Math.sin(a) * 13);
          ctx.stroke();
        }
      });
      break;
    }
    case 'trap': {
      s = make(70, 40, 35, 20, (ctx) => {
        ctx.fillStyle = state.disarmed ? 'rgba(120,120,120,0.6)' : 'rgba(150,40,30,0.55)';
        ctx.beginPath();
        ctx.moveTo(-22, 0);
        ctx.lineTo(0, 11);
        ctx.lineTo(22, 0);
        ctx.lineTo(0, -11);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = state.disarmed ? 'rgba(200,200,200,0.6)' : 'rgba(255,90,70,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (!state.disarmed) {
          ctx.fillStyle = 'rgba(230,220,210,0.9)';
          for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(i * 6 - 2, i * 0 + 2);
            ctx.lineTo(i * 6, -6);
            ctx.lineTo(i * 6 + 2, 2);
            ctx.fill();
          }
        }
      });
      break;
    }
    default:
      s = make(10, 10, 5, 5, () => {});
  }
  cache.set(key, s);
  return s;
}

export function clearPropCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------------------- generated art

const imageCache = new Map<string, Sprite>();

/**
 * A generated image as a map sprite: scaled to fit a height and width, anchored at its base, with a soft
 * contact shadow baked under it (generated art has no ground). Mirroring gives repeated props variety.
 */
export function imageSprite(img: HTMLImageElement, key: string, maxH: number, maxW: number, mirror = false): Sprite {
  const k = `${key}:${maxH}:${maxW}:${mirror}`;
  const hit = imageCache.get(k);
  if (hit) return hit;
  const sc = Math.min(maxH / img.naturalHeight, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
  const padX = Math.round(w * 0.15) + 4, padB = Math.round(Math.max(6, w * 0.08));
  const s2 = make(w + padX * 2, h + padB, padX + w / 2, h, (ctx) => {
    shadow(ctx, Math.max(8, w * 0.42), Math.max(4, w * 0.13), 0.42);
    ctx.save();
    if (mirror) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h + 2, w, h);
    ctx.restore();
  });
  imageCache.set(k, s2);
  return s2;
}

/** Size limits (height, width) for generated features and props on the map, in pixels at zoom 1. */
export const ART_SIZE: Record<string, [number, number]> = {
  tree: [150, 130], pillar: [125, 70], light: [92, 50], furniture: [74, 96], rock: [52, 64], plant: [38, 48], rubble: [30, 52],
  chest: [40, 50], shrine: [76, 70], sign: [56, 46], lever: [42, 38], bed: [46, 72], craft_station: [64, 78],
};
