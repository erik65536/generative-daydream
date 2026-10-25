/**
 * Actor animation: sprite sheets rendered from each actor's 3D rig at the game's camera.
 *
 * One sheet per clip. A sheet has a row per screen direction (in `ANIM_DIRS` order) and a column per frame; every
 * cell is the same size, and the ground point under the actor sits at the same anchor in every cell. Sheets are
 * drawn at `scale` sheet pixels per game picture pixel (2: crisp when the view zooms in).
 */
import { PX_PER_METRE } from './nav';

/** Screen directions, clockwise from straight down the screen (toward the viewer). */
export const ANIM_DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;
export type AnimDir = (typeof ANIM_DIRS)[number];

/** What gameplay plays: standing, moving (walk below `RUN_SPEED`, run above), a blow, a spell, taking a hit, falling. */
export const ACTOR_CLIPS = ['idle', 'walk', 'run', 'attack', 'cast', 'hit', 'die'] as const;
export type ClipName = (typeof ACTOR_CLIPS)[number];

/** Body plans the animator can rig and move. */
export type BodyPlan = 'humanoid' | 'quadruped' | 'floater';

export interface AnimClip {
  frames: number;
  fps: number;
  loop: boolean;
  /** Ground metres the body travels in one loop of a gait: playback keeps pace with movement. */
  stride?: number;
  /** The frame where the blow lands or the spell leaves (0-based). */
  event?: number;
}

/** On a sprite's asset record: how to read its clip sheets (each saved as asset `<key>@anim-<clip>`). */
export interface ActorAnim {
  body: BodyPlan;
  /** Sheet pixels per game picture pixel. */
  scale: number;
  /** Cell size in sheet pixels. */
  cell: [number, number];
  /** The ground point under the actor within a cell, in sheet pixels. */
  anchor: [number, number];
  /** Height of the figure in metres when standing. */
  height: number;
  /** The standing view's image file the sheets were made from (a repainted actor is animated again). */
  from: string;
  clips: Partial<Record<ClipName, AnimClip>>;
}

/** Moving faster than this (metres per second) plays the run instead of the walk. */
export const RUN_SPEED = 2.6;

/** The asset key of one clip's sheet. */
export const clipKey = (spriteKey: string, clip: ClipName) => `${spriteKey}@anim-${clip}`;

/**
 * The sheet row for a ground direction (metres: x and y as in the game, y down the screen): "down the screen" is S.
 */
export function dirRow(dx: number, dy: number): number {
  const sx = dx * PX_PER_METRE, sy = dy * PX_PER_METRE;
  if (!sx && !sy) return 0;
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI; // 90 = straight down the screen
  return (((Math.round((deg - 90) / 45) % 8) + 8) % 8);
}

/**
 * The frame to show `t` seconds into a clip: looping clips wrap, others hold their last frame. A gait's `pace`
 * (ground metres per second) sets its speed through the stride.
 */
export function clipFrame(clip: AnimClip, t: number, pace?: number): number {
  const rate = clip.stride && pace ? (pace / clip.stride) * clip.frames : clip.fps;
  const f = Math.floor(Math.max(0, t) * rate);
  return clip.loop ? f % clip.frames : Math.min(clip.frames - 1, f);
}

/** How long a one-shot clip plays, in seconds. */
export const clipDuration = (clip: AnimClip) => clip.frames / clip.fps;
