import { describe, expect, it } from 'vitest';
import type { ActorAnim } from '@gd/shared';
import { advance, frameOf, newMotion, playOnce, rowOf } from '../src/render/actors';

const anim: ActorAnim = {
  v: 1, body: 'humanoid', scale: 2, cell: [100, 120], anchor: [50, 100], height: 1.75, from: 'x.png',
  clips: {
    idle: { frames: 20, fps: 8, loop: true },
    walk: { frames: 16, fps: 12, loop: true, stride: 1 },
    run: { frames: 12, fps: 14, loop: true, stride: 2.4 },
    attack: { frames: 24, fps: 15, loop: false, event: 6 },
    hit: { frames: 6, fps: 15, loop: false },
    die: { frames: 30, fps: 12, loop: false },
  },
};
const step = (m: ReturnType<typeof newMotion>, s: number, moving: boolean, speed: number, down = false) => {
  for (let t = 0; t < s; t += 0.05) advance(m, anim, 0.05, moving, speed, down);
};

describe('actor motion', () => {
  it('idles, walks, and runs when fast', () => {
    const m = newMotion();
    step(m, 0.5, false, 0);
    expect(m.clip).toBe('idle');
    step(m, 0.5, true, 1.2);
    expect(m.clip).toBe('walk');
    step(m, 1, true, 4.2);
    expect(m.clip).toBe('run');
  });

  it('keeps the feet with the ground: a walk at one stride per second loops once a second', () => {
    const m = newMotion();
    step(m, 1, true, 1);
    const p0 = m.phase;
    step(m, 1, true, 1);
    expect(m.phase - p0).toBeCloseTo(1, 1);
    expect(frameOf(m, anim.clips.walk!)).toBeGreaterThanOrEqual(0);
  });

  it('plays a blow once over the walk, and a hit does not cut it short', () => {
    const m = newMotion();
    step(m, 0.3, true, 1);
    playOnce(m, 'attack', anim);
    step(m, 0.5, true, 1);
    expect(m.clip).toBe('attack');
    playOnce(m, 'hit', anim);
    expect(m.clip).toBe('attack');
    step(m, 1.2, true, 1);
    expect(m.clip).toBe('walk');
    playOnce(m, 'hit', anim);
    expect(m.clip).toBe('hit');
    expect(frameOf(m, anim.clips.hit!)).toBe(0);
  });

  it('falls and stays down, ignoring blows, then stands again', () => {
    const m = newMotion();
    step(m, 5, false, 0, true);
    expect(m.clip).toBe('die');
    expect(frameOf(m, anim.clips.die!)).toBe(29);
    playOnce(m, 'attack', anim);
    expect(m.clip).toBe('die');
    step(m, 0.2, false, 0, false);
    expect(m.clip).toBe('idle');
  });

  it('skips clips the actor has none of', () => {
    const m = newMotion();
    playOnce(m, 'cast', anim);
    expect(m.once).toBeUndefined();
  });

  it('faces the row of its ground direction', () => {
    expect(rowOf(Math.PI / 4)).toBe(0); // ground (1, 1): down the screen
    expect(rowOf(-Math.PI / 4)).toBe(6); // (1, -1): right
  });
});
