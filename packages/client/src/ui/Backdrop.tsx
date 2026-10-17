import { useEffect, useRef } from 'react';
import { hexToRgb, mix, prng, rgb, strHash } from '../render/textures';

/** Slow, atmospheric animated background for menu screens. */
export function Backdrop({ palette }: { palette?: { primary: string; secondary: string; accent: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random(), p: Math.random() * 10 }));
    const accent = hexToRgb(palette?.accent ?? '#d9b56a');
    const second = hexToRgb(palette?.secondary ?? '#2a2440');
    const draw = (t: number) => {
      const w = (c.width = window.innerWidth);
      const h = (c.height = window.innerHeight);
      const g = ctx.createRadialGradient(w * 0.5, h * 0.15, 0, w * 0.5, h * 0.4, Math.max(w, h));
      g.addColorStop(0, rgb(mix(second, [20, 16, 26], 0.55)));
      g.addColorStop(0.6, '#0c0a10');
      g.addColorStop(1, '#060508');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // Isometric grid fading into the distance
      ctx.save();
      ctx.translate(w / 2, h * 0.62);
      ctx.strokeStyle = rgb(accent, 0.05);
      ctx.lineWidth = 1;
      const off = (t / 120) % 64;
      for (let i = -30; i <= 30; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 64 - 2000 + off, -1000);
        ctx.lineTo(i * 64 + 2000 + off, 1000);
        ctx.moveTo(i * 64 + 2000 - off, -1000);
        ctx.lineTo(i * 64 - 2000 - off, 1000);
        ctx.stroke();
      }
      ctx.restore();
      const fade = ctx.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0, 'rgba(6,5,8,1)');
      fade.addColorStop(0.4, 'rgba(6,5,8,0.2)');
      fade.addColorStop(1, 'rgba(6,5,8,0.9)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      for (const m of motes) {
        m.p += 0.016;
        m.y -= 0.00008 * (1 + m.s * 2);
        m.x += Math.sin(m.p * 0.3 + m.s * 8) * 0.00012;
        if (m.y < -0.02) m.y = 1.02;
        const a = 0.15 + Math.sin(m.p + m.s * 6) * 0.15 + m.s * 0.3;
        const r = 1 + m.s * 2.5;
        const gr = ctx.createRadialGradient(m.x * w, m.y * h, 0, m.x * w, m.y * h, r * 4);
        gr.addColorStop(0, rgb(accent, a));
        gr.addColorStop(1, rgb(accent, 0));
        ctx.fillStyle = gr;
        ctx.fillRect(m.x * w - r * 4, m.y * h - r * 4, r * 8, r * 8);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [palette?.accent, palette?.secondary]);
  return <canvas ref={ref} className="bg-canvas" />;
}

/** A small painted landscape vignette derived from a world's palette and id. */
export function WorldArt({ id, palette, height = 120 }: { id: string; palette: { primary: string; secondary: string; accent: string }; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const w = (c.width = 640);
    const h = (c.height = height * 2);
    const ctx = c.getContext('2d')!;
    const rnd = prng(strHash(id));
    const p = hexToRgb(palette.primary), s = hexToRgb(palette.secondary), a = hexToRgb(palette.accent);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, rgb(mix(s, [10, 10, 20], 0.5)));
    sky.addColorStop(0.7, rgb(mix(a, s, 0.55)));
    sky.addColorStop(1, rgb(mix(a, [255, 220, 180], 0.3)));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.6})`;
      ctx.fillRect(rnd() * w, rnd() * h * 0.5, 1.5, 1.5);
    }
    ctx.fillStyle = rgb(mix(a, [255, 240, 200], 0.6), 0.9);
    ctx.beginPath();
    ctx.arc(w * (0.2 + rnd() * 0.6), h * (0.25 + rnd() * 0.2), 14 + rnd() * 12, 0, Math.PI * 2);
    ctx.fill();
    for (let layer = 0; layer < 4; layer++) {
      const col = mix(mix(s, p, layer / 3), [6, 5, 8], 0.35 + layer * 0.15);
      ctx.fillStyle = rgb(col);
      ctx.beginPath();
      ctx.moveTo(0, h);
      const base = h * (0.45 + layer * 0.13);
      let y = base;
      for (let x = 0; x <= w; x += 16) {
        y += (rnd() - 0.5) * 22;
        y = Math.max(base - 40, Math.min(base + 30, y));
        ctx.lineTo(x, y);
        if (layer === 2 && rnd() < 0.08) {
          ctx.lineTo(x + 3, y - 18 - rnd() * 20);
          ctx.lineTo(x + 6, y);
        }
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }
  }, [id, palette.primary, palette.secondary, palette.accent, height]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
