/** Particles, projectiles, floating combat text and weather. All positions are in tile space + height. */
import { kindColor } from '../rules';

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  color: string;
  glow?: boolean;
  gravity?: number;
  kind?: 'spark' | 'smoke' | 'ring' | 'beam' | 'text';
  text?: string;
  /** ring radius in tiles, beam target */
  r?: number;
  tx?: number;
  ty?: number;
  font?: string;
}

export interface Projectile {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  color: string;
  kind: 'bolt' | 'arrow' | 'beam';
  onHit?: () => void;
  arc: number;
}

export class FxSystem {
  particles: Particle[] = [];
  projectiles: Projectile[] = [];

  update(dt: number) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.gravity) p.vz -= p.gravity * dt;
      if (p.z < 0 && p.gravity) {
        p.z = 0;
        p.vz *= -0.3;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const pr of this.projectiles) {
      pr.t += dt;
      if (pr.t >= pr.dur && pr.onHit) {
        pr.onHit();
        pr.onHit = undefined;
      }
      if (pr.kind !== 'beam') {
        const f = Math.min(1, pr.t / pr.dur);
        const x = pr.x0 + (pr.x1 - pr.x0) * f, y = pr.y0 + (pr.y1 - pr.y0) * f;
        if (Math.random() < 0.8) this.spark(x, y, 1 + Math.sin(f * Math.PI) * pr.arc, pr.color, 0.25, 0.35, 2.2);
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.t < p.dur + (p.kind === 'beam' ? 0.18 : 0));
  }

  spark(x: number, y: number, z: number, color: string, life = 0.6, speed = 1, size = 3, glow = true) {
    this.particles.push({ x, y, z, vx: (Math.random() - 0.5) * speed, vy: (Math.random() - 0.5) * speed, vz: Math.random() * speed * 1.4, life, max: life, size, color, glow, kind: 'spark' });
  }

  burst(x: number, y: number, color: string, n = 18, speed = 2.4, z = 0.8, gravity = 0) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: (Math.random() - 0.2) * s, life: 0.5 + Math.random() * 0.4, max: 0.9, size: 2 + Math.random() * 3, color, glow: true, gravity, kind: 'spark' });
    }
  }

  ring(x: number, y: number, r: number, color: string, life = 0.55) {
    this.particles.push({ x, y, z: 0.05, vx: 0, vy: 0, vz: 0, life, max: life, size: 3, color, kind: 'ring', r });
  }

  rise(x: number, y: number, color: string, n = 14) {
    for (let i = 0; i < n; i++)
      this.particles.push({ x: x + (Math.random() - 0.5) * 0.8, y: y + (Math.random() - 0.5) * 0.8, z: Math.random() * 0.5, vx: 0, vy: 0, vz: 0.9 + Math.random() * 0.9, life: 0.8 + Math.random() * 0.5, max: 1.3, size: 2 + Math.random() * 2.5, color, glow: true, kind: 'spark' });
  }

  smoke(x: number, y: number, color = 'rgba(80,70,70,0.5)', n = 10) {
    for (let i = 0; i < n; i++)
      this.particles.push({ x: x + (Math.random() - 0.5) * 0.6, y: y + (Math.random() - 0.5) * 0.6, z: 0.3, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, vz: 0.4 + Math.random() * 0.4, life: 1 + Math.random() * 0.6, max: 1.6, size: 8 + Math.random() * 8, color, kind: 'smoke' });
  }

  text(x: number, y: number, text: string, color: string, big = false) {
    // Stack texts so simultaneous numbers don't overlap.
    const near = this.particles.filter((p) => p.kind === 'text' && Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 && p.life > p.max - 0.4).length;
    this.particles.push({ x, y, z: 1.9 + near * 0.35, vx: 0, vy: 0, vz: 0.7, life: big ? 1.6 : 1.25, max: big ? 1.6 : 1.25, size: big ? 22 : 15, color, kind: 'text', text, font: big ? '700 22px Cinzel, serif' : '700 15px Inter, sans-serif' });
  }

  damage(x: number, y: number, amount: number, type: string, crit?: boolean) {
    const color = kindColor(type, '#ffffff');
    this.text(x, y, `${type === 'heal' || type === 'barrier' ? '+' : ''}${amount}${crit ? '!' : ''}`, color, !!crit);
  }

  projectile(x0: number, y0: number, x1: number, y1: number, color: string, kind: Projectile['kind'], onHit?: () => void) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    this.projectiles.push({ x0, y0, x1, y1, t: 0, dur: kind === 'beam' ? 0.12 : Math.max(0.15, d / (kind === 'arrow' ? 22 : 14)), color, kind, onHit, arc: kind === 'arrow' ? Math.min(1.2, d * 0.08) : 0.2 });
  }
}

export interface WeatherDrop {
  x: number;
  y: number;
  z: number;
  v: number;
  phase: number;
}
