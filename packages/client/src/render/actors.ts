/**
 * Animated actors: which clip an actor plays and which cell of its sheet to draw (see shared world/anim.ts).
 *
 * Dead or downed actors fall and stay down; attacks, spells and hits play once over whatever else is going on;
 * moving actors walk, or run above RUN_SPEED, at a frame rate that keeps their feet with the ground; otherwise idle.
 * The row is the screen direction the actor faces.
 */
import { RUN_SPEED, clipDuration, dirRow, type ActorAnim, type AnimClip, type ClipName } from '@gd/shared';

export interface Motion {
  /** The clip playing and how long it has played (seconds). */
  clip: ClipName;
  t: number;
  /** A gait's phase in loops (walk and run share it, so switching between them keeps the step). */
  phase: number;
  /** A one-shot clip playing over the base motion (attack, cast, hit). */
  once?: ClipName;
  /** Ground speed, smoothed (metres per second). */
  speed: number;
}

export const newMotion = (): Motion => ({ clip: 'idle', t: 0, phase: 0, speed: 0 });

/** Start a one-shot clip (a blow, a spell, a flinch), unless the actor is down. */
export function playOnce(m: Motion, clip: ClipName, anim: ActorAnim | undefined) {
  if (m.clip === 'die' || !anim?.clips[clip]) return;
  // A flinch does not interrupt the actor's own blow or spell.
  if (clip === 'hit' && m.once && m.once !== 'hit') return;
  m.once = clip;
  m.clip = clip;
  m.t = 0;
}

/**
 * Advance a motion by `dt` seconds. `moving` and `speed` (ground metres per second) come from the actor's
 * displayed position; `down` is dead or downed.
 */
export function advance(m: Motion, anim: ActorAnim, dt: number, moving: boolean, speed: number, down: boolean) {
  m.speed += (speed - m.speed) * Math.min(1, dt * 8);
  let want: ClipName;
  if (down && anim.clips.die) want = 'die';
  else if (m.once && m.t + dt < clipDuration(anim.clips[m.once]!)) want = m.once;
  else {
    m.once = undefined;
    want = moving ? (m.speed > RUN_SPEED && anim.clips.run ? 'run' : 'walk') : 'idle';
    if (!anim.clips[want]) want = 'idle';
  }
  if (want !== m.clip) {
    m.clip = want;
    m.t = 0;
  } else m.t += dt;
  const c = anim.clips[want];
  if (c?.stride) m.phase += (dt * Math.max(m.speed, 0.4)) / c.stride;
}

/** The sheet column for a motion. */
export function frameOf(m: Motion, c: AnimClip): number {
  if (c.stride) return Math.floor((((m.phase % 1) + 1) % 1) * c.frames) % c.frames;
  const f = Math.floor(m.t * c.fps);
  return c.loop ? f % c.frames : Math.min(c.frames - 1, f);
}

/** The sheet row for a ground facing angle (radians, as the game's `facing`). */
export const rowOf = (face: number) => dirRow(Math.cos(face), Math.sin(face));

/**
 * Draw one cell of a clip sheet with its anchor at the current origin (the actor's feet). `size` is the actor's
 * size scale; the sheet is `anim.scale` times the game's picture resolution.
 */
export function drawCell(ctx: CanvasRenderingContext2D, sheet: HTMLImageElement, anim: ActorAnim, frame: number, row: number, size: number) {
  const [cw, ch] = anim.cell, [ax, ay] = anim.anchor, k = size / anim.scale;
  ctx.drawImage(sheet, frame * cw, row * ch, cw, ch, -ax * k, -ay * k, cw * k, ch * k);
}

/** Picture pixels the cell reaches left/right of the feet, above them and below them (for lighting and hit boxes). */
export function cellBounds(anim: ActorAnim, size: number) {
  const k = size / anim.scale;
  return { half: Math.max(anim.anchor[0], anim.cell[0] - anim.anchor[0]) * k, above: anim.anchor[1] * k, below: (anim.cell[1] - anim.anchor[1]) * k };
}
