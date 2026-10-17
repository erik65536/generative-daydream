/** Derived statistics and combat math, shared so the client can preview exactly what the server does. */
import { ATTRIBUTES, DAMAGE_ARMOR, DAMAGE_TYPES, STATUS_INFO, type AttributeId, type DamageType, type StatusId } from './core';
import { ITEM_BASE, armorValue, weaponDamage, type AffixStat, type ItemInstance } from './items';
import { ARCHETYPES, monsterBaseStats, type MonsterArchetype } from './actors';
import { ATTRIBUTE_BASE, BASE_AP_PER_TURN, TILES_PER_AP, powerAtLevel } from './progression';
import type { ActiveStatus, CharacterState } from '../world/instance';
import type { SkillEffect, SkillTemplate } from './skills';

export interface DerivedStats {
  level: number;
  attributes: Record<AttributeId, number>;
  maxHp: number;
  maxStamina: number;
  maxFocus: number;
  maxPhys: number;
  maxMag: number;
  evasion: number;
  critChance: number;
  critMult: number;
  initiative: number;
  tilesPerAp: number;
  apPerTurn: number;
  apStart: number;
  weaponMin: number;
  weaponMax: number;
  weaponRange: number;
  weaponType: DamageType;
  weaponScaling: AttributeId;
  damagePct: number;
  healingPct: number;
  resist: Record<DamageType, number>;
  lifesteal: number;
  thorns: number;
  regen: number;
  lootFind: number;
  onHit: { type: DamageType; amount: number }[];
  /** Fixed skill power (monsters derive it from their damage budget instead of their level). */
  power?: number;
}

const attrMult = (v: number) => 1 + (v - ATTRIBUTE_BASE) * 0.05;

export function emptyResist(): Record<DamageType, number> {
  return Object.fromEntries(DAMAGE_TYPES.map((d) => [d, 0])) as Record<DamageType, number>;
}

export interface CharacterStatOptions {
  /** Party of one gets the "lone wolf" bonus. */
  loneWolf?: boolean;
  dualEnergy?: boolean;
}

export function computeCharacterStats(c: Pick<CharacterState, 'level' | 'attributes' | 'equipment' | 'statuses'>, opts: CharacterStatOptions = {}): DerivedStats {
  const attrs = { ...c.attributes };
  const aff: Partial<Record<AffixStat, number>> = {};
  let phys = 0, mag = 0;
  const items = Object.values(c.equipment).filter(Boolean) as ItemInstance[];
  for (const it of items) {
    const base = ITEM_BASE[it.baseId];
    if (!base) continue;
    if (base.armor) {
      const a = armorValue(it.level, base, it.rarity);
      phys += a.phys;
      mag += a.mag;
    }
    for (const a of it.affixes) aff[a.stat] = (aff[a.stat] ?? 0) + a.value;
  }
  for (const k of ATTRIBUTES) attrs[k] += aff[`attr_${k}` as AffixStat] ?? 0;
  const L = c.level;
  const weapon = c.equipment.mainhand;
  const wbase = weapon ? ITEM_BASE[weapon.baseId] : undefined;
  let weaponMin: number, weaponMax: number, weaponRange: number, weaponType: DamageType, weaponScaling: AttributeId;
  if (weapon && wbase?.weapon) {
    const [mn, mx] = weaponDamage(weapon.level, wbase, weapon.rarity);
    const m = attrMult(attrs[wbase.weapon.scaling]);
    weaponMin = Math.round(mn * m);
    weaponMax = Math.round(mx * m);
    weaponRange = wbase.weapon.range;
    weaponType = wbase.weapon.damageType === 'element' ? weapon.element ?? 'fire' : wbase.weapon.damageType;
    weaponScaling = wbase.weapon.scaling;
  } else {
    const p = powerAtLevel(L) * 0.55 * attrMult(attrs.might);
    weaponMin = Math.max(1, Math.round(p * 0.8));
    weaponMax = Math.max(2, Math.round(p * 1.2));
    weaponRange = 1.6;
    weaponType = 'physical';
    weaponScaling = 'might';
  }
  const lone = opts.loneWolf ? 1.6 : 1;
  const resist = emptyResist();
  for (const d of ['fire', 'frost', 'shock', 'poison', 'psychic'] as const) resist[d] = Math.min(75, aff[`res_${d}` as AffixStat] ?? 0);
  const onHit: DerivedStats['onHit'] = [];
  for (const d of ['fire', 'frost', 'shock', 'poison'] as const) if (aff[`onhit_${d}` as AffixStat]) onHit.push({ type: d, amount: aff[`onhit_${d}` as AffixStat]! });
  const dual = opts.dualEnergy !== false;
  const stamina = 30 + 3 * (L - 1) + (attrs.might - 10 + attrs.finesse - 10) * 1.5 + (aff.maxStamina ?? 0);
  const focus = 30 + 3 * (L - 1) + (attrs.intellect - 10 + attrs.spirit - 10) * 1.5 + (aff.maxFocus ?? 0);
  const s: DerivedStats = {
    level: L,
    attributes: attrs,
    maxHp: Math.round(((40 + 14 * (L - 1)) * (1 + (attrs.vitality - 10) * 0.07) + (aff.maxHealth ?? 0)) * lone),
    maxStamina: Math.round(dual ? stamina : stamina + focus * 0.5),
    maxFocus: Math.round(dual ? focus : 0),
    maxPhys: Math.round((phys * (1 + (attrs.vitality - 10) * 0.02) + (aff.physArmor ?? 0)) * lone),
    maxMag: Math.round((mag * (1 + (attrs.spirit - 10) * 0.02) + (aff.magArmor ?? 0)) * lone),
    evasion: Math.min(30, Math.max(0, (attrs.finesse - 10) * 1)),
    critChance: Math.min(60, 5 + Math.max(0, attrs.wits - 10) * 2 + (aff.critChance ?? 0)),
    critMult: 1.5 + (aff.critDamage ?? 0) / 100,
    initiative: attrs.finesse + attrs.wits - 10 + (aff.initiative ?? 0),
    tilesPerAp: TILES_PER_AP + Math.max(0, attrs.finesse - 10) * 0.05 + (aff.movement ?? 0),
    apPerTurn: BASE_AP_PER_TURN + (opts.loneWolf ? 1 : 0),
    apStart: BASE_AP_PER_TURN + (aff.apStart ?? 0) + (opts.loneWolf ? 1 : 0),
    weaponMin, weaponMax, weaponRange, weaponType, weaponScaling,
    damagePct: (aff.damagePct ?? 0) + (opts.loneWolf ? 25 : 0),
    healingPct: aff.healingPct ?? 0,
    resist,
    lifesteal: aff.lifesteal ?? 0,
    thorns: aff.thorns ?? 0,
    regen: aff.regen ?? 0,
    lootFind: aff.lootFind ?? 0,
    onHit,
  };
  applyStatusModifiers(s, c.statuses);
  return s;
}

export interface MonsterStatInput {
  level: number;
  archetype: MonsterArchetype;
  element: DamageType;
  boss?: boolean;
  elite?: boolean;
  statuses: ActiveStatus[];
}

export function computeMonsterStats(m: MonsterStatInput): DerivedStats {
  const a = ARCHETYPES[m.archetype];
  const b = monsterBaseStats(m.level);
  const bossMult = m.boss ? { hp: 5.5, dmg: 1.45, arm: 2 } : m.elite ? { hp: 1.8, dmg: 1.2, arm: 1.4 } : { hp: 1, dmg: 1, arm: 1 };
  const dmg = b.damage * a.damage * bossMult.dmg;
  const attrs = Object.fromEntries(ATTRIBUTES.map((k) => [k, 10 + Math.floor(m.level / 3)])) as Record<AttributeId, number>;
  attrs[a.primary] += 3;
  const isCaster = m.archetype === 'caster' || m.archetype === 'healer';
  const resist = emptyResist();
  if (m.element !== 'physical' && m.element !== 'piercing') resist[m.element] = 40;
  const s: DerivedStats = {
    level: m.level,
    attributes: attrs,
    maxHp: Math.round(b.health * a.health * bossMult.hp),
    maxStamina: 100,
    maxFocus: 100,
    maxPhys: Math.round(b.phys * a.phys * bossMult.arm),
    maxMag: Math.round(b.mag * a.mag * bossMult.arm),
    evasion: m.archetype === 'skirmisher' || m.archetype === 'assassin' ? 8 : 0,
    critChance: 5 + (m.archetype === 'assassin' ? 10 : 0),
    critMult: 1.5,
    initiative: 10 + a.initiative + Math.floor(m.level / 2),
    tilesPerAp: TILES_PER_AP * a.moveSpeed,
    apPerTurn: BASE_AP_PER_TURN + (m.boss ? 1 : 0),
    apStart: BASE_AP_PER_TURN + (m.boss ? 1 : 0),
    weaponMin: Math.max(1, Math.round(dmg * 0.85)),
    weaponMax: Math.max(2, Math.round(dmg * 1.15)),
    weaponRange: a.range,
    weaponType: isCaster ? m.element : 'physical',
    weaponScaling: a.primary,
    damagePct: 0,
    healingPct: 0,
    resist,
    lifesteal: 0,
    thorns: 0,
    regen: 0,
    lootFind: 0,
    onHit: [],
    power: dmg * 0.9,
  };
  applyStatusModifiers(s, m.statuses);
  return s;
}

function applyStatusModifiers(s: DerivedStats, statuses: ActiveStatus[]) {
  const has = (id: StatusId) => statuses.some((x) => x.id === id);
  if (has('chilled')) s.tilesPerAp *= 0.5;
  if (has('slowed')) s.apPerTurn -= 1;
  if (has('hasted')) s.apPerTurn += 2;
}

/** Skill power used by non-weapon skills, scaled by the governing attribute. */
export function skillPower(stats: DerivedStats, attr: AttributeId): number {
  if (stats.power !== undefined) return stats.power;
  return powerAtLevel(stats.level) * attrMult(stats.attributes[attr]);
}

export interface ActorForMath {
  stats: DerivedStats;
  statuses: ActiveStatus[];
  physArmor: number;
  magArmor: number;
  hp: number;
}

export interface DamageRoll {
  amount: number;
  type: DamageType;
  crit: boolean;
  miss: boolean;
}

export function statusMult(attacker: ActiveStatus[], target: ActiveStatus[]): number {
  let m = 1;
  if (attacker.some((s) => s.id === 'empowered')) m *= 1.25;
  if (attacker.some((s) => s.id === 'weakened')) m *= 0.75;
  if (target.some((s) => s.id === 'vulnerable')) m *= 1.25;
  if (target.some((s) => s.id === 'fortified')) m *= 0.75;
  return m;
}

/** Roll damage for one damage effect. `rand` returns [0,1). */
export function rollDamage(
  attacker: ActorForMath,
  target: ActorForMath,
  effect: Extract<SkillEffect, { kind: 'damage' }>,
  skill: SkillTemplate,
  attrForSkill: AttributeId,
  rand: () => number,
  canMiss = true,
): DamageRoll {
  const type: DamageType = effect.type === 'weapon' ? attacker.stats.weaponType : effect.type;
  if (canMiss && effect.source === 'weapon' && rand() * 100 < Math.max(0, target.stats.evasion - 0)) {
    return { amount: 0, type, crit: false, miss: true };
  }
  let raw: number;
  if (effect.source === 'weapon') raw = attacker.stats.weaponMin + rand() * (attacker.stats.weaponMax - attacker.stats.weaponMin);
  else raw = skillPower(attacker.stats, skill.scaling ?? attrForSkill) * (0.9 + rand() * 0.2);
  raw *= effect.mult * (1 + attacker.stats.damagePct / 100) * statusMult(attacker.statuses, target.statuses);
  raw *= 1 - (target.stats.resist[type] ?? 0) / 100;
  const crit = rand() * 100 < attacker.stats.critChance;
  if (crit) raw *= attacker.stats.critMult;
  return { amount: Math.max(1, Math.round(raw)), type, crit, miss: false };
}

/** Expected (average) damage, used by AI and UI previews. */
export function expectedDamage(attacker: ActorForMath, target: ActorForMath, effect: Extract<SkillEffect, { kind: 'damage' }>, skill: SkillTemplate, attr: AttributeId): number {
  const type: DamageType = effect.type === 'weapon' ? attacker.stats.weaponType : effect.type;
  let raw = effect.source === 'weapon' ? (attacker.stats.weaponMin + attacker.stats.weaponMax) / 2 : skillPower(attacker.stats, skill.scaling ?? attr);
  raw *= effect.mult * (1 + attacker.stats.damagePct / 100) * statusMult(attacker.statuses, target.statuses);
  raw *= 1 - (target.stats.resist[type] ?? 0) / 100;
  raw *= 1 + (attacker.stats.critChance / 100) * (attacker.stats.critMult - 1);
  if (effect.source === 'weapon') raw *= 1 - target.stats.evasion / 100;
  return raw;
}

export interface AppliedDamage {
  toPhys: number;
  toMag: number;
  toHp: number;
}

/** Armor absorbs damage of its kind before health. Mutates the target's pools. */
export function applyDamageToPools(target: { physArmor: number; magArmor: number; hp: number }, amount: number, type: DamageType): AppliedDamage {
  const pool = DAMAGE_ARMOR[type];
  const out: AppliedDamage = { toPhys: 0, toMag: 0, toHp: 0 };
  let rest = amount;
  if (pool === 'phys' && target.physArmor > 0) {
    out.toPhys = Math.min(target.physArmor, rest);
    target.physArmor -= out.toPhys;
    rest -= out.toPhys;
  } else if (pool === 'mag' && target.magArmor > 0) {
    out.toMag = Math.min(target.magArmor, rest);
    target.magArmor -= out.toMag;
    rest -= out.toMag;
  }
  out.toHp = Math.min(target.hp, rest);
  target.hp -= out.toHp;
  return out;
}

/** Divinity rule: a harmful status only lands if the blocking armor is gone. */
export function statusCanLand(target: { physArmor: number; magArmor: number; statuses: ActiveStatus[] }, status: StatusId): boolean {
  const def = STATUS_INFO[status];
  if (status === 'burning' && target.statuses.some((s) => s.id === 'wet')) return false;
  if (!def.harmful || !def.blockedBy) return true;
  return def.blockedBy === 'phys' ? target.physArmor <= 0 : target.magArmor <= 0;
}

export function healAmount(stats: DerivedStats, mult: number, attr: AttributeId = 'spirit'): number {
  return Math.round(skillPower(stats, attr) * mult * (1 + stats.healingPct / 100));
}

export function skillRange(skill: SkillTemplate, stats: DerivedStats): number {
  return skill.range === 'weapon' ? stats.weaponRange : skill.range;
}
