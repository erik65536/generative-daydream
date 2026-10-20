/**
 * How people walk among each other on a place's ground (metres), shared by the server's rules and the client's
 * previews. People are discs of BODY metres, so two never stand closer than SPACING; a walk goes around strangers
 * and can squeeze past allies at a cost.
 */
import { NAV_CELL, type Nav, type NavPathOptions } from './nav';
import type { Vec2 } from '../util/grid';

/** A person's radius in metres. */
export const BODY = 0.45;
/** The closest two people stand. */
export const SPACING = 2 * BODY;
/** Extra walking cost (metres) per metre walked through an ally. */
export const SQUEEZE = 2;

/** Someone else on the ground, as a walk sees them. */
export interface Walker extends Vec2 {
  ally: boolean;
}

/** Within SPACING of someone in the list. */
export const crowded = (others: Vec2[], p: Vec2) => others.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < SPACING - 0.01);

/** Walking options among others: a stranger's body blocks, an ally's costs SQUEEZE per metre (`cost` adds more per metre). */
export function walkAmong(nav: Nav, others: Walker[], cost?: (p: Vec2) => number): NavPathOptions {
  const strangers = others.filter((o) => !o.ally), allies = others.filter((o) => o.ally);
  return {
    blocked: strangers.length ? (cx, cy) => crowded(strangers, nav.centre(cx, cy)) : undefined,
    extraCost: (cx, cy) => {
      const c = nav.centre(cx, cy);
      return NAV_CELL * ((crowded(allies, c) ? SQUEEZE : 0) + (cost?.(c) ?? 0));
    },
  };
}

/** The extra cost per metre at p of walking among these allies (plus `cost`). */
export const squeezeCost = (allies: Vec2[], cost?: (p: Vec2) => number) => (p: Vec2) => (crowded(allies, p) ? SQUEEZE : 0) + (cost?.(p) ?? 0);

/** Cost of walking a path: metres plus the extra cost per metre `extra` gives, sampled every quarter metre. */
export function walkCost(from: Vec2, path: Vec2[], extra: (p: Vec2) => number): number {
  let total = 0, p = from;
  for (const q of path) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) total += (len / n) * (1 + extra({ x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n }));
    p = q;
  }
  return total;
}

/**
 * The part of a path that costs at most `budget` (ending exactly where the budget runs out), backed off until
 * it ends on a free spot. Empty when not even a step fits.
 */
export function cutPath(from: Vec2, path: Vec2[], budget: number, extra: (p: Vec2) => number, free: (p: Vec2) => boolean): Vec2[] {
  const out: Vec2[] = [];
  let spent = 0, p = from;
  walk: for (const q of path) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) {
      const s = { x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n };
      const step = (len / n) * (1 + extra(s));
      if (spent + step > budget + 1e-6) {
        if (i > 1) out.push({ x: p.x + ((q.x - p.x) * (i - 1)) / n, y: p.y + ((q.y - p.y) * (i - 1)) / n });
        break walk;
      }
      spent += step;
    }
    out.push(q);
    p = q;
  }
  // Never stop inside someone: step back along the walk until the spot is free.
  while (out.length) {
    const end = out[out.length - 1]!;
    if (free(end)) return out;
    const prev = out.length > 1 ? out[out.length - 2]! : from;
    const len = Math.hypot(end.x - prev.x, end.y - prev.y);
    if (len <= 0.25) out.pop();
    else out[out.length - 1] = { x: end.x + ((prev.x - end.x) * 0.25) / len, y: end.y + ((prev.y - end.y) * 0.25) / len };
  }
  return out;
}

/** The point `dist` metres along a walk (its start or end when out of range). */
export function pointAlong(from: Vec2, path: Vec2[], dist: number): Vec2 {
  let p = from, left = Math.max(0, dist);
  for (const q of path) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (left <= len) return len ? { x: p.x + ((q.x - p.x) * left) / len, y: p.y + ((q.y - p.y) * left) / len } : q;
    left -= len;
    p = q;
  }
  return p;
}

/** Distance from p to the segment a–b. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
