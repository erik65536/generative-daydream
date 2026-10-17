/** Executes skills, items, traps and surfaces against actors. Shared by combat and real-time play. */
import {
  ITEM_BASE, STATUS_INFO, SURFACE_INFO, applyDamageToPools, skillPower, getSkill, hasLineOfSight, healAmount, powerAtLevel, rollDamage, skillRange, statusCanLand, tilesInRadius, SCHOOL_INFO,
  type ActiveStatus, type DamageType, type FxEvent, type ItemInstance, type Rng, type SkillEffect, type SkillTemplate, type StatusId, type Surface, type SurfaceType, type WorldDefinition,
} from '@gd/shared';
import type { Actor } from './actors';
import { CharActor, MonsterActor, NpcActor } from './actors';
import type { ZoneMap } from './worldctx';

export interface EffectHost {
  world: WorldDefinition;
  rng: Rng;
  now(): number;
  actorsInZone(zoneId: string): Actor[];
  zoneMap(zoneId: string): ZoneMap;
  /** Walkable and unoccupied. */
  isFree(zoneId: string, x: number, y: number, ignoreId?: string): boolean;
  fx(zoneId: string, events: FxEvent[]): void;
  surfaces(zoneId: string): Surface[];
  surfacesChanged(zoneId: string): void;
  onDamaged(target: Actor, source: Actor | null, amount: number): void;
  onDowned(target: Actor, source: Actor | null): void;
  log(zoneId: string, text: string, color?: string): void;
  actorMoved(a: Actor): void;
}

export function relation(a: Actor, b: Actor): 'ally' | 'enemy' | 'neutral' {
  if (a === b) return 'ally';
  const ta = a.team(), tb = b.team();
  if (a instanceof CharActor && b instanceof CharActor) return 'ally';
  if (a instanceof CharActor && b instanceof NpcActor) return b.rt.hostileTo.includes(a.userId) ? 'enemy' : b.rt.partyOf === a.userId ? 'ally' : 'neutral';
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
  skill: SkillTemplate;
  target?: Actor;
  point?: { x: number; y: number };
  /** Called for out-of-combat realtime use. */
  realtime?: boolean;
}

/** Returns an error message, or null if the skill may be used now. */
export function checkSkill(host: EffectHost, use: SkillUse, opts: { inCombat: boolean }): string | null {
  const { user, skill, target, point } = use;
  if (!user.alive()) return 'You cannot act right now.';
  if (skill.passive) return 'That is a passive ability.';
  if (opts.inCombat && user.ap < skill.ap) return 'Not enough action points.';
  if (!opts.inCombat && !skill.outOfCombat && skill.id !== 'attack' && !(target && isHostileTo(user, target)) && !(skill.targeting === 'ground' && point)) return 'That can only be used in combat.';
  const cd = user.cooldowns[skill.id] ?? 0;
  if (cd > 0) return `Ready in ${cd} turn${cd > 1 ? 's' : ''}.`;
  const pool = skill.pool ?? SCHOOL_INFO[skill.school].pool;
  if (user instanceof CharActor && skill.cost > 0) {
    const usePool = host.world.systems.dualEnergy ? pool : 'stamina';
    if ((usePool === 'stamina' ? user.stamina : user.focus) < skill.cost) return `Not enough ${host.world.terminology[usePool]}.`;
  }
  const stats = user.stats();
  const range = skillRange(skill, stats);
  const origin = { x: user.x, y: user.y };
  const map = host.zoneMap(user.zoneId);
  const los = (p: { x: number; y: number }) => hasLineOfSight(origin, p, (x, y) => map.opaque[y * map.def.width + x] === 1);
  switch (skill.targeting) {
    case 'self':
      return null;
    case 'enemy':
      if (!target || !target.alive()) return 'Choose a target.';
      if (relation(user, target) === 'ally') return 'That is an ally.';
      if (dist(origin, target) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(target)) return 'No line of sight.';
      if (skill.effects.some((e) => e.kind === 'dash') && !findLandingNear(host, user, target)) return 'No room to land there.';
      return null;
    case 'ally':
      if (!target) return 'Choose an ally.';
      if (relation(user, target) !== 'ally') return 'Choose an ally.';
      if (!skill.effects.some((e) => e.kind === 'revive') && !target.alive()) return 'They are down — they need reviving.';
      if (skill.effects.some((e) => e.kind === 'revive') && target.alive()) return 'They are not down.';
      if (dist(origin, target) > range + 0.01) return 'Out of range.';
      return null;
    case 'ground':
    case 'any': {
      const p = point ?? target;
      if (!p) return 'Choose a location.';
      if (dist(origin, p) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(p)) return 'No line of sight.';
      if (skill.effects.some((e) => e.kind === 'teleport') && !host.isFree(user.zoneId, Math.round(p.x), Math.round(p.y), user.id)) return 'Cannot land there.';
      return null;
    }
  }
}

function findLandingNear(host: EffectHost, user: Actor, target: Actor): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = Math.round(target.x) + dx, y = Math.round(target.y) + dy;
      if (!host.isFree(user.zoneId, x, y, user.id)) continue;
      const d = Math.hypot(x - user.x, y - user.y);
      if (d < bd) {
        bd = d;
        best = { x, y };
      }
    }
  return best;
}

function attrFor(skill: SkillTemplate) {
  return skill.scaling ?? SCHOOL_INFO[skill.school].attribute;
}

export function addStatus(host: EffectHost, target: Actor, status: StatusId, turns: number, power: number, sourceId?: string): boolean {
  if (!statusCanLand(target, status)) return false;
  const existing = target.statuses.find((s) => s.id === status);
  if (existing) {
    existing.turns = Math.max(existing.turns, turns);
    existing.power = Math.max(existing.power, power);
  } else target.statuses = [...target.statuses, { id: status, turns, power, sourceId }];
  // Fire removes wet & chilled; wet removes burning.
  if (status === 'burning') target.statuses = target.statuses.filter((s) => s.id !== 'wet' && s.id !== 'chilled' && s.id !== 'frozen');
  if (status === 'wet') target.statuses = target.statuses.filter((s) => s.id !== 'burning');
  if (status === 'frozen') target.statuses = target.statuses.filter((s) => s.id !== 'burning');
  target.dirty = true;
  return true;
}

/** Deal damage; returns damage dealt to health. */
export function dealDamage(host: EffectHost, source: Actor | null, target: Actor, amount: number, type: DamageType, opts: { crit?: boolean; noThorns?: boolean } = {}): number {
  if (!target.alive()) return 0;
  const applied = applyDamageToPools(target, amount, type);
  const total = applied.toHp + applied.toMag + applied.toPhys;
  host.fx(target.zoneId, [{ kind: 'damage', targetId: target.id, damage: { targetId: target.id, amount: total, type, crit: opts.crit } }]);
  target.dirty = true;
  if (source && !opts.noThorns) {
    const thorns = target.stats().thorns;
    if (thorns > 0 && dist(source, target) < 2.2) dealDamage(host, null, source, thorns, 'physical', { noThorns: true });
  }
  host.onDamaged(target, source, total);
  if (target.hp <= 0) {
    target.hp = 0;
    host.onDowned(target, source);
  }
  return applied.toHp;
}

export function healActor(host: EffectHost, target: Actor, amount: number) {
  if (!target.alive()) return;
  const max = target.stats().maxHp;
  const before = target.hp;
  target.hp = Math.min(max, target.hp + amount);
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

/** Execute a validated skill. Spends costs and sets cooldowns. */
export function executeSkill(host: EffectHost, use: SkillUse, inCombat: boolean): void {
  const { user, skill } = use;
  const stats = user.stats();
  const zone = user.zoneId;
  const actors = host.actorsInZone(zone).filter((a) => a.alive() || skill.effects.some((e) => e.kind === 'revive'));
  // Costs
  if (inCombat) user.ap -= skill.ap;
  if (skill.cooldown > 0) user.cooldowns[skill.id] = inCombat ? skill.cooldown + 1 : skill.cooldown + 1;
  if (user instanceof CharActor && skill.cost > 0) {
    const pool = host.world.systems.dualEnergy ? skill.pool ?? SCHOOL_INFO[skill.school].pool : 'stamina';
    if (pool === 'stamina') user.stamina -= skill.cost;
    else user.focus -= skill.cost;
  }
  if (use.target) user.facing = Math.atan2(use.target.y - user.y, use.target.x - user.x);
  else if (use.point) user.facing = Math.atan2(use.point.y - user.y, use.point.x - user.x);
  const center = skill.targeting === 'self' ? { x: user.x, y: user.y } : use.point ?? (use.target ? { x: use.target.x, y: use.target.y } : { x: user.x, y: user.y });
  const harmful = skill.effects.some((e) => e.kind === 'damage' || (e.kind === 'status' && STATUS_INFO[e.status].harmful));
  // Resolve targets
  let targets: Actor[] = [];
  if (skill.radius) {
    targets = actors.filter((a) => dist(a, center) <= skill.radius! + 0.01 && (harmful ? isHostileTo(user, a) : relation(user, a) === 'ally'));
  } else if (use.target) targets = [use.target];
  else if (skill.targeting === 'self') targets = [user];
  // FX
  const ranged = skill.range === 'weapon' ? stats.weaponRange > 2 : (skill.range as number) > 2;
  host.fx(zone, [{ kind: ranged && skill.targeting !== 'self' ? 'projectile' : 'skill', sourceId: user.id, targetId: use.target?.id, x: user.x, y: user.y, tx: center.x, ty: center.y, skillId: skill.id, fx: skill.fx, radius: skill.radius, element: skillElement(skill, stats.weaponType) }]);
  // Movement effects first.
  for (const e of skill.effects) {
    if (e.kind === 'teleport' && use.point) teleport(host, user, Math.round(use.point.x), Math.round(use.point.y));
    if (e.kind === 'dash' && use.target) {
      const land = findLandingNear(host, user, use.target);
      if (land) teleport(host, user, land.x, land.y);
    }
  }
  let dealtTotal = 0;
  const rand = () => host.rng.next();
  for (const t of targets) {
    for (const e of skill.effects) {
      switch (e.kind) {
        case 'damage': {
          const roll = rollDamage({ stats, statuses: user.statuses, physArmor: user.physArmor, magArmor: user.magArmor, hp: user.hp }, { stats: t.stats(), statuses: t.statuses, physArmor: t.physArmor, magArmor: t.magArmor, hp: t.hp }, e, skill, attrFor(skill), rand);
          if (roll.miss) {
            host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Miss', color: '#cccccc' }]);
            host.onDamaged(t, user, 0);
            break;
          }
          dealtTotal += dealDamage(host, user, t, roll.amount, roll.type, { crit: roll.crit });
          if (e.source === 'weapon') for (const oh of stats.onHit) dealDamage(host, user, t, oh.amount, oh.type, { noThorns: true });
          if (stats.lifesteal > 0) healActor(host, user, Math.round((roll.amount * stats.lifesteal) / 100));
          // Shock on wet targets may stun.
          if (roll.type === 'shock' && t.statuses.some((s) => s.id === 'wet') && host.rng.chance(0.5)) addStatus(host, t, 'stunned', 1, 0, user.id);
          break;
        }
        case 'heal':
          healActor(host, t, healAmount(stats, e.mult, attrFor(skill) === 'wits' ? 'vitality' : 'spirit'));
          break;
        case 'armor': {
          const ts = t.stats();
          const amt = Math.round(healAmount(stats, e.mult, attrFor(skill)) * 0.9);
          if (e.pool === 'phys') t.physArmor = Math.min(ts.maxPhys, t.physArmor + amt);
          else t.magArmor = Math.min(ts.maxMag, t.magArmor + amt);
          host.fx(zone, [{ kind: 'damage', targetId: t.id, damage: { targetId: t.id, amount: amt, type: e.pool === 'phys' ? 'armor_phys' : 'armor_mag' } }]);
          t.dirty = true;
          break;
        }
        case 'status': {
          const who = e.target === 'self' ? user : t;
          if (host.rng.chance(e.chance)) {
            const landed = addStatus(host, who, e.status, e.turns, skillPower(stats, attrFor(skill)), user.id);
            if (landed) host.fx(zone, [{ kind: 'text', targetId: who.id, text: host.world.terminology.statuses[e.status], color: STATUS_INFO[e.status].color }]);
            if (e.status === 'taunted' && landed) who.statuses.find((s) => s.id === 'taunted')!.sourceId = user.id;
          }
          break;
        }
        case 'cleanse':
          t.statuses = t.statuses.filter((s) => !STATUS_INFO[s.id].harmful);
          host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Cleansed', color: '#a0ffd0' }]);
          break;
        case 'revive':
          if (t instanceof CharActor && t.ch.downed) {
            t.ch.downed = false;
            t.ch.hp = Math.round(t.stats().maxHp * e.fraction);
            host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Revived', color: '#ffe680' }]);
            t.dirty = true;
          }
          break;
        case 'ap':
          t.ap += e.amount;
          break;
        default:
          break;
      }
    }
  }
  // Effects not per-target.
  for (const e of skill.effects) {
    if (e.kind === 'lifesteal' && dealtTotal > 0) healActor(host, user, Math.round(dealtTotal * e.fraction));
    if (e.kind === 'chain' && use.target) chain(host, user, skill, use.target, e, actors);
    if (e.kind === 'surface') createSurface(host, zone, center, e.surface, e.radius, e.turns, skillPower(stats, attrFor(skill)));
    if (e.kind === 'ap' && !targets.includes(user) && skill.targeting === 'self') user.ap += e.amount;
  }
  user.dirty = true;
}

function chain(host: EffectHost, user: Actor, skill: SkillTemplate, first: Actor, e: Extract<SkillEffect, { kind: 'chain' }>, actors: Actor[]) {
  const hit = new Set([first.id]);
  let cur = first;
  let mult = 1;
  const dmg = skill.effects.find((x) => x.kind === 'damage') as Extract<SkillEffect, { kind: 'damage' }> | undefined;
  if (!dmg) return;
  for (let j = 0; j < e.jumps; j++) {
    const next = actors.filter((a) => !hit.has(a.id) && a.alive() && isHostileTo(user, a) && dist(a, cur) < 5).sort((a, b) => dist(a, cur) - dist(b, cur))[0];
    if (!next) break;
    mult *= e.falloff;
    hit.add(next.id);
    host.fx(user.zoneId, [{ kind: 'projectile', sourceId: cur.id, targetId: next.id, x: cur.x, y: cur.y, tx: next.x, ty: next.y, fx: 'beam', element: 'shock', skillId: skill.id }]);
    const roll = rollDamage({ stats: user.stats(), statuses: user.statuses, physArmor: 0, magArmor: 0, hp: user.hp }, { stats: next.stats(), statuses: next.statuses, physArmor: 0, magArmor: 0, hp: next.hp }, { ...dmg, mult: dmg.mult * mult }, skill, attrFor(skill), () => host.rng.next(), false);
    dealDamage(host, user, next, roll.amount, roll.type, { crit: roll.crit });
    cur = next;
  }
}

export function skillElement(skill: SkillTemplate, weaponType: DamageType): DamageType {
  const d = skill.effects.find((e) => e.kind === 'damage') as Extract<SkillEffect, { kind: 'damage' }> | undefined;
  if (!d) return skill.school === 'restoration' ? 'radiant' : 'physical';
  return d.type === 'weapon' ? weaponType : d.type;
}

// ----------------------------------------------------------------------------------- surfaces

export function createSurface(host: EffectHost, zoneId: string, center: { x: number; y: number }, type: SurfaceType, radius: number, turns: number, power: number) {
  const map = host.zoneMap(zoneId);
  const list = host.surfaces(zoneId);
  for (const t of tilesInRadius(center.x, center.y, radius, map.def.width, map.def.height)) {
    if (map.solid[t.y * map.def.width + t.x]) continue;
    const i = list.findIndex((s) => s.x === t.x && s.y === t.y);
    const existing = i >= 0 ? list[i] : undefined;
    let result: SurfaceType | null = type;
    if (existing) {
      if (type === 'fire' && existing.type === 'water') result = null;
      else if (type === 'water' && existing.type === 'fire') result = null;
      else if (type === 'fire' && existing.type === 'ice') result = 'water';
      else if (type === 'fire' && existing.type === 'oil') result = 'fire';
      else if (type === 'water' && existing.type === 'poison') result = 'water';
      list.splice(i, 1);
    }
    if (result) list.push({ x: t.x, y: t.y, type: result, turns, power });
  }
  host.surfacesChanged(zoneId);
}

/** Frost/fire damage reacting with surfaces under a point. */
export function surfaceAt(host: EffectHost, zoneId: string, x: number, y: number): Surface | undefined {
  return host.surfaces(zoneId).find((s) => s.x === Math.round(x) && s.y === Math.round(y));
}

/** Apply a surface's effect to an actor standing in it (turn start or entering). */
export function applySurface(host: EffectHost, a: Actor, s: Surface) {
  const info = SURFACE_INFO[s.type];
  if (info.damage) dealDamage(host, null, a, Math.max(1, Math.round(s.power * 0.35)), info.damage);
  if (info.status && a.alive()) addStatus(host, a, info.status, 2, s.power);
}

/** Damage-over-time and regeneration at the start of a turn. Returns true if the actor must skip the turn. */
export function tickStatuses(host: EffectHost, a: Actor): boolean {
  let skip = false;
  const next: ActiveStatus[] = [];
  for (const s of a.statuses) {
    const def = STATUS_INFO[s.id];
    if (def.dot && a.alive()) dealDamage(host, null, a, Math.max(1, Math.round(s.power * def.dot.mult)), def.dot.type, { noThorns: true });
    if (s.id === 'regenerating' && a.alive()) healActor(host, a, Math.max(1, Math.round(s.power * 0.45)));
    if (def.skipTurn) skip = true;
    if (s.turns - 1 > 0) next.push({ ...s, turns: s.turns - 1 });
  }
  a.statuses = next;
  const regen = a.stats().regen;
  if (regen > 0 && a.alive()) healActor(host, a, regen);
  for (const k of Object.keys(a.cooldowns)) {
    a.cooldowns[k] = Math.max(0, a.cooldowns[k]! - 1);
    if (!a.cooldowns[k]) delete a.cooldowns[k];
  }
  a.dirty = true;
  return skip && a.alive();
}

// ----------------------------------------------------------------------------------- items

export function checkItemUse(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }): string | null {
  const base = ITEM_BASE[item.baseId];
  const c = base?.consumable;
  if (!base || !c) return 'That cannot be used.';
  if (inCombat && base.combatUse === undefined) return 'Not usable in combat.';
  if (inCombat && user.ap < (base.combatUse ?? 1)) return 'Not enough action points.';
  if (c.kind === 'bomb') {
    const p = point ?? target;
    if (!p) return 'Choose where to throw it.';
    if (dist(user, p) > 9) return 'Out of range.';
    if (!inCombat && !(target && isHostileTo(user, target)) && !point) return 'Throw it at an enemy.';
  }
  if (c.kind === 'recall' && inCombat) return 'Not during combat.';
  return null;
}

/** Apply a consumable. The caller removes the item from the inventory. */
export function useConsumable(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }) {
  const base = ITEM_BASE[item.baseId]!;
  const c = base.consumable!;
  if (inCombat) user.ap -= base.combatUse ?? 1;
  const t = target && relation(user, target) === 'ally' ? target : user;
  const lvl = item.level;
  switch (c.kind) {
    case 'heal':
      healActor(host, t, Math.round(powerAtLevel(Math.max(lvl, user.level)) * c.mult));
      host.fx(t.zoneId, [{ kind: 'skill', sourceId: t.id, x: t.x, y: t.y, tx: t.x, ty: t.y, fx: 'heal' }]);
      break;
    case 'restore':
      if (c.pool === 'stamina' || !host.world.systems.dualEnergy) t.stamina = Math.min(t.stats().maxStamina, t.stamina + t.stats().maxStamina * c.fraction);
      else t.focus = Math.min(t.stats().maxFocus, t.focus + t.stats().maxFocus * c.fraction);
      host.fx(t.zoneId, [{ kind: 'skill', sourceId: t.id, x: t.x, y: t.y, tx: t.x, ty: t.y, fx: 'buff' }]);
      break;
    case 'cleanse':
      t.statuses = t.statuses.filter((s) => !STATUS_INFO[s.id].harmful);
      host.fx(t.zoneId, [{ kind: 'text', targetId: t.id, text: 'Cleansed', color: '#a0ffd0' }]);
      break;
    case 'buff':
      addStatus(host, t, c.status, c.turns, powerAtLevel(lvl), user.id);
      host.fx(t.zoneId, [{ kind: 'text', targetId: t.id, text: host.world.terminology.statuses[c.status], color: STATUS_INFO[c.status].color }]);
      break;
    case 'bomb': {
      const p = point ?? (target ? { x: target.x, y: target.y } : { x: user.x, y: user.y });
      host.fx(user.zoneId, [{ kind: 'projectile', sourceId: user.id, x: user.x, y: user.y, tx: p.x, ty: p.y, fx: 'bolt', element: c.damage, radius: c.radius }]);
      const power = powerAtLevel(Math.max(lvl, user.level)) * c.mult;
      for (const a of host.actorsInZone(user.zoneId)) if (a.alive() && dist(a, p) <= c.radius + 0.01 && isHostileTo(user, a)) dealDamage(host, user, a, Math.round(power * (0.9 + host.rng.next() * 0.2)), c.damage);
      if (c.damage === 'fire') createSurface(host, user.zoneId, p, 'fire', 1.2, 2, power);
      if (c.damage === 'frost') {
        createSurface(host, user.zoneId, p, 'ice', 1.5, 2, power);
        for (const a of host.actorsInZone(user.zoneId)) if (a.alive() && dist(a, p) <= c.radius && isHostileTo(user, a)) addStatus(host, a, 'chilled', 2, power);
      }
      break;
    }
    default:
      break;
  }
  user.dirty = true;
}

export function trapPower(level: number) {
  return powerAtLevel(level);
}

export { getSkill };
