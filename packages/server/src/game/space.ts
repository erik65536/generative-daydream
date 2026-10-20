/**
 * Where the game's actors stand and walk in a place (metres on the painting's navigation grid). The walking rules
 * themselves (bodies, squeezing past allies, budgets) are shared with the client: see shared/world/walking.
 */
import { SPACING, walkAmong as among, type Nav, type NavPathOptions, type Vec2 } from '@gd/shared';
import type { Actor } from './actors';

/** Takes up room: standing, or down on the ground. */
const present = (a: Actor) => a.alive() || a.downed();
const idOf = (x?: Actor | string) => (typeof x === 'string' ? x : x?.id);

/** Someone (other than `ignore`) standing within SPACING of p. */
export function bodyAt(people: Iterable<Actor>, p: Vec2, ignore?: Actor | string): Actor | undefined {
  const skip = idOf(ignore);
  for (const a of people) if (a.id !== skip && present(a) && Math.hypot(a.x - p.x, a.y - p.y) < SPACING - 0.01) return a;
  return undefined;
}

/** Walkable ground nobody else stands on. */
export function isFree(nav: Nav, people: Iterable<Actor>, p: Vec2, ignore?: Actor | string): boolean {
  return nav.walkable(p.x, p.y) && !bodyAt(people, p, ignore);
}

/** The nearest free spot to p (p itself when free), searching up to maxR metres out. */
export function nearestFree(nav: Nav, people: Actor[], p: Vec2, ignore?: Actor | string, maxR = 8): Vec2 | null {
  return nav.nearestWalkable(p, maxR, (cx, cy) => nav.walkableCell(cx, cy) && !bodyAt(people, nav.centre(cx, cy), ignore));
}

/** Walking options for `a` among the others present: strangers block, allies can be squeezed past. */
export function walkAmong(nav: Nav, a: Actor, people: Actor[], ally: (o: Actor) => boolean, cost?: (p: Vec2) => number): NavPathOptions {
  return among(nav, people.filter((o) => o !== a && present(o)).map((o) => ({ x: o.x, y: o.y, ally: ally(o) })), cost);
}
