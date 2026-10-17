/**
 * Turn-based combat encounter on the zone grid. The core is synchronous: every action applies immediately
 * and returns how long its animation takes; pacing goes through `host.after`, so the live game paces with
 * timers while the balance simulator runs the very same code instantly.
 */
import {
  ALLY_PASS_COST, findPath, hasLineOfSight, hashOf, pathLength, rx, skillAp, skillRange,
  type CombatView, type CombatantView, type ItemInstance, type Ruleset, type Vec2,
} from '@gd/shared';
import { Actor, CharActor, MonsterActor, NpcActor, WALK_SPEED } from './actors';
import { applySurface, checkItemUse, checkSkill, executeSkill, isHostileTo, surfaceAt, tickStatuses, useConsumable, type EffectHost } from './effects';
import { aiStep, type AiMemory } from './ai';

export interface CombatHost extends EffectHost {
  broadcastCombat(c: Combat): void;
  combatEnded(c: Combat, victory: boolean): void;
  /** Trap check along a path; returns index where movement stopped (or -1). */
  checkTrapsAlong(a: Actor, path: Vec2[]): number;
  commandCompanions(userId: string): boolean;
  sendError(userId: string, msg: string): void;
  playersInCombat(c: Combat): string[];
  isMultiplayer(c: Combat): boolean;
  /** Run `fn` after `ms` of game time (timers live, immediate in simulation). */
  after(ms: number, fn: () => void): void;
}

// ------------------------------------------------------------------------------------ turn models

/** How a turn model hands out and spends action resources. Only the AP model exists today. */
interface TurnModel {
  /** Resources when joining combat. */
  enter(a: Actor): void;
  /** Resources at the start of each of the actor's turns. */
  beginTurn(a: Actor, first: boolean): void;
  /** Tiles the actor can still move this turn. */
  moveBudget(a: Actor): number;
  /** Tiles the actor can move and still afford an action costing `ap`. */
  moveBudgetReserving(a: Actor, ap: number): number;
  /** Pay for moving `len` tiles (already checked against the budget). */
  payMove(a: Actor, len: number): void;
  canAfford(a: Actor, ap: number): boolean;
  view(a: Actor): { ap: number; maxAp: number; movementLeft: number };
}

function apModel(r: Ruleset): TurnModel {
  const tpa = (a: Actor) => a.stats().move;
  return {
    enter(a) {
      a.ap = Math.min(a.stats().apMax, a.stats().apStart);
      a.movementLeft = 0;
    },
    beginTurn(a, first) {
      const s = a.stats();
      a.ap = first ? Math.min(s.apMax, s.apStart) : Math.min(s.apMax, a.ap + s.apPerTurn);
      a.movementLeft = 0;
    },
    moveBudget(a) {
      return a.movementLeft + a.ap * tpa(a);
    },
    moveBudgetReserving(a, ap) {
      return a.ap < ap ? -1 : a.movementLeft + (a.ap - ap) * tpa(a);
    },
    payMove(a, len) {
      const per = tpa(a);
      if (len <= a.movementLeft + 1e-6) {
        a.movementLeft -= len;
        return;
      }
      const cost = Math.ceil((len - a.movementLeft - 1e-6) / per);
      a.ap -= cost;
      a.movementLeft = a.movementLeft + cost * per - len;
    },
    canAfford(a, ap) {
      return a.ap >= ap;
    },
    view(a) {
      return { ap: a.ap, maxAp: a.stats().apMax, movementLeft: Math.round(a.movementLeft * 10) / 10 };
    },
  };
  void r;
}

export function turnModelFor(r: Ruleset): TurnModel {
  switch (r.turn.model) {
    case 'ap':
    default:
      return apModel(r);
  }
}

// ------------------------------------------------------------------------------------ combat

export class Combat {
  round = 1;
  order: Actor[] = [];
  idx = 0;
  turnStartedAt = Date.now();
  ended = false;
  /** An AI or animation is in progress; humans must wait. */
  busy = false;
  private pendingJoin: Actor[] = [];
  private turnToken = 0;
  private started = false;
  private acted = new Set<string>();
  private initiative = new Map<string, number>();
  readonly model: TurnModel;
  readonly ai = new Map<string, AiMemory>();
  /** Fast mode for tests (no animation delays). */
  static instant = false;

  constructor(public readonly id: string, public readonly zoneId: string, readonly host: CombatHost) {
    this.model = turnModelFor(host.r);
  }

  get active(): Actor | undefined {
    return this.order[this.idx];
  }

  participants(): Actor[] {
    return [...this.order, ...this.pendingJoin];
  }

  add(a: Actor, initiativeBonus = 0) {
    if (this.participants().includes(a)) return;
    a.combatId = this.id;
    a.motion = null;
    a.x = Math.round(a.x);
    a.y = Math.round(a.y);
    this.model.enter(a);
    a.dirty = true;
    this.initiative.set(a.id, a.stats().initiative + this.host.rng.int(0, 6) + initiativeBonus);
    if (this.started) this.pendingJoin.push(a);
    else this.order.push(a);
  }

  start() {
    this.started = true;
    this.order.sort((a, b) => (this.initiative.get(b.id) ?? 0) - (this.initiative.get(a.id) ?? 0));
    this.idx = 0;
    this.host.broadcastCombat(this);
    this.beginTurn();
  }

  view(): CombatView {
    return {
      id: this.id,
      round: this.round,
      order: this.order.map<CombatantView>((a) => ({
        id: a.id,
        name: a.name,
        team: a.team() === 'players' ? 'players' : 'enemies',
        ...this.model.view(a),
        initiative: this.initiative.get(a.id) ?? 0,
        controllerUserId: a instanceof CharActor && !a.aiDriven(this.host.commandCompanions(a.userId)) ? a.userId : undefined,
      })),
      activeId: this.active?.id ?? '',
      turnStartedAt: this.turnStartedAt,
      turnLimit: this.host.isMultiplayer(this) ? 60 : undefined,
    };
  }

  isHumanControlled(a: Actor): boolean {
    return a instanceof CharActor && !a.aiDriven(this.host.commandCompanions(a.userId));
  }

  private delay(ms: number) {
    return Combat.instant ? 0 : ms;
  }

  private beginTurn() {
    if (this.ended) return;
    const a = this.active;
    if (!a) return this.finish(false);
    if (!a.alive()) return this.advance();
    const token = ++this.turnToken;
    this.turnStartedAt = Date.now();
    this.model.beginTurn(a, !this.acted.has(a.id));
    this.acted.add(a.id);
    // Pools refill a little every turn.
    const s = a.stats();
    for (const [poolId, p] of Object.entries(s.pools)) a.pools[poolId] = Math.min(p.max, (a.pools[poolId] ?? p.max) + p.max * p.regen);
    const surf = surfaceAt(this.host, this.zoneId, a.x, a.y);
    if (surf) applySurface(this.host, a, surf);
    if (a.alive()) tickStatuses(this.host, a);
    this.host.broadcastCombat(this);
    if (this.checkEnd()) return;
    if (!a.alive()) {
      this.host.after(this.delay(500), () => token === this.turnToken && this.advance());
      return;
    }
    if (!this.isHumanControlled(a)) {
      this.busy = true;
      this.host.after(this.delay(450), () => this.driveAi(a, token, 0));
    } else if (this.host.isMultiplayer(this)) {
      this.host.after(60_000, () => token === this.turnToken && !this.ended && this.active === a && this.advance());
    }
  }

  private driveAi(a: Actor, token: number, step: number) {
    if (token !== this.turnToken || this.ended || this.active !== a) return;
    let ms = -1;
    try {
      ms = step < 10 && a.alive() ? aiStep(this, a) : -1;
    } catch (e) {
      console.error('[combat] AI error', e);
    }
    if (ms < 0 || this.ended) {
      this.busy = false;
      if (token === this.turnToken && !this.ended) this.advance();
      return;
    }
    this.host.after(this.delay(ms), () => this.driveAi(a, token, step + 1));
  }

  advance() {
    if (this.ended) return;
    if (this.checkEnd()) return;
    this.busy = false;
    this.idx++;
    if (this.idx >= this.order.length) {
      this.idx = 0;
      this.round++;
      this.order.push(...this.pendingJoin);
      this.pendingJoin = [];
      this.order = this.order.filter((a) => a.alive() || a.downed());
      this.tickSurfaces();
    }
    this.beginTurn();
  }

  private tickSurfaces() {
    const list = this.host.surfaces(this.zoneId);
    for (let i = list.length - 1; i >= 0; i--) {
      list[i]!.turns--;
      if (list[i]!.turns <= 0) list.splice(i, 1);
    }
    this.host.surfacesChanged(this.zoneId);
  }

  checkEnd(): boolean {
    if (this.ended) return true;
    const alive = this.participants().filter((a) => a.alive());
    const players = alive.filter((a) => a.team() === 'players');
    const enemies = alive.filter((a) => players.some((p) => isHostileTo(p, a)) || a instanceof MonsterActor);
    if (!enemies.length) {
      this.finish(true);
      return true;
    }
    if (!players.length) {
      this.finish(false);
      return true;
    }
    return false;
  }

  private finish(victory: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.busy = false;
    for (const a of this.participants()) {
      a.combatId = null;
      a.ap = 0;
      a.movementLeft = 0;
      a.controlImmune = 0;
      a.dirty = true;
    }
    this.host.combatEnded(this, victory);
  }

  remove(a: Actor) {
    a.combatId = null;
    const i = this.order.indexOf(a);
    if (i >= 0) {
      const wasActive = i === this.idx;
      this.order.splice(i, 1);
      if (i < this.idx) this.idx--;
      if (wasActive) {
        this.idx--;
        this.advance();
      }
    }
    this.pendingJoin = this.pendingJoin.filter((x) => x !== a);
    this.checkEnd();
  }

  // ------------------------------------------------------------------ space

  /** The actor standing on a tile (alive, or downed but not dead), if any. */
  occupant(x: number, y: number, ignore?: Actor): Actor | undefined {
    return this.host.actorsInZone(this.zoneId).find((a) => a !== ignore && (a.alive() || a.downed()) && Math.round(a.x) === x && Math.round(a.y) === y);
  }

  occupied(x: number, y: number, ignore?: Actor): boolean {
    return !!this.occupant(x, y, ignore);
  }

  /** An ally of `a` stands here: passable at a movement penalty, but not a place to stop. */
  allyAt(a: Actor, x: number, y: number): boolean {
    const o = this.occupant(x, y, a);
    return !!o && o.team() === a.team();
  }

  private hazardous(x: number, y: number): boolean {
    return this.host.surfaces(this.zoneId).some((s) => s.x === x && s.y === y && !!rx(this.host.r).surface.get(s.type)?.dot);
  }

  pathFor(a: Actor, to: Vec2): Vec2[] | null {
    const map = this.host.zoneMap(this.zoneId);
    const W = map.def.width;
    if (this.occupied(Math.round(to.x), Math.round(to.y), a)) return null;
    return findPath(a, to, {
      width: W,
      height: map.def.height,
      passable: (x, y) => !map.solid[y * W + x] && (!this.occupied(x, y, a) || this.allyAt(a, x, y)),
      extraCost: (x, y) => (this.allyAt(a, x, y) ? ALLY_PASS_COST : 0) + (this.hazardous(x, y) ? 3 : 0),
      maxNodes: 6000,
    });
  }

  /** Movement a path uses: its length plus the penalty for each ally squeezed past and surface move costs. */
  pathCost(a: Actor, path: Vec2[]): number {
    const ix = rx(this.host.r);
    let extra = 0;
    for (const p of path) {
      if (this.allyAt(a, p.x, p.y)) extra += ALLY_PASS_COST;
      const s = surfaceAt(this.host, this.zoneId, p.x, p.y);
      if (s) extra += ix.surface.get(s.type)?.moveCost ?? 0;
    }
    return pathLength(a, path) + extra;
  }

  // ------------------------------------------------------------------ actions

  /** Move the active actor; returns an error, or the animation duration in ms. */
  move(a: Actor, to: Vec2): { error?: string; ms: number } {
    if (this.active !== a) return { error: 'Not your turn.', ms: 0 };
    if (a.stats().rooted) return { error: 'You are rooted in place.', ms: 0 };
    let path = this.pathFor(a, to);
    if (!path || !path.length) return { error: 'Cannot reach that spot.', ms: 0 };
    const budget = this.model.moveBudget(a);
    let len = 0;
    let cut = path.length;
    let px = a.x, py = a.y;
    for (let i = 0; i < path.length; i++) {
      const step = Math.hypot(path[i]!.x - px, path[i]!.y - py) + (this.allyAt(a, path[i]!.x, path[i]!.y) ? ALLY_PASS_COST : 0);
      if (len + step > budget + 1e-6) {
        cut = i;
        break;
      }
      len += step;
      px = path[i]!.x;
      py = path[i]!.y;
    }
    path = path.slice(0, cut);
    // Never stop on an ally's tile.
    while (path.length && this.occupied(path[path.length - 1]!.x, path[path.length - 1]!.y, a)) path.pop();
    if (!path.length) return { error: `Not enough ${this.host.r.terminology.actionPoints} to move.`, ms: 0 };
    const trapIdx = this.host.checkTrapsAlong(a, path);
    if (trapIdx >= 0) {
      path = path.slice(0, trapIdx + 1);
      while (path.length > 1 && this.occupied(path[path.length - 1]!.x, path[path.length - 1]!.y, a)) path.pop();
    }
    len = this.pathCost(a, path);
    this.model.payMove(a, Math.min(len, this.model.moveBudget(a)));
    const from = { x: a.x, y: a.y };
    const last = path[path.length - 1]!;
    a.motion = { path, from, speed: WALK_SPEED, t0: this.host.now() };
    a.facing = Math.atan2(last.y - from.y, last.x - from.x);
    a.x = last.x;
    a.y = last.y;
    a.dirty = true;
    this.host.actorMoved(a);
    const surf = surfaceAt(this.host, this.zoneId, a.x, a.y);
    if (surf) applySurface(this.host, a, surf);
    this.host.broadcastCombat(this);
    const ms = (pathLength(from, path) / WALK_SPEED) * 1000 + 80;
    this.host.after(this.delay(ms), () => {
      if (a.motion?.t0 !== undefined && a.motion.path === path) a.motion = null;
    });
    this.checkEnd();
    return { ms };
  }

  useSkill(a: Actor, skillId: string, target?: Actor, point?: Vec2): string | null {
    if (this.active !== a) return 'Not your turn.';
    const skill = rx(this.host.r).skill.get(skillId);
    if (!skill) return 'Unknown skill.';
    if (!a.skillIds().includes(skillId)) return 'You do not know that.';
    const use = { user: a, skill, target, point };
    const err = checkSkill(this.host, use, { inCombat: true });
    if (err) return err;
    if (!this.model.canAfford(a, skillAp(skill, a.stats()))) return `Not enough ${this.host.r.terminology.actionPoints}.`;
    executeSkill(this.host, use, true);
    this.host.broadcastCombat(this);
    this.checkEnd();
    return null;
  }

  /** Attack-move: walk to the cheapest reachable spot in range (with line of sight) that leaves enough to act, then act. */
  approachAndUse(a: Actor, skillId: string, target: Actor): string | null {
    if (this.active !== a) return 'Not your turn.';
    const skill = rx(this.host.r).skill.get(skillId);
    if (!skill || !a.skillIds().includes(skillId)) return 'Unknown skill.';
    const stats = a.stats();
    if (stats.rooted) return 'Out of range.';
    const cost = skillAp(skill, stats);
    const budget = this.model.moveBudgetReserving(a, cost);
    if (budget < 0) return `Not enough ${this.host.r.terminology.actionPoints}.`;
    const range = skillRange(skill, stats);
    const map = this.host.zoneMap(this.zoneId);
    const W = map.def.width, H = map.def.height;
    const sees = (p: Vec2) => range <= 2 || hasLineOfSight(p, target, (x, y) => map.opaque[y * W + x] === 1);
    const R = Math.ceil(range);
    const spots: Vec2[] = [];
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const p = { x: Math.round(target.x) + dx, y: Math.round(target.y) + dy };
        if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H || map.solid[p.y * W + p.x]) continue;
        if (Math.hypot(p.x - target.x, p.y - target.y) > range - 0.05 || this.occupied(p.x, p.y, a)) continue;
        if (Math.hypot(p.x - a.x, p.y - a.y) > budget + 0.5) continue;
        if (sees(p)) spots.push(p);
      }
    spots.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
    let best: { p: Vec2; cost: number } | null = null;
    for (const p of spots.slice(0, 16)) {
      const path = this.pathFor(a, p);
      if (!path?.length) continue;
      const c = this.pathCost(a, path);
      if (c <= budget + 1e-6 && (!best || c < best.cost)) best = { p, cost: c };
    }
    if (!best) return budget <= 0 ? 'Out of range.' : 'Cannot get in range this turn.';
    const moved = this.move(a, best.p);
    if (moved.error) return moved.error;
    this.host.after(moved.ms + 80, () => {
      if (this.active === a && target.alive() && a.alive()) this.useSkill(a, skillId, target);
    });
    return null;
  }

  useItem(a: Actor, item: ItemInstance, target?: Actor, point?: Vec2, consume?: () => void): string | null {
    if (this.active !== a) return 'Not your turn.';
    const err = checkItemUse(this.host, a, item, true, target, point);
    if (err) return err;
    useConsumable(this.host, a, item, true, target, point);
    consume?.();
    this.host.broadcastCombat(this);
    this.checkEnd();
    return null;
  }

  endTurn(a: Actor): string | null {
    if (this.active !== a) return 'Not your turn.';
    if (this.busy) return 'Wait for the current action.';
    this.advance();
    return null;
  }

  /** Deterministic per-combat hash for AI tie-breaks. */
  hash(...p: (string | number)[]) {
    return hashOf(this.id, this.round, ...p);
  }
}

export { NpcActor };
