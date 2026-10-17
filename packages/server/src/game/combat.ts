/** Turn-based combat encounter on the zone grid. */
import {
  MAX_AP, findPath, getSkill, pathLength, hashOf,
  type CombatView, type CombatantView, type Vec2,
} from '@gd/shared';
import { Actor, CharActor, MonsterActor, NpcActor, WALK_SPEED } from './actors';
import { applySurface, checkItemUse, checkSkill, executeSkill, isHostileTo, surfaceAt, tickStatuses, useConsumable, type EffectHost } from './effects';
import { runAiTurn } from './ai';
import type { ItemInstance } from '@gd/shared';

export interface CombatHost extends EffectHost {
  broadcastCombat(c: Combat): void;
  combatEnded(c: Combat, victory: boolean): void;
  /** Trap check along a path; returns index where movement stopped (or -1). */
  checkTrapsAlong(a: Actor, path: Vec2[]): number;
  commandCompanions(userId: string): boolean;
  sendError(userId: string, msg: string): void;
  playersInCombat(c: Combat): string[];
  isMultiplayer(c: Combat): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Combat {
  round = 1;
  order: Actor[] = [];
  idx = 0;
  turnStartedAt = Date.now();
  ended = false;
  busy = false;
  private pendingJoin: Actor[] = [];
  /** Fast mode for tests (no animation delays). */
  static instant = false;
  private turnToken = 0;
  private started = false;

  constructor(public readonly id: string, public readonly zoneId: string, private host: CombatHost) {}

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
    a.ap = Math.min(MAX_AP, a.stats().apStart);
    a.movementLeft = 0;
    a.dirty = true;
    (a as Actor & { _init?: number })._init = a.stats().initiative + this.host.rng.int(0, 6) + initiativeBonus;
    if (this.started) this.pendingJoin.push(a);
    else this.order.push(a);
  }

  start() {
    this.started = true;
    this.order.sort((a, b) => ((b as Actor & { _init?: number })._init ?? 0) - ((a as Actor & { _init?: number })._init ?? 0));
    this.idx = 0;
    this.host.broadcastCombat(this);
    void this.beginTurn();
  }

  view(): CombatView {
    const w = this.host.world;
    return {
      id: this.id,
      round: this.round,
      order: this.order.map<CombatantView>((a) => ({
        id: a.id,
        name: a.name,
        team: a.team() === 'players' ? 'players' : 'enemies',
        ap: a.ap,
        maxAp: MAX_AP,
        initiative: (a as Actor & { _init?: number })._init ?? 0,
        controllerUserId: a instanceof CharActor && !a.aiDriven(this.host.commandCompanions(a.userId)) ? a.userId : undefined,
        movementLeft: Math.round(a.movementLeft * 10) / 10,
      })),
      activeId: this.active?.id ?? '',
      turnStartedAt: this.turnStartedAt,
      turnLimit: this.host.isMultiplayer(this) ? 60 : undefined,
    };
    void w;
  }

  isHumanControlled(a: Actor): boolean {
    return a instanceof CharActor && !a.aiDriven(this.host.commandCompanions(a.userId));
  }

  private async beginTurn() {
    if (this.ended) return;
    const a = this.active;
    if (!a) return this.finish(false);
    if (!a.alive()) return this.advance();
    const token = ++this.turnToken;
    this.turnStartedAt = Date.now();
    a.ap = Math.min(MAX_AP, (this.round === 1 && !(a as Actor & { _acted?: boolean })._acted ? a.stats().apStart : a.ap + a.stats().apPerTurn));
    (a as Actor & { _acted?: boolean })._acted = true;
    a.movementLeft = 0;
    // Regenerate a little energy every turn.
    const s = a.stats();
    a.stamina = Math.min(s.maxStamina, a.stamina + Math.max(3, s.maxStamina * 0.12));
    a.focus = Math.min(s.maxFocus, a.focus + Math.max(3, s.maxFocus * 0.12));
    const surf = surfaceAt(this.host, this.zoneId, a.x, a.y);
    if (surf) applySurface(this.host, a, surf);
    const skip = a.alive() ? tickStatuses(this.host, a) : false;
    this.host.broadcastCombat(this);
    if (this.checkEnd()) return;
    if (!a.alive() || skip) {
      if (skip) this.host.fx(this.zoneId, [{ kind: 'text', targetId: a.id, text: 'Skips turn', color: '#c9a6ff' }]);
      await sleep(Combat.instant ? 0 : 700);
      if (token === this.turnToken) this.advance();
      return;
    }
    if (!this.isHumanControlled(a)) {
      this.busy = true;
      try {
        await runAiTurn(this, a, this.host, Combat.instant);
      } catch (e) {
        console.error('[combat] AI error', e);
      }
      this.busy = false;
      if (token === this.turnToken && !this.ended) this.advance();
    } else if (this.host.isMultiplayer(this)) {
      setTimeout(() => {
        if (token === this.turnToken && !this.ended && this.active === a) this.advance();
      }, 60_000);
    }
  }

  advance() {
    if (this.ended) return;
    if (this.checkEnd()) return;
    this.idx++;
    if (this.idx >= this.order.length) {
      this.idx = 0;
      this.round++;
      this.order.push(...this.pendingJoin);
      this.pendingJoin = [];
      this.order = this.order.filter((a) => a.alive() || (a instanceof CharActor && a.ch.downed));
      this.tickSurfaces();
    }
    void this.beginTurn();
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
    const enemies = alive.filter((a) => players.some((p) => isHostileTo(p, a)) || (a instanceof MonsterActor));
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
    for (const a of this.participants()) {
      a.combatId = null;
      a.ap = 0;
      a.movementLeft = 0;
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

  // ------------------------------------------------------------------ actions

  occupied(x: number, y: number, ignore?: Actor): boolean {
    return this.host.actorsInZone(this.zoneId).some((a) => a !== ignore && (a.alive() || (a instanceof CharActor && a.ch.downed)) && Math.round(a.x) === x && Math.round(a.y) === y);
  }

  pathFor(a: Actor, to: Vec2): Vec2[] | null {
    const map = this.host.zoneMap(this.zoneId);
    const W = map.def.width;
    return findPath(a, to, {
      width: W,
      height: map.def.height,
      passable: (x, y) => !map.solid[y * W + x] && !this.occupied(x, y, a),
      extraCost: (x, y) => (this.host.surfaces(this.zoneId).some((s) => s.x === x && s.y === y && (s.type === 'fire' || s.type === 'poison')) ? 3 : 0),
      maxNodes: 6000,
    });
  }

  /** AP needed to walk a path of given length. */
  moveCost(a: Actor, len: number): number {
    if (len <= a.movementLeft + 1e-6) return 0;
    return Math.ceil((len - a.movementLeft - 1e-6) / a.stats().tilesPerAp);
  }

  async move(a: Actor, to: Vec2): Promise<string | null> {
    if (this.active !== a) return 'Not your turn.';
    let path = this.pathFor(a, to);
    if (!path || !path.length) return 'Cannot reach that spot.';
    // Truncate to what we can afford.
    const tpa = a.stats().tilesPerAp;
    const budget = a.movementLeft + a.ap * tpa;
    let len = 0;
    let cut = path.length;
    let px = a.x, py = a.y;
    for (let i = 0; i < path.length; i++) {
      const step = Math.hypot(path[i]!.x - px, path[i]!.y - py);
      if (len + step > budget + 1e-6) {
        cut = i;
        break;
      }
      len += step;
      px = path[i]!.x;
      py = path[i]!.y;
    }
    path = path.slice(0, cut);
    if (!path.length) return 'Not enough action points to move.';
    const trapIdx = this.host.checkTrapsAlong(a, path);
    if (trapIdx >= 0) path = path.slice(0, trapIdx + 1);
    len = pathLength(a, path);
    const cost = this.moveCost(a, len);
    a.ap -= cost;
    a.movementLeft = a.movementLeft + cost * tpa - len;
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
    if (!Combat.instant) await sleep((len / WALK_SPEED) * 1000 + 80);
    a.motion = null;
    this.checkEnd();
    return null;
  }

  useSkill(a: Actor, skillId: string, target?: Actor, point?: Vec2): string | null {
    if (this.active !== a) return 'Not your turn.';
    const skill = getSkill(skillId);
    if (!skill) return 'Unknown skill.';
    if (!a.skillIds().includes(skillId)) return 'You do not know that.';
    const taunt = a.statuses.find((s) => s.id === 'taunted');
    if (taunt && target && taunt.sourceId && target.id !== taunt.sourceId && skill.effects.some((e) => e.kind === 'damage')) {
      const t = this.participants().find((x) => x.id === taunt.sourceId);
      if (t?.alive()) return `Taunted — you must attack ${t.name}.`;
    }
    const use = { user: a, skill, target, point };
    const err = checkSkill(this.host, use, { inCombat: true });
    if (err) return err;
    executeSkill(this.host, use, true);
    this.host.broadcastCombat(this);
    this.checkEnd();
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
