/**
 * Ruleset interpretation shared by server, client and simulator: lookups, level curves, stat aggregation
 * for characters and monsters. Pure functions of (ruleset, state).
 */
import type {
  AffixDef, AttributeDef, ClassDef, Curve, DamageTypeDef, DifficultyId, ItemBaseDef, KinDef, Knots, Modifier, MonsterRole, PoolDef, RarityDef,
  Ruleset, SkillDef, SlotDef, StatId, StatusDef, SubtypeDef, SurfaceDef, TrapDef, TreeNode,
} from './types';

// ------------------------------------------------------------------------------------ lookups

export interface RulesetIndex {
  skill: Map<string, SkillDef>;
  status: Map<string, StatusDef>;
  item: Map<string, ItemBaseDef>;
  affix: Map<string, AffixDef>;
  cls: Map<string, ClassDef>;
  kin: Map<string, KinDef>;
  slot: Map<string, SlotDef>;
  type: Map<string, DamageTypeDef>;
  subtype: Map<string, SubtypeDef>;
  pool: Map<string, PoolDef>;
  attr: Map<string, AttributeDef>;
  surface: Map<string, SurfaceDef>;
  rarity: Map<string, RarityDef>;
  trap: Map<string, TrapDef>;
  /** Tree nodes of each class including the shared attribute branch. */
  nodes: Map<string, Map<string, TreeNode>>;
  rarityOrder: Map<string, number>;
}

const cache = new WeakMap<Ruleset, RulesetIndex>();
const byId = <T extends { id: string }>(a: T[]) => new Map(a.map((x) => [x.id, x]));

export function rx(r: Ruleset): RulesetIndex {
  let ix = cache.get(r);
  if (ix) return ix;
  ix = {
    skill: byId(r.skills),
    status: byId(r.statuses),
    item: byId(r.items),
    affix: byId(r.affixes),
    cls: byId(r.classes),
    kin: byId(r.kins),
    slot: byId(r.slots),
    type: byId(r.damageTypes),
    subtype: byId(r.subtypes),
    pool: byId(r.pools),
    attr: byId(r.attributes),
    surface: byId(r.surfaces),
    rarity: byId(r.rarities),
    trap: byId(r.traps),
    nodes: new Map(r.classes.map((c) => [c.id, byId([...c.nodes, ...r.attributeNodes])])),
    rarityOrder: new Map(r.rarities.map((x, i) => [x.id, i])),
  };
  cache.set(r, ix);
  return ix;
}

/** Call after mutating a ruleset in place (the balance loop does). */
export function invalidateRuleset(r: Ruleset) {
  cache.delete(r);
}

// ------------------------------------------------------------------------------------ curves

export function curve(c: Curve, level: number): number {
  const n = Math.max(0, level - 1);
  return c.base * (1 + c.lin * n + c.quad * n * n);
}

export function knot(k: Knots, level: number): number {
  if (!k.length) return 1;
  if (level <= k[0]!.level) return k[0]!.value;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1]!, b = k[i]!;
    if (level <= b.level) return a.value + ((b.value - a.value) * (level - a.level)) / Math.max(1e-9, b.level - a.level);
  }
  return k[k.length - 1]!.value;
}

export const refHp = (r: Ruleset, level: number) => curve(r.curves.hp, level);
export const refDpa = (r: Ruleset, level: number) => curve(r.curves.dmg, level);
export const refMit = (r: Ruleset, level: number) => curve(r.curves.mit, level);

// ------------------------------------------------------------------------------------ stat units

export type StatUnit = 'hp' | 'dmg' | 'mit' | 'pct' | 'flat';

/** How a stat's modifier values are interpreted. 'hp'/'dmg'/'mit' are coefficients of the level curves. */
export function statUnit(stat: StatId): StatUnit {
  if (stat === 'hp' || stat === 'hpRegen') return 'hp';
  if (stat === 'thorns' || stat.startsWith('onhit:')) return 'dmg';
  if (stat.startsWith('mit:') || stat === 'trapSense' || stat === 'lockpick') return 'mit';
  if (stat.startsWith('pool:') || stat === 'move' || stat === 'initiative') return 'flat';
  return 'pct';
}

/** Absolute value of a modifier granted at `level` (an item's level, or the character's for tree/attributes). */
export function modifierAmount(r: Ruleset, m: Modifier, level: number): number {
  switch (statUnit(m.stat)) {
    case 'hp':
      return m.value * refHp(r, level);
    case 'dmg':
      return m.value * refDpa(r, level);
    case 'mit':
      return m.value * refMit(r, level);
    default:
      return m.value;
  }
}

// ------------------------------------------------------------------------------------ derived stats

export interface WeaponStats {
  /** Damage per hit at the weapon's AP cost. */
  min: number;
  max: number;
  apCost: number;
  range: number;
  typeId: string;
  subtypeId?: string;
  projectile: boolean;
  melee: boolean;
}

export interface StatBlock {
  level: number;
  attributes: Record<string, number>;
  maxHp: number;
  hpRegen: number;
  pools: Record<string, { max: number; regen: number }>;
  apPerTurn: number;
  apMax: number;
  apStart: number;
  move: number;
  initiative: number;
  crit: number;
  critMult: number;
  dodge: number;
  /** Damage per AP of non-weapon skills. */
  dpa: number;
  weapon: WeaponStats;
  /** Additive % bonuses keyed by stat (power, dmg:<x>, healing). */
  pct: Record<string, number>;
  mitigation: Record<string, number>;
  resist: Record<string, number>;
  /** Damage taken modifier as a multiplier (exposed > 1, fortified < 1). */
  taken: number;
  /** Monster family subtype (resolves `$family` in skills). */
  familySubtypeId?: string;
  lifesteal: number;
  thorns: number;
  onHit: { typeId: string; subtypeId?: string; amount: number }[];
  trapSense: number;
  lockpick: number;
  barter: number;
  lootFind: number;
  rooted: boolean;
  silenced: boolean;
  disarmed: boolean;
}

export interface ActiveStatusLike {
  id: string;
  turns: number;
  power: number;
}

export interface CharacterLike {
  classId: string;
  kinId: string;
  level: number;
  tree: Record<string, number>;
  equipment: Record<string, ItemLike | undefined>;
  statuses: ActiveStatusLike[];
}

export interface ItemLike {
  baseId: string;
  level: number;
  rarityId: string;
  affixes: { affixId: string; value: number }[];
  upgrade?: number;
  uniqueMods?: Modifier[];
}

class Acc {
  flat = new Map<string, number>();
  add(stat: string, v: number) {
    this.flat.set(stat, (this.flat.get(stat) ?? 0) + v);
  }
  get(stat: string) {
    return this.flat.get(stat) ?? 0;
  }
}

const RES_CAP = 0.75;
const MIT_CAP = 0.85;
const LIFESTEAL_CAP = 25;

/** Upgrade multiplier for an item's base stats (weapon damage, defense). */
export function upgradeMult(r: Ruleset, item: ItemLike): number {
  return 1 + (item.upgrade ?? 0) * r.crafting.upgrades.perLevel;
}

export function rarityBudget(r: Ruleset, rarityId: string): number {
  return rx(r).rarity.get(rarityId)?.budget ?? 1;
}

export function weaponHit(r: Ruleset, item: ItemLike, base: ItemBaseDef): [number, number] {
  const w = base.weapon!;
  const per = w.coef * refDpa(r, item.level) * w.apCost * (1 + (rarityBudget(r, item.rarityId) - 1) * 0.35) * upgradeMult(r, item);
  const v = r.resolution.variance;
  return [per * (1 - v), per * (1 + v)];
}

/** Attribute totals: base + class + kin + attribute-branch ranks + item modifiers (attr:<id>). */
function attributeTotals(r: Ruleset, ch: CharacterLike, acc: Acc): Record<string, number> {
  const ix = rx(r);
  const cls = ix.cls.get(ch.classId);
  const kin = ix.kin.get(ch.kinId);
  const nodes = ix.nodes.get(ch.classId);
  const out: Record<string, number> = {};
  for (const a of r.attributes) {
    let v = r.attributeBase + (cls?.attributes[a.id] ?? 0) + (kin?.attributes[a.id] ?? 0) + acc.get(`attr:${a.id}`);
    for (const [nodeId, rank] of Object.entries(ch.tree)) {
      const n = nodes?.get(nodeId);
      if (n?.kind === 'attribute' && n.attributeId === a.id) v += rank * r.progression.attributePerRank;
    }
    out[a.id] = v;
  }
  return out;
}

function addItemMods(r: Ruleset, item: ItemLike, acc: Acc) {
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  if (!base) return;
  const um = upgradeMult(r, item);
  if (base.defense) for (const [typeId, c] of Object.entries(base.defense)) acc.add(`mit:${typeId}`, c * refMit(r, item.level) * rarityBudget(r, item.rarityId) ** 0.5 * um);
  for (const m of base.implicit ?? []) acc.add(m.stat, modifierAmount(r, m, item.level));
  for (const a of item.affixes) {
    const def = ix.affix.get(a.affixId);
    if (def) acc.add(def.stat, modifierAmount(r, { stat: def.stat, value: a.value }, item.level));
  }
  for (const m of item.uniqueMods ?? []) acc.add(m.stat, modifierAmount(r, m, item.level));
}

function addStatusMods(r: Ruleset, statuses: ActiveStatusLike[], level: number, acc: Acc, flags: { rooted: boolean; silenced: boolean; disarmed: boolean; apLoss: number }) {
  const ix = rx(r);
  for (const s of statuses) {
    const def = ix.status.get(s.id);
    if (!def) continue;
    for (const m of def.modifiers ?? []) acc.add(m.stat, modifierAmount(r, m, level));
    if (def.control === 'root') flags.rooted = true;
    if (def.control === 'silence') flags.silenced = true;
    if (def.control === 'disarm') flags.disarmed = true;
    if (def.control === 'slow') flags.apLoss += def.apLoss ?? 1;
  }
}

function finish(r: Ruleset, level: number, acc: Acc, attributes: Record<string, number>, base: { hp: number; dpa: number; weapon: WeaponStats; resistCap: number }, flags: { rooted: boolean; silenced: boolean; disarmed: boolean; apLoss: number }, opts: { apBonus?: number }): StatBlock {
  const K = refMit(r, level);
  const pct: Record<string, number> = {};
  for (const [k, v] of acc.flat) if (k === 'power' || k.startsWith('dmg:') || k === 'healing') pct[k] = v;
  const mitigation: Record<string, number> = {};
  for (const t of r.damageTypes) {
    const R = Math.max(0, acc.get(`mit:${t.id}`));
    mitigation[t.id] = Math.min(MIT_CAP, R / (R + K));
  }
  const resist: Record<string, number> = {};
  for (const s of r.subtypes) resist[s.id] = Math.max(-0.5, Math.min(base.resistCap, acc.get(`res:${s.id}`) / 100 + acc.get('res:all') / 100));
  const pools: StatBlock['pools'] = {};
  for (const p of r.pools) pools[p.id] = { max: Math.round(p.base + p.perLevel * (level - 1) + acc.get(`pool:${p.id}`)), regen: p.regenPerTurn + acc.get(`poolRegen:${p.id}`) / 100 };
  const onHit: StatBlock['onHit'] = [];
  for (const [k, v] of acc.flat) {
    if (!k.startsWith('onhit:') || v <= 0) continue;
    const id = k.slice(6);
    const sub = rx(r).subtype.get(id);
    onHit.push(sub ? { typeId: sub.typeId, subtypeId: sub.id, amount: v } : { typeId: id, amount: v });
  }
  const t = r.turn;
  return {
    level,
    attributes,
    maxHp: Math.max(1, Math.round(base.hp * (1 + acc.get('hpPct') / 100) + acc.get('hp'))),
    hpRegen: acc.get('hpRegen'),
    pools,
    apPerTurn: Math.max(1, t.apPerTurn + (opts.apBonus ?? 0) - flags.apLoss),
    apMax: t.apMax + (opts.apBonus ?? 0),
    apStart: t.apStart + (opts.apBonus ?? 0),
    move: flags.rooted ? 0 : Math.max(0.5, t.tilesPerAp + acc.get('move')),
    initiative: 10 + acc.get('initiative'),
    crit: r.resolution.crit ? Math.min(r.resolution.critCap, (r.resolution.baseCrit + acc.get('crit')) / 100) : 0,
    critMult: r.resolution.critMult + acc.get('critDmg') / 100,
    dodge: r.resolution.dodge ? Math.min(r.resolution.dodgeCap, Math.max(0, (r.resolution.baseDodge + acc.get('dodge')) / 100)) : 0,
    dpa: base.dpa,
    weapon: base.weapon,
    pct,
    mitigation,
    resist,
    taken: Math.max(0.3, 1 + acc.get('taken') / 100),
    lifesteal: Math.min(LIFESTEAL_CAP, acc.get('lifesteal')) / 100,
    thorns: acc.get('thorns'),
    onHit,
    trapSense: acc.get('trapSense'),
    lockpick: acc.get('lockpick'),
    barter: Math.min(40, acc.get('barter')),
    lootFind: acc.get('lootFind'),
    rooted: flags.rooted,
    silenced: flags.silenced,
    disarmed: flags.disarmed,
  };
}

export interface CharacterStatOptions {
  /** Party of one gets the ruleset's solo bonus. */
  solo?: boolean;
}

export function characterStats(r: Ruleset, ch: CharacterLike, opts: CharacterStatOptions = {}): StatBlock {
  const ix = rx(r);
  const acc = new Acc();
  const cls = ix.cls.get(ch.classId);
  const kin = ix.kin.get(ch.kinId);
  const items = Object.values(ch.equipment).filter((x): x is ItemLike => !!x);
  for (const it of items) addItemMods(r, it, acc);
  for (const m of kin?.modifiers ?? []) acc.add(m.stat, modifierAmount(r, m, ch.level));
  const nodes = ix.nodes.get(ch.classId);
  for (const [nodeId, rank] of Object.entries(ch.tree)) {
    const n = nodes?.get(nodeId);
    if (!n || rank <= 0 || !n.modifiers) continue;
    for (const m of n.modifiers) acc.add(m.stat, modifierAmount(r, m, ch.level) * rank * (n.tune ?? 1));
  }
  const attributes = attributeTotals(r, ch, acc);
  for (const a of r.attributes) {
    const pts = attributes[a.id]! - r.attributeBase;
    if (pts) for (const m of a.perPoint) acc.add(m.stat, modifierAmount(r, m, ch.level) * pts);
  }
  const flags = { rooted: false, silenced: false, disarmed: false, apLoss: 0 };
  addStatusMods(r, ch.statuses, ch.level, acc, flags);
  const solo = opts.solo ? r.party.soloBonus : { hp: 1, dmg: 1, ap: 0 };
  const tune = cls?.tune ?? { hp: 1, dmg: 1 };
  // Weapon
  const wSlot = r.slots.find((s) => s.kind === 'weapon');
  const wItem = wSlot ? ch.equipment[wSlot.id] : undefined;
  const wBase = wItem ? ix.item.get(wItem.baseId) : undefined;
  let weapon: WeaponStats;
  if (wItem && wBase?.weapon) {
    const [mn, mx] = weaponHit(r, wItem, wBase);
    const m = tune.dmg * solo.dmg;
    weapon = { min: mn * m, max: mx * m, apCost: wBase.weapon.apCost, range: wBase.weapon.range, typeId: wBase.weapon.typeId, subtypeId: wBase.weapon.subtypeId, projectile: !!wBase.weapon.projectile, melee: wBase.weapon.range <= 2 };
  } else {
    const per = refDpa(r, ch.level) * 0.6 * 2 * tune.dmg * solo.dmg;
    weapon = { min: per * (1 - r.resolution.variance), max: per * (1 + r.resolution.variance), apCost: 2, range: 1.6, typeId: r.damageTypes[0]!.id, projectile: false, melee: true };
  }
  return finish(r, ch.level, acc, attributes, { hp: refHp(r, ch.level) * tune.hp * solo.hp, dpa: refDpa(r, ch.level) * tune.dmg * solo.dmg, weapon, resistCap: RES_CAP }, flags, { apBonus: solo.ap });
}

export interface MonsterStatInput {
  level: number;
  role: MonsterRole;
  boss?: boolean;
  elite?: boolean;
  /** Family damage subtype (monsters deal and resist it). */
  subtypeId?: string;
  statuses: ActiveStatusLike[];
  difficulty?: DifficultyId;
  /** NPCs fight like monsters but without the fitted monster multipliers' boss/elite tiers. */
  npc?: boolean;
  /** Threat multiplier (pack fitted to a smaller party); split evenly between health and damage. */
  scale?: number;
}

export function monsterStats(r: Ruleset, m: MonsterStatInput): StatBlock {
  const def = r.monsters[m.role];
  const acc = new Acc();
  const tier = m.boss ? r.boss : m.elite ? r.elite : { hp: 1, dmg: 1 };
  const diff = r.difficulty[m.difficulty ?? 'normal'] ?? r.difficulty.normal;
  const fitted = Math.sqrt(Math.max(0.25, Math.min(1.5, m.scale ?? 1)));
  const hpMult = def.hp * knot(r.curves.monsterHp, m.level) * tier.hp * knot(diff.enemyHp, m.level) * fitted;
  const dmgMult = def.dmg * knot(r.curves.monsterDmg, m.level) * tier.dmg * knot(diff.enemyDmg, m.level) * fitted;
  for (const [typeId, c] of Object.entries(def.defense)) acc.add(`mit:${typeId}`, c * refMit(r, m.level) * (m.boss ? 1.3 : 1));
  const sub = m.subtypeId ? rx(r).subtype.get(m.subtypeId) : undefined;
  if (sub) acc.add(`res:${sub.id}`, 40);
  const flags = { rooted: false, silenced: false, disarmed: false, apLoss: 0 };
  addStatusMods(r, m.statuses, m.level, acc, flags);
  const dpa = refDpa(r, m.level) * dmgMult;
  const ranged = def.range > 2;
  const casterLike = m.role === 'caster' || m.role === 'healer';
  const typeId = casterLike && sub ? sub.typeId : r.damageTypes[0]!.id;
  const v = r.resolution.variance;
  const weapon: WeaponStats = { min: dpa * 2 * (1 - v), max: dpa * 2 * (1 + v), apCost: 2, range: def.range, typeId, subtypeId: casterLike ? sub?.id : undefined, projectile: ranged, melee: !ranged };
  const block = finish(r, m.level, acc, Object.fromEntries(r.attributes.map((a) => [a.id, r.attributeBase])), { hp: refHp(r, m.level) * hpMult, dpa, weapon, resistCap: 0.9 }, flags, { apBonus: m.boss ? 1 : 0 });
  block.move = flags.rooted ? 0 : r.turn.tilesPerAp * def.move;
  block.familySubtypeId = sub?.id;
  block.initiative = 10 + def.initiative + Math.floor(m.level / 2);
  return block;
}

// ------------------------------------------------------------------------------------ skills & trees

export function skillRank(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>, skillId: string): number {
  const nodes = rx(r).nodes.get(ch.classId);
  let rank = 0;
  const cls = rx(r).cls.get(ch.classId);
  if (cls?.startingSkills.includes(skillId)) rank = 1;
  for (const [nodeId, n] of Object.entries(ch.tree)) {
    const node = nodes?.get(nodeId);
    if (!node || n <= 0) continue;
    if (node.kind === 'skill' && node.skillId === skillId) rank = Math.max(rank, 1);
    if (node.kind === 'rank' && node.skillId === skillId) rank += n;
  }
  const max = rx(r).skill.get(skillId)?.maxRank ?? 1;
  return Math.min(max, rank);
}

/** Skills a character can use (basic attack first). */
export function knownSkills(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>): string[] {
  const ix = rx(r);
  const out = new Set<string>([r.basicAttackId, ...(ix.cls.get(ch.classId)?.startingSkills ?? [])]);
  const nodes = ix.nodes.get(ch.classId);
  for (const [nodeId, n] of Object.entries(ch.tree)) {
    const node = nodes?.get(nodeId);
    if (node?.kind === 'skill' && node.skillId && n > 0) out.add(node.skillId);
  }
  return [...out].filter((id) => ix.skill.has(id));
}

export function branchSpent(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>, branchId: string): number {
  const nodes = rx(r).nodes.get(ch.classId);
  let s = 0;
  for (const [nodeId, n] of Object.entries(ch.tree)) if (nodes?.get(nodeId)?.branch === branchId) s += n;
  return s;
}

/** Why a node can't take another point, or null if it can. */
export function canAllocate(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'> & { treePoints: number }, nodeId: string): string | null {
  const node = rx(r).nodes.get(ch.classId)?.get(nodeId);
  if (!node) return 'Unknown node.';
  if (ch.treePoints <= 0) return 'No points to spend.';
  const rank = ch.tree[nodeId] ?? 0;
  if (rank >= node.maxRank) return 'Already at maximum rank.';
  const req = r.progression.tierRequirements[node.tier] ?? 0;
  if (node.kind !== 'attribute' && branchSpent(r, ch, node.branch) < req) return `Spend ${req} points in this branch first.`;
  if (node.kind === 'rank' && node.skillId && skillRank(r, ch, node.skillId) < 1) return 'Learn the skill first.';
  return null;
}

export function xpForLevel(r: Ruleset, level: number): number {
  return r.progression.xp[Math.min(level, r.progression.xp.length - 1)] ?? Infinity;
}

export function levelForXp(r: Ruleset, xp: number): number {
  let l = 1;
  while (l < r.progression.maxLevel && xp >= xpForLevel(r, l + 1)) l++;
  return l;
}

export function treePointsAt(r: Ruleset, level: number): number {
  return r.progression.treePointsStart + r.progression.treePointsPerLevel * (level - 1);
}
