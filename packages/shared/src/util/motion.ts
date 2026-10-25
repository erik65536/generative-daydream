import type { Motion } from '../protocol';

export interface MotionSample {
  x: number;
  y: number;
  /** Index of the path tile being walked toward. */
  index: number;
  done: boolean;
  facing: number;
}

/** Where an actor following `m` is at time `t` (ms, same clock as m.t0). */
export function sampleMotion(m: Motion, t: number): MotionSample {
  let remaining = Math.max(0, ((t - m.t0) / 1000) * m.speed);
  let px = m.from.x, py = m.from.y;
  let facing = 0;
  for (let i = 0; i < m.path.length; i++) {
    const p = m.path[i]!;
    const seg = Math.hypot(p.x - px, p.y - py);
    facing = Math.atan2(p.y - py, p.x - px);
    if (remaining < seg) {
      const f = seg > 0 ? remaining / seg : 1;
      return { x: px + (p.x - px) * f, y: py + (p.y - py) * f, index: i, done: false, facing };
    }
    remaining -= seg;
    px = p.x;
    py = p.y;
  }
  return { x: px, y: py, index: m.path.length, done: true, facing };
}
