/**
 * Executes skills, potions, traps, statuses and surfaces against actors from ruleset data.
 * Synchronous and deterministic given the host's RNG; shared by real-time play, combat and the balance simulator.
 */
import {
  SPACING, applyDamage, expectedDamage, flatDamage, healAmount, isBasic, potency, refDpa, resolveStatusId, rollDamage, rx, skillAp, skillRange, statusDot, tilesInRadius,
  type ActiveStatus, type DamageEffect, type Effect, type FxEvent, type ItemBaseDef, type ItemInstance, type Rng, type Ruleset, type SkillDef, type StatBlock, type Surface,
} from '@gd/shared';
import type { Actor } from './actors';
import { CharActor, MonsterActor, NpcActor } from './actors';
import type { ZoneMap } from './worldctx';


export interface EffectHost {
  r: Ruleset;
  rng: Rng;
  now(): number;
  actorsInZone(zoneId: string): Actor[];
  zoneMap(zoneId: string): ZoneMap;
  /** Walkable ground nobody (else) stands on, in metres. */
  isFree(zoneId: string, x: number, y: number, ignoreId?: string): boolean;
  fx(zoneId: string, events: FxEvent[]): void;
  surfaces(zoneId: string): Surface[];
  surfacesChanged(zoneId: string): void;
  onDamaged(target: Actor, source: Actor | null, amount: number): void;
  onDowned(target: Actor, source: Actor | null): void;
  log(zoneId: string, text: string, color?: string): void;
  actorMoved(a: Actor): void;
  /** Telemetry hook for the balance simulator. */
  onSkillUsed?(a: Actor, skill: SkillDef): void;
}

export function relation(a: Actor, b: Actor): 'ally' | 'enemy' | 'neutral' {
  if (a === b) return 'ally';
  const ta = a.team(), tb = b.team();
  if (a instanceof CharActor && b instanceof CharActor) return 'ally';
  if (a instanceof CharActor && b instanceof NpcActor) return b.rt.hostileTo.includes(a.userId) ? 'enemy' : 'neutral';
  if (a instanceof NpcActor && b instanceof CharActor) return a.rt.hostileTo.includes(b.userId) ? 'enemy' : 'neutral';
  if (ta === 'enemies' && tb === 'enemies') return 'ally';
  if ((ta === 'players' && tb === 'enemies') || (ta === 'enemies' && tb === 'players')) {
    if (a instanceof NpcActor || b instanceof NpcActor) {
      const npc = (a instanceof NpcActor ? a : b) as NpcActor;
      const other = npc === a ? b : a;
      if (other instanceof MonsterActor) return 'neutral';
    }
    return 'enemy';
  }
  return 'neutral';
}

export function isHostileTo(a: Actor, b: Actor) {
  return relation(a, b) === 'enemy';
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export interface SkillUse {
  user: Actor;
  skill: SkillDef;
  target?: Actor;
  point?: { x: number; y: number };
}

const isMovement = (s: SkillDef) => s.effects.some((e) => e.kind === 'teleport' || e.kind === 'dash');
const isRevive = (s: { effects: Effect[] }) => s.effects.some((e) => e.kind === 'revive');
const usesWeapon = (s: SkillDef) => isBasic(s) || s.tags.includes('weapon');
export const isHarmful = (r: Ruleset, effects: Effect[]) => effects.some((e) => e.kind === 'damage' || e.kind === 'push' || (e.kind === 'status' && !e.self && (e.statusId === '$family' || rx(r).status.get(e.statusId)?.harmful)));

/** Returns an error message, or null if the skill may be used now. */
export function checkSkill(host: EffectHost, use: SkillUse, opts: { inCombat: boolean }): string | null {
  const { user, skill, target, point } = use;
  const r = host.r;
  if (!user.alive()) return 'You cannot act right now.';
  if (skill.utility) return opts.inCombat ? 'Not during combat.' : null;
  const stats = user.stats();
  const ap = skillAp(skill, stats);
  if (opts.inCombat && user.ap < ap) return `Not enough ${r.terminology.actionPoints}.`;
  if (!opts.inCombat && !skill.outOfCombat && !isBasic(skill) && !(target && isHostileTo(user, target)) && !(skill.targeting === 'ground' && point && isHarmful(r, skill.effects))) return 'That can only be used in combat.';
  if (stats.silenced && !usesWeapon(skill)) return 'You are silenced: only weapon attacks.';
  if (stats.disarmed && usesWeapon(skill)) return 'You are disarmed: no weapon attacks.';
  if (stats.rooted && isMovement(skill)) return 'You are rooted in place.';
  const cd = user.cooldowns[skill.id] ?? 0;
  if (cd > 0) return `Ready in ${cd} turn${cd > 1 ? 's' : ''}.`;
  if (skill.cost && user instanceof CharActor && (user.pools[skill.cost.poolId] ?? 0) < skill.cost.amount) return `Not enough ${rx(r).pool.get(skill.cost.poolId)?.name ?? 'energy'}.`;
  const range = skillRange(skill, stats);
  const map = host.zoneMap(user.zoneId);
  const los = (p: { x: number; y: number }) => map.nav.sees(user, p);
  switch (skill.targeting) {
    case 'self':
      return null;
    case 'enemy':
      if (!target || !target.alive()) return 'Choose a target.';
      if (relation(user, target) === 'ally') return 'That is an ally.';
      if (dist(user, target) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(target)) return 'No line of sight.';
      if (skill.effects.some((e) => e.kind === 'dash') && !findLandingNear(host, user, target)) return 'No room to land there.';
      return null;
    case 'ally':
      if (!target) return 'Choose an ally.';
      if (relation(user, target) !== 'ally') return 'Choose an ally.';
      if (!target.alive() && !(target.downed() && canReviveWith(r, skill.effects))) return 'They are down.';
      if (isRevive(skill) && target.alive() && !skill.effects.some((e) => e.kind === 'heal')) return 'They are not down.';
      if (dist(user, target) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(target)) return 'No line of sight.';
      return null;
    case 'ground': {
      const p = point ?? target;
      if (!p) return 'Choose a location.';
      if (dist(user, p) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(p)) return 'No line of sight.';
      if (skill.effects.some((e) => e.kind === 'teleport') && !host.isFree(user.zoneId, p.x, p.y, user.id)) return 'Cannot land there.';
      return null;
    }
  }
}

/** Whether these effects can bring a downed ally back under the ruleset's revive mode. */
export function canReviveWith(r: Ruleset, effects: Effect[]): boolean {
  if (r.revive === 'after_combat') return false;
  if (effects.some((e) => e.kind === 'revive')) return true;
  return r.revive === 'heal' && effects.some((e) => e.kind === 'heal');
}

/** A free spot right next to the target (the nearest to the user), for a dash. */
function findLandingNear(host: EffectHost, user: Actor, target: Actor): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = target.x + Math.cos(a) * (SPACING + 0.05), y = target.y + Math.sin(a) * (SPACING + 0.05);
    if (!host.isFree(user.zoneId, x, y, user.id)) continue;
    const d = Math.hypot(x - user.x, y - user.y);
    if (d < bd) {
      bd = d;
      best = { x, y };
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------ primitives

export function addStatus(host: EffectHost, target: Actor, statusId: string, turns: number, power: number, sourceId?: string): boolean {
  const def = rx(host.r).status.get(statusId);
  if (!def || !target.alive()) return false;
  if (def.control && (target.controlImmune > 0 || !host.r.control.enabled)) return false;
  const existing = target.statuses.find((s) => s.id === statusId);
  if (existing) {
    existing.turns = Math.max(existing.turns, turns);
    existing.power = Math.max(existing.power, power);
    target.statuses = [...target.statuses];
  } else target.statuses = [...target.statuses, { id: statusId, turns, power, sourceId }];
  target.dirty = true;
  return true;
}

/** Deal damage; returns damage dealt to health. */
export function dealDamage(host: EffectHost, source: Actor | null, target: Actor, amount: number, kind: { typeId: string; subtypeId?: string }, opts: { crit?: boolean; noThorns?: boolean } = {}): number {
  if (!target.alive()) return 0;
  const before = target.barrier;
  const t = { hp: target.hp, barrier: target.barrier };
  const applied = applyDamage(t, amount);
  target.hp = t.hp;
  target.barrier = t.barrier;
  if (before > 0 && target.barrier <= 0) target.barrierTurns = 0;
  host.fx(target.zoneId, [{ kind: 'damage', sourceId: source?.id, targetId: target.id, damage: { targetId: target.id, amount: applied.toHp + applied.toBarrier, type: kind.subtypeId ?? kind.typeId, crit: opts.crit } }]);
  target.dirty = true;
  if (source && !opts.noThorns) {
    const thorns = target.stats().thorns;
    if (thorns > 0 && dist(source, target) < 2.2) dealDamage(host, null, source, Math.max(1, Math.round(thorns)), { typeId: host.r.damageTypes[0]!.id }, { noThorns: true });
  }
  host.onDamaged(target, source, applied.toHp + applied.toBarrier);
  if (target.hp <= 0) {
    target.hp = 0;
    host.onDowned(target, source);
  }
  return applied.toHp;
}

export function healActor(host: EffectHost, target: Actor, amount: number, allowRevive = false) {
  if (!target.alive()) {
    if (allowRevive && target instanceof CharActor && target.ch.downed) {
      target.ch.downed = false;
      target.ch.hp = 0;
      host.fx(target.zoneId, [{ kind: 'text', targetId: target.id, text: 'Revived', color: '#ffe680' }]);
    } else return;
  }
  const max = target.stats().maxHp;
  const before = target.hp;
  target.hp = Math.max(1, Math.min(max, target.hp + amount));
  const healed = Math.round(target.hp - before);
  if (healed > 0) host.fx(target.zoneId, [{ kind: 'damage', targetId: target.id, damage: { targetId: target.id, amount: healed, type: 'heal' } }]);
  target.dirty = true;
}

function teleport(host: EffectHost, a: Actor, x: number, y: number) {
  a.motion = null;
  a.x = x;
  a.y = y;
  a.dirty = true;
  host.actorMoved(a);
}

function push(host: EffectHost, from: { x: number; y: number }, t: Actor, distance: number) {
  const dx = t.x - from.x, dy = t.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  let x = t.x, y = t.y;
  for (let i = 1; i <= distance * 4; i++) {
    const nx = t.x + (dx / len) * i * 0.25, ny = t.y + (dy / len) * i * 0.25;
    if (!host.isFree(t.zoneId, nx, ny, t.id)) break;
    x = nx;
    y = ny;
  }
  if (x !== t.x || y !== t.y) teleport(host, t, x, y);
}

// ------------------------------------------------------------------------------------ the effect engine

interface EffectRun {
  user: Actor;
  /** Stats used for magnitudes (a potion substitutes item-level power). */
  stats: StatBlock;
  skill: SkillDef;
  rank: number;
  effects: Effect[];
  targets: Actor[];
  center: { x: number; y: number };
  primary?: Actor;
  zone: string;
}

function runEffects(host: EffectHost, run: EffectRun) {
  const { user, stats, skill, rank, effects, targets, center, zone } = run;
  const r = host.r;
  const rand = () => host.rng.next();
  const pot = potency(skill, rank);
  let dealtTotal = 0;
  for (const t of targets) {
    for (const e of effects) {
      switch (e.kind) {
        case 'damage': {
          if (!t.alive()) break;
          const roll = rollDamage(r, stats, t.stats(), skill, rank, e, rand);
          if (roll.dodged) {
            host.fx(zone, [{ kind: 'text', sourceId: user.id, targetId: t.id, text: 'Dodged', color: '#cccccc' }]);
            host.onDamaged(t, user, 0);
            break;
          }
          dealtTotal += dealDamage(host, user, t, roll.amount, roll, { crit: roll.crit });
          if ((e.weapon || isBasic(skill)) && t.alive()) for (const oh of stats.onHit) dealDamage(host, user, t, flatDamage(t.stats(), oh.amount, oh.typeId, oh.subtypeId), oh, { noThorns: true });
          if (stats.lifesteal > 0) healActor(host, user, Math.round(roll.amount * stats.lifesteal));
          break;
        }
        case 'heal':
          healActor(host, t, healAmount(stats, e.coef, pot), canReviveWith(r, effects));
          break;
        case 'barrier': {
          if (!t.alive()) break;
          const amt = healAmount(stats, e.coef, pot);
          t.barrier = Math.max(t.barrier, amt);
          t.barrierTurns = Math.max(t.barrierTurns, e.turns);
          host.fx(zone, [{ kind: 'damage', targetId: t.id, damage: { targetId: t.id, amount: amt, type: 'barrier' } }]);
          t.dirty = true;
          break;
        }
        case 'status': {
          const who = e.self ? user : t;
          if (e.self && t !== targets[0]) break;
          const id = resolveStatusId(r, e.statusId, stats);
          if (!id || !who.alive()) break;
          if (host.rng.chance(e.chance)) {
            const landed = addStatus(host, who, id, e.turns, stats.dpa * pot, user.id);
            const def = rx(r).status.get(id)!;
            if (landed) host.fx(zone, [{ kind: 'text', targetId: who.id, text: def.name, color: def.color }]);
          }
          break;
        }
        case 'restore':
          if (t instanceof CharActor) {
            const max = t.stats().pools[e.poolId]?.max ?? 0;
            t.pools[e.poolId] = Math.min(max, (t.pools[e.poolId] ?? 0) + e.amount);
            t.dirty = true;
          }
          break;
        case 'cleanse':
          t.statuses = t.statuses.filter((s) => !rx(r).status.get(s.id)?.harmful);
          host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Cleansed', color: '#a0ffd0' }]);
          break;
        case 'revive':
          if (t instanceof CharActor && t.ch.downed && r.revive !== 'after_combat') {
            t.ch.downed = false;
            t.ch.hp = Math.max(1, Math.round(t.stats().maxHp * e.fraction));
            host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Revived', color: '#ffe680' }]);
            t.dirty = true;
          }
          break;
        case 'push':
          if (t.alive() && t !== user) push(host, center === t ? user : center, t, e.distance);
          break;
        default:
          break;
      }
    }
  }
  for (const e of effects) {
    if (e.kind === 'lifesteal' && dealtTotal > 0) healActor(host, user, Math.round(dealtTotal * e.fraction));
    if (e.kind === 'chain' && run.primary) chain(host, run, e);
    if (e.kind === 'surface' && r.systems.surfaces) createSurface(host, zone, center, e.surfaceId, e.radius, e.turns, stats.dpa * pot);
  }
}

function chain(host: EffectHost, run: EffectRun, e: Extract<Effect, { kind: 'chain' }>) {
  const { user, stats, skill, rank } = run;
  const dmg = run.effects.find((x) => x.kind === 'damage') as DamageEffect | undefined;
  if (!dmg) return;
  const hit = new Set([run.primary!.id]);
  let cur: Actor = run.primary!;
  let mult = 1;
  const actors = host.actorsInZone(user.zoneId);
  for (let j = 0; j < e.jumps; j++) {
    const next = actors.filter((a) => !hit.has(a.id) && a.alive() && isHostileTo(user, a) && dist(a, cur) < 5).sort((a, b) => dist(a, cur) - dist(b, cur))[0];
    if (!next) break;
    mult *= e.falloff;
    hit.add(next.id);
    host.fx(user.zoneId, [{ kind: 'projectile', sourceId: cur.id, targetId: next.id, x: cur.x, y: cur.y, tx: next.x, ty: next.y, fx: 'beam', skillId: skill.id }]);
    const roll = rollDamage(host.r, stats, next.stats(), skill, rank, dmg, () => host.rng.next(), mult);
    if (!roll.dodged) dealDamage(host, user, next, roll.amount, roll, { crit: roll.crit });
    cur = next;
  }
}

/** Resolve the actors an area or single-target use affects. */
function resolveTargets(host: EffectHost, user: Actor, effects: Effect[], targeting: SkillDef['targeting'], radius: number | undefined, center: { x: number; y: number }, target?: Actor): Actor[] {
  const harmful = isHarmful(host.r, effects);
  const revive = canReviveWith(host.r, effects);
  const actors = host.actorsInZone(user.zoneId).filter((a) => a.alive() || (revive && a.downed()));
  if (radius) return actors.filter((a) => dist(a, center) <= radius + 0.01 && (harmful ? isHostileTo(user, a) : relation(user, a) === 'ally'));
  if (target) return [target];
  if (targeting === 'self') return [user];
  return [];
}

export function skillElement(r: Ruleset, skill: SkillDef, stats: StatBlock): string | undefined {
  const d = skill.effects.find((e) => e.kind === 'damage') as DamageEffect | undefined;
  if (!d) return skill.tags.includes('heal') ? 'heal' : undefined;
  const sub = d.subtypeId === '$family' ? stats.familySubtypeId : d.subtypeId;
  return d.weapon ? stats.weapon.subtypeId ?? stats.weapon.typeId : sub ?? d.typeId ?? stats.weapon.typeId;
}

/** Execute a validated skill. Spends costs and sets cooldowns. */
export function executeSkill(host: EffectHost, use: SkillUse, inCombat: boolean): void {
  const { user, skill } = use;
  const stats = user.stats();
  const rank = user.skillRank(skill.id);
  if (inCombat) user.ap -= skillAp(skill, stats);
  if (skill.cooldown > 0) user.cooldowns[skill.id] = skill.cooldown + 1;
  if (skill.cost && user instanceof CharActor) user.pools[skill.cost.poolId] = Math.max(0, (user.pools[skill.cost.poolId] ?? 0) - skill.cost.amount);
  host.onSkillUsed?.(user, skill);
  if (use.target) user.facing = Math.atan2(use.target.y - user.y, use.target.x - user.x);
  else if (use.point) user.facing = Math.atan2(use.point.y - user.y, use.point.x - user.x);
  const center = skill.targeting === 'self' ? { x: user.x, y: user.y } : use.point ?? (use.target ? { x: use.target.x, y: use.target.y } : { x: user.x, y: user.y });
  const ranged = skillRange(skill, stats) > 2;
  host.fx(user.zoneId, [{ kind: ranged && skill.targeting !== 'self' ? 'projectile' : 'skill', sourceId: user.id, targetId: use.target?.id, x: user.x, y: user.y, tx: center.x, ty: center.y, skillId: skill.id, fx: skill.fx, radius: skill.radius, element: skillElement(host.r, skill, stats) }]);
  // Movement effects first.
  for (const e of skill.effects) {
    if (e.kind === 'teleport' && use.point) teleport(host, user, use.point.x, use.point.y);
    if (e.kind === 'dash' && use.target) {
      const land = findLandingNear(host, user, use.target);
      if (land) teleport(host, user, land.x, land.y);
    }
  }
  const targets = resolveTargets(host, user, skill.effects, skill.targeting, skill.radius, center, use.target);
  runEffects(host, { user, stats, skill, rank, effects: skill.effects, targets, center, primary: use.target, zone: user.zoneId });
  user.dirty = true;
}

// ------------------------------------------------------------------------------------ surfaces

export function createSurface(host: EffectHost, zoneId: string, center: { x: number; y: number }, surfaceId: string, radius: number, turns: number, power: number) {
  const r = host.r;
  const def = rx(r).surface.get(surfaceId);
  if (!def || !r.systems.surfaces) return;
  const map = host.zoneMap(zoneId);
  const list = host.surfaces(zoneId);
  // Surfaces lie in square-metre patches on the ground.
  for (const t of tilesInRadius(center.x, center.y, radius, Math.ceil(map.nav.width), Math.ceil(map.nav.height))) {
    if (!map.nav.walkable(t.x, t.y)) continue;
    const i = list.findIndex((s) => s.x === t.x && s.y === t.y);
    let result: string | null = surfaceId;
    if (i >= 0) {
      const reaction = def.reactions?.find((x) => x.other === list[i]!.type);
      if (reaction) result = reaction.result;
      list.splice(i, 1);
    }
    if (result) list.push({ x: t.x, y: t.y, type: result, turns, power });
  }
  host.surfacesChanged(zoneId);
}

export function surfaceAt(host: EffectHost, zoneId: string, x: number, y: number): Surface | undefined {
  return host.surfaces(zoneId).find((s) => s.x === Math.round(x) && s.y === Math.round(y));
}

/** Apply a surface's effect to an actor standing in it (turn start or entering). */
export function applySurface(host: EffectHost, a: Actor, s: Surface) {
  const def = rx(host.r).surface.get(s.type);
  if (!def) return;
  if (def.dot) dealDamage(host, null, a, flatDamage(a.stats(), def.dot.coef * s.power, def.dot.typeId, def.dot.subtypeId), def.dot, { noThorns: true });
  if (def.statusId && a.alive()) addStatus(host, a, def.statusId, 2, s.power);
}

/** Start-of-turn upkeep: damage/heal over time, regeneration, cooldowns, barrier and status expiry. */
export function tickStatuses(host: EffectHost, a: Actor): void {
  const r = host.r;
  const ix = rx(r);
  const next: ActiveStatus[] = [];
  let controlEnded = false;
  for (const s of a.statuses) {
    const def = ix.status.get(s.id);
    if (!def) continue;
    if (def.dot && a.alive()) dealDamage(host, null, a, flatDamage(a.stats(), statusDot(r, s.id, s.power), def.dot.typeId, def.dot.subtypeId), def.dot, { noThorns: true });
    if (def.hot && a.alive()) healActor(host, a, Math.max(1, Math.round(def.hot.coef * s.power)));
    if (s.turns - 1 > 0) next.push({ ...s, turns: s.turns - 1 });
    else if (def.control) controlEnded = true;
  }
  a.statuses = next;
  if (a.controlImmune > 0) a.controlImmune--;
  if (controlEnded) a.controlImmune = r.control.immunityTurns;
  const regen = a.stats().hpRegen;
  if (regen > 0 && a.alive()) healActor(host, a, Math.round(regen));
  if (a.barrierTurns > 0 && --a.barrierTurns <= 0) a.barrier = 0;
  for (const k of Object.keys(a.cooldowns)) {
    a.cooldowns[k] = Math.max(0, a.cooldowns[k]! - 1);
    if (!a.cooldowns[k]) delete a.cooldowns[k];
  }
  a.dirty = true;
}

// ------------------------------------------------------------------------------------ items

export function itemSkill(base: ItemBaseDef): SkillDef {
  const u = base.use!;
  return { id: `item:${base.id}`, name: base.name, description: base.description, owner: 'item', targeting: u.targeting, range: u.targeting === 'ground' ? 8 : u.targeting === 'ally' ? 6 : 0, radius: u.radius, ap: u.ap, cooldown: 0, effects: u.effects, rankBonus: 0, maxRank: 1, tags: ['item'], fx: u.effects.some((e) => e.kind === 'damage') ? 'bolt' : u.effects.some((e) => e.kind === 'heal') ? 'heal' : 'buff', outOfCombat: u.outOfCombat, tune: 1 };
}

export function checkItemUse(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }): string | null {
  const base = rx(host.r).item.get(item.baseId);
  const u = base?.use;
  if (!base || !u || u.tool) return 'That cannot be used here.';
  if (inCombat && user.ap < u.ap) return `Not enough ${host.r.terminology.actionPoints}.`;
  if (!inCombat && !u.outOfCombat && !(u.targeting === 'ground' && (point || target))) return 'Only in combat.';
  if (u.targeting === 'ground') {
    const p = point ?? target;
    if (!p) return 'Choose where to throw it.';
    if (dist(user, p) > 8.5) return 'Out of range.';
  }
  if (u.targeting === 'ally') {
    const t = target ?? user;
    if (relation(user, t) !== 'ally') return 'Use it on an ally.';
    if (dist(user, t) > 6.5) return 'Out of range.';
    if (!t.alive() && !(t.downed() && canReviveWith(host.r, u.effects))) return 'They are down.';
  }
  return null;
}

/** Apply a potion/throwable. The caller removes the item from the inventory. */
export function useConsumable(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }) {
  const base = rx(host.r).item.get(item.baseId)!;
  const u = base.use!;
  if (inCombat) user.ap -= u.ap;
  const skill = itemSkill(base);
  // Item potency follows the item's level (and the user's level, whichever is higher), not the user's class.
  const stats: StatBlock = { ...user.stats(), dpa: refDpa(host.r, Math.max(item.level, user.level)), pct: user.stats().pct };
  const t = u.targeting === 'ally' ? target ?? user : u.targeting === 'self' ? user : target;
  const center = u.targeting === 'ground' ? point ?? (target ? { x: target.x, y: target.y } : { x: user.x, y: user.y }) : { x: (t ?? user).x, y: (t ?? user).y };
  host.fx(user.zoneId, [{ kind: u.targeting === 'ground' ? 'projectile' : 'skill', sourceId: user.id, x: user.x, y: user.y, tx: center.x, ty: center.y, fx: skill.fx, radius: u.radius, element: skillElement(host.r, skill, stats) }]);
  const targets = u.targeting === 'ground' ? resolveTargets(host, user, u.effects, 'ground', u.radius ?? 1.2, center) : t ? [t] : [user];
  runEffects(host, { user, stats, skill, rank: 1, effects: u.effects, targets, center, primary: t, zone: user.zoneId });
  user.dirty = true;
}

/** A trap springing: damage, status and surface at the trap's level. */
export function springTrap(host: EffectHost, zoneId: string, trapId: string, level: number, at: { x: number; y: number }, victims: Actor[]) {
  const r = host.r;
  const def = rx(r).trap.get(trapId) ?? r.traps[0];
  if (!def) return;
  const power = refDpa(r, level);
  for (const t of victims) {
    const amt = flatDamage(t.stats(), def.coef * power * (0.85 + host.rng.next() * 0.3), def.typeId, def.subtypeId);
    dealDamage(host, null, t, amt, { typeId: def.typeId, subtypeId: def.subtypeId }, { noThorns: true });
    if (def.statusId && t.alive()) addStatus(host, t, def.statusId, 2, power);
  }
  if (def.surfaceId) createSurface(host, zoneId, at, def.surfaceId, def.radius || 1, 3, power);
}

export { expectedDamage };
