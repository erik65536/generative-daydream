/** Combat math shared by the server, the simulator (identical code paths) and client previews. */
import type { Effect, Ruleset, SkillDef } from './types';
import { rx, type StatBlock } from './stats';

export interface Combatant {
  stats: StatBlock;
  hp: number;
  barrier: number;
}

export type DamageEffect = Extract<Effect, { kind: 'damage' }>;

export function potency(skill: SkillDef, rank: number): number {
  return skill.tune * (1 + skill.rankBonus * Math.max(0, rank - 1));
}

export function isBasic(skill: SkillDef): boolean {
  return skill.tags.includes('basic');
}

/** AP a skill costs for this user (the basic attack costs the weapon's AP). */
export function skillAp(skill: SkillDef, stats: StatBlock): number {
  return isBasic(skill) ? stats.weapon.apCost : skill.ap;
}

export function skillRange(skill: SkillDef, stats: StatBlock): number {
  return skill.weaponRange || isBasic(skill) ? stats.weapon.range : skill.range;
}

/** Type and subtype an effect deals. */
export function damageKind(r: Ruleset, e: DamageEffect, stats: StatBlock): { typeId: string; subtypeId?: string } {
  const subId = e.subtypeId === '$family' ? stats.familySubtypeId : e.subtypeId;
  if (e.weapon) return { typeId: e.typeId ?? stats.weapon.typeId, subtypeId: subId ?? (e.typeId ? undefined : stats.weapon.subtypeId) };
  if (subId) {
    const sub = rx(r).subtype.get(subId);
    if (sub) return { typeId: sub.typeId, subtypeId: sub.id };
  }
  return { typeId: e.typeId ?? r.damageTypes[0]!.id };
}

/** Sum of applicable additive damage bonuses (as a multiplier). */
export function damageBonus(stats: StatBlock, tag: 'melee' | 'ranged' | 'spell', typeId: string, subtypeId?: string): number {
  const p = stats.pct;
  return 1 + ((p.power ?? 0) + (p[`dmg:${tag}`] ?? 0) + (p[`dmg:${typeId}`] ?? 0) + (subtypeId ? p[`dmg:${subtypeId}`] ?? 0 : 0)) / 100;
}

function sourceTag(e: DamageEffect, stats: StatBlock): 'melee' | 'ranged' | 'spell' {
  return e.weapon ? (stats.weapon.melee ? 'melee' : 'ranged') : 'spell';
}

/** Raw (pre-roll, pre-mitigation) damage of an effect. */
export function rawDamage(skill: SkillDef, rank: number, e: DamageEffect, stats: StatBlock): number {
  if (isBasic(skill)) return ((stats.weapon.min + stats.weapon.max) / 2) * potency(skill, rank);
  const perAp = e.weapon ? (stats.weapon.min + stats.weapon.max) / 2 / stats.weapon.apCost : stats.dpa;
  return e.coef * perAp * potency(skill, rank);
}

/** Multiplier from the target's mitigation and resistance. */
export function defenseMult(target: StatBlock, typeId: string, subtypeId?: string): number {
  return (1 - (target.mitigation[typeId] ?? 0)) * (1 - (subtypeId ? target.resist[subtypeId] ?? 0 : 0)) * target.taken;
}

/** Resolve the `$family` placeholder of monster skills to the actor's family status. */
export function resolveStatusId(r: Ruleset, statusId: string, stats: StatBlock): string | undefined {
  if (statusId !== '$family') return statusId;
  return stats.familySubtypeId ? rx(r).subtype.get(stats.familySubtypeId)?.statusId : undefined;
}

export interface DamageRoll {
  amount: number;
  typeId: string;
  subtypeId?: string;
  crit: boolean;
  dodged: boolean;
}

/** Roll one damage effect. `rand` returns [0,1). Weapon-based effects can be dodged. */
export function rollDamage(r: Ruleset, attacker: StatBlock, target: StatBlock, skill: SkillDef, rank: number, e: DamageEffect, rand: () => number, mult = 1): DamageRoll {
  const kind = damageKind(r, e, attacker);
  if ((e.weapon || isBasic(skill)) && target.dodge > 0 && rand() < target.dodge) return { amount: 0, ...kind, crit: false, dodged: true };
  let raw = rawDamage(skill, rank, e, attacker) * mult;
  if (!isBasic(skill)) raw *= 1 + (rand() * 2 - 1) * r.resolution.variance;
  raw *= damageBonus(attacker, isBasic(skill) ? (attacker.weapon.melee ? 'melee' : 'ranged') : sourceTag(e, attacker), kind.typeId, kind.subtypeId);
  const crit = attacker.crit > 0 && rand() < attacker.crit;
  if (crit) raw *= attacker.critMult;
  raw *= defenseMult(target, kind.typeId, kind.subtypeId);
  return { amount: Math.max(1, Math.round(raw)), ...kind, crit, dodged: false };
}

/** Average damage (used by the AI and UI previews). */
export function expectedDamage(r: Ruleset, attacker: StatBlock, target: StatBlock, skill: SkillDef, rank: number, e: DamageEffect, mult = 1): number {
  const kind = damageKind(r, e, attacker);
  let v = rawDamage(skill, rank, e, attacker) * mult;
  v *= damageBonus(attacker, isBasic(skill) ? (attacker.weapon.melee ? 'melee' : 'ranged') : sourceTag(e, attacker), kind.typeId, kind.subtypeId);
  v *= 1 + attacker.crit * (attacker.critMult - 1);
  if (e.weapon || isBasic(skill)) v *= 1 - target.dodge;
  return v * defenseMult(target, kind.typeId, kind.subtypeId);
}

/** Damage after mitigation for a flat amount (traps, surfaces, damage over time). */
export function flatDamage(target: StatBlock, amount: number, typeId: string, subtypeId?: string): number {
  return Math.max(1, Math.round(amount * defenseMult(target, typeId, subtypeId)));
}

export function healAmount(stats: StatBlock, coef: number, skillPotency = 1): number {
  return Math.round(coef * stats.dpa * skillPotency * (1 + (stats.pct.healing ?? 0) / 100));
}

/** Apply damage to barrier, then health. Mutates `t`; returns { toBarrier, toHp }. */
export function applyDamage(t: { hp: number; barrier: number }, amount: number): { toBarrier: number; toHp: number } {
  const toBarrier = Math.min(t.barrier, amount);
  t.barrier -= toBarrier;
  const toHp = Math.min(t.hp, amount - toBarrier);
  t.hp -= toHp;
  return { toBarrier, toHp };
}

/** Damage-over-time per turn for a status applied with `power` (the applier's damage per AP). */
export function statusDot(r: Ruleset, statusId: string, power: number): number {
  const def = rx(r).status.get(statusId);
  return def?.dot ? def.dot.coef * power : 0;
}
