import { useEffect, useRef } from 'react';
import { hexToRgb, mix, rgb } from '../render/color';

/** Slow, atmospheric animated background for menu screens. */
export function Backdrop({ palette }: { palette?: { primary: string; secondary: string; accent: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    // A little drifting dust, barely there.
    const motes = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random(), p: Math.random() * 10 }));
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
      ctx.strokeStyle = 'rgba(255,255,255,0.025)';
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
        const a = (0.05 + Math.sin(m.p + m.s * 6) * 0.03 + m.s * 0.05) * 0.8;
        const r = 0.6 + m.s * 1.2;
        const gr = ctx.createRadialGradient(m.x * w, m.y * h, 0, m.x * w, m.y * h, r * 4);
        gr.addColorStop(0, `rgba(210,205,195,${a})`);
        gr.addColorStop(1, 'rgba(210,205,195,0)');
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

/**
 * A daydream's banner from its own art: the painting of its first place, with some of its people and foes standing
 * in front. Until art exists, a plain dark field in its palette.
 */
export function DaydreamArt({ id, palette, art, height = 120 }: { id: string; palette: { primary: string; secondary: string; accent: string }; art?: { scene?: string; figures: string[] }; height?: number }) {
  const url = (f: string) => `/api/worlds/${id}/assets/${f}`;
  return (
    <div className="daydream-art" style={{ height, ['--dd-tint' as string]: palette.secondary }}>
      {art?.scene && <div className="dd-scene" style={{ backgroundImage: `url(${url(art.scene)})` }} />}
      <div className="dd-shade" />
      <div className="dd-figures">
        {art?.figures.map((f) => <img key={f} src={url(f)} alt="" style={{ height: height * 0.86 }} />)}
      </div>
    </div>
  );
}
