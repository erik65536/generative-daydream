/** Human-readable text for ruleset data: stat labels, skill summaries, item names and tooltips, the codex. */
import type { Effect, ItemBaseDef, Modifier, Ruleset, SkillDef, StatId, TreeNode } from './types';
import { modifierAmount, refDpa, rx, statUnit, weaponHit, type ItemLike, type StatBlock } from './stats';
import { healAmount, isBasic, potency } from './math';

export function statName(r: Ruleset, stat: StatId): string {
  const ix = rx(r);
  const [head, arg] = stat.includes(':') ? [stat.slice(0, stat.indexOf(':')), stat.slice(stat.indexOf(':') + 1)] : [stat, ''];
  const typeOrSub = (id: string) => ix.subtype.get(id)?.name ?? ix.type.get(id)?.name ?? id;
  switch (head) {
    case 'hp': return r.health.name;
    case 'hpPct': return `${r.health.name}`;
    case 'hpRegen': return `${r.health.name} per turn`;
    case 'pool': return ix.pool.get(arg)?.name ?? arg;
    case 'poolRegen': return `${ix.pool.get(arg)?.name ?? arg} regeneration`;
    case 'move': return 'Movement';
    case 'initiative': return 'Initiative';
    case 'crit': return 'Critical chance';
    case 'critDmg': return 'Critical damage';
    case 'dodge': return 'Dodge';
    case 'power': return 'Damage';
    case 'dmg': return arg === 'melee' ? 'Melee damage' : arg === 'ranged' ? 'Ranged damage' : arg === 'spell' ? 'Skill damage' : `${typeOrSub(arg)} damage`;
    case 'healing': return 'Healing';
    case 'mit': return ix.type.get(arg)?.mitigationName ?? arg;
    case 'res': return arg === 'all' ? 'All resistances' : `${typeOrSub(arg)} resistance`;
    case 'lifesteal': return 'Life steal';
    case 'thorns': return 'Reflect damage';
    case 'onhit': return `${typeOrSub(arg)} damage on hit`;
    case 'trapSense': return 'Trap sense';
    case 'lockpick': return 'Lockpicking';
    case 'barter': return 'Better prices';
    case 'lootFind': return 'Loot find';
    case 'taken': return 'Damage taken';
    case 'attr': return ix.attr.get(arg)?.name ?? arg;
    default: return stat;
  }
}

const pctStat = (stat: string) => statUnit(stat) === 'pct';

/** "+12% Fire damage", "+34 Health" at a level. */
export function modifierLabel(r: Ruleset, m: Modifier, level: number): string {
  const v = modifierAmount(r, m, level);
  const name = statName(r, m.stat);
  if (m.stat === 'hpPct') return `${v >= 0 ? '+' : ''}${Math.round(v)}% ${name}`;
  if (pctStat(m.stat)) return `${v >= 0 ? '+' : ''}${Math.abs(v) >= 0.1 || v === 0 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}% ${name}`;
  if (m.stat === 'move') return `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10} ${name}`;
  return `${v >= 0 ? '+' : ''}${fine(v)} ${name}`;
}

/** Whole numbers, but small amounts (a fraction per attribute point) keep enough digits not to read as 0. */
const fine = (v: number) => (Math.abs(v) >= 1 || v === 0 ? Math.round(v) : Math.abs(v) >= 0.1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

function effectLine(r: Ruleset, e: Effect, skill: SkillDef, rank: number, stats?: StatBlock): string | null {
  const ix = rx(r);
  const p = potency(skill, rank);
  switch (e.kind) {
    case 'damage': {
      const sub = e.subtypeId ? ix.subtype.get(e.subtypeId) : undefined;
      const kind = sub?.name ?? (e.typeId ? ix.type.get(e.typeId)?.name : undefined);
      if (isBasic(skill)) return 'Weapon damage';
      if (e.weapon) return `${Math.round(e.coef * p * 100 / Math.max(1, skill.ap))}% weapon damage per AP${kind ? ` as ${kind}` : ''}`;
      const amt = stats ? Math.round(e.coef * stats.dpa * p) : undefined;
      return `${amt !== undefined ? `${amt} ` : ''}${kind ?? 'damage'} damage`;
    }
    case 'heal':
      return `Heals ${stats ? healAmount(stats, e.coef, p) : ''} ${r.health.name}`.replace('  ', ' ');
    case 'barrier':
      return `Shields for ${stats ? healAmount(stats, e.coef, p) : 'some'} damage (${e.turns} turns)`;
    case 'status': {
      const s = ix.status.get(e.statusId);
      if (!s) return null;
      return `${e.chance < 1 ? `${Math.round(e.chance * 100)}% chance: ` : ''}${e.self ? 'you gain' : 'applies'} ${s.name} (${e.turns} turns)`;
    }
    case 'surface':
      return `Leaves ${ix.surface.get(e.surfaceId)?.name ?? 'a surface'}`;
    case 'restore':
      return `Restores ${e.amount} ${ix.pool.get(e.poolId)?.name ?? e.poolId}`;
    case 'cleanse':
      return 'Removes harmful effects';
    case 'revive':
      return `Revives a downed ally with ${Math.round(e.fraction * 100)}% ${r.health.name}`;
    case 'lifesteal':
      return `Heals you for ${Math.round(e.fraction * 100)}% of damage dealt`;
    case 'chain':
      return `Jumps to ${e.jumps} more enemies`;
    case 'teleport':
      return 'Teleports you to the target spot';
    case 'dash':
      return 'Rushes to the target';
    case 'push':
      return `Pushes the target ${e.distance} tiles`;
  }
}

/** Mechanical summary lines of a skill at a rank (with numbers if stats are given). */
export function skillLines(r: Ruleset, skill: SkillDef, rank: number, stats?: StatBlock): string[] {
  const lines: string[] = [];
  for (const e of skill.effects) {
    const l = effectLine(r, e, skill, rank, stats);
    if (l) lines.push(l);
  }
  if (skill.radius) lines.push(`Area: ${skill.radius} tiles`);
  return lines;
}

export function skillCostLine(r: Ruleset, skill: SkillDef, stats?: StatBlock): string {
  const parts: string[] = [];
  parts.push(`${isBasic(skill) && stats ? stats.weapon.apCost : skill.ap} ${r.terminology.actionPoints}`);
  if (skill.cost) parts.push(`${skill.cost.amount} ${rx(r).pool.get(skill.cost.poolId)?.name ?? ''}`);
  if (skill.cooldown) parts.push(`cooldown ${skill.cooldown}`);
  const range = skill.weaponRange || isBasic(skill) ? (stats ? stats.weapon.range : undefined) : skill.range;
  if (skill.targeting !== 'self' && range !== undefined) parts.push(range <= 2 ? 'melee' : `range ${Math.round(range)}`);
  return parts.join(' · ');
}

export function nodeLines(r: Ruleset, node: TreeNode, level: number): string[] {
  const ix = rx(r);
  if (node.kind === 'skill' && node.skillId) return [`Learn ${ix.skill.get(node.skillId)?.name ?? node.skillId}`];
  if (node.kind === 'rank' && node.skillId) {
    const s = ix.skill.get(node.skillId);
    return [`+${Math.round((s?.rankBonus ?? 0.15) * 100)}% ${s?.name ?? node.skillId} potency per rank`];
  }
  if (node.kind === 'attribute' && node.attributeId) {
    const a = ix.attr.get(node.attributeId);
    const k = r.progression.attributePerRank;
    return [`+${k} ${a?.name ?? node.attributeId} per rank`, ...(a?.perPoint ?? []).map((m) => modifierLabel(r, { stat: m.stat, value: m.value * k }, level))];
  }
  return (node.modifiers ?? []).map((m) => modifierLabel(r, { stat: m.stat, value: m.value * (node.tune ?? 1) }, level));
}

/** What one attribute point gives; amounts too small to show per point read "+1 X per 4 points". */
export function perPointLabel(r: Ruleset, m: Modifier, level: number): string {
  const v = modifierAmount(r, m, level);
  if (pctStat(m.stat) || m.stat === 'hpPct' || m.stat === 'move' || v === 0 || Math.abs(v) >= 1) return modifierLabel(r, m, level);
  const n = Math.ceil(1 / Math.abs(v) - 1e-9);
  return `${v > 0 ? '+' : '-'}1 ${statName(r, m.stat)} per ${n} points`;
}

// ------------------------------------------------------------------------------------ items

export interface ItemNaming {
  uniqueItems: Record<string, { name: string; description: string }>;
}

export function itemDisplayName(r: Ruleset, item: ItemLike & { uniqueId?: string; qty?: number }, naming?: ItemNaming): string {
  if (item.uniqueId && naming?.uniqueItems[item.uniqueId]) return naming.uniqueItems[item.uniqueId]!.name;
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  let name = base?.name ?? item.baseId;
  const order = ix.rarityOrder.get(item.rarityId) ?? 0;
  const a1 = item.affixes[0] ? ix.affix.get(item.affixes[0].affixId) : undefined;
  const a2 = item.affixes[1] ? ix.affix.get(item.affixes[1].affixId) : undefined;
  // Skip a prefix or suffix that repeats a word of the name ("Grounding Grounding Clamp").
  const echoes = (word: string) => {
    const stem = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
    const have = new Set(name.split(/\s+/).map(stem));
    return word.split(/\s+/).some((w) => w.length > 3 && have.has(stem(w)));
  };
  if (a1 && !echoes(a1.prefix)) name = `${a1.prefix} ${name}`;
  if (a2 && order >= 2 && !echoes(a2.suffix)) name = `${name} ${a2.suffix}`;
  if (item.upgrade) name = `${name} +${item.upgrade}`;
  return name.trim();
}

export function itemLines(r: Ruleset, item: ItemLike, base: ItemBaseDef | undefined = rx(r).item.get(item.baseId)): string[] {
  if (!base) return [];
  const ix = rx(r);
  const lines: string[] = [];
  if (base.weapon) {
    const [mn, mx] = weaponHit(r, item, base);
    const kind = (base.weapon.subtypeId ? ix.subtype.get(base.weapon.subtypeId)?.name : undefined) ?? ix.type.get(base.weapon.typeId)?.name ?? '';
    lines.push(`${Math.round(mn)}–${Math.round(mx)} ${kind} damage · ${base.weapon.apCost} ${r.terminology.actionPoints}`);
    lines.push(base.weapon.range > 2 ? `Range ${base.weapon.range}` : 'Melee');
    if (base.weapon.twoHanded) lines.push('Two-handed');
  }
  if (base.defense) {
    for (const [typeId, c] of Object.entries(base.defense)) if (c > 0) lines.push(modifierLabel(r, { stat: `mit:${typeId}`, value: c * Math.sqrt(ix.rarity.get(item.rarityId)?.budget ?? 1) * (1 + (item.upgrade ?? 0) * r.crafting.upgrades.perLevel) }, item.level));
  }
  // One line per stat: a base bonus and an affix on the same stat read as their total.
  const mods: Modifier[] = [];
  const add = (m: Modifier) => {
    const same = mods.find((x) => x.stat === m.stat);
    if (same) same.value += m.value;
    else mods.push({ ...m });
  };
  for (const m of base.implicit ?? []) add(m);
  for (const a of item.affixes) {
    const def = ix.affix.get(a.affixId);
    if (def) add({ stat: def.stat, value: a.value });
  }
  for (const m of item.uniqueMods ?? []) add(m);
  for (const m of mods) lines.push(modifierLabel(r, m, item.level));
  if (base.use) {
    const fake: SkillDef = { id: '', name: '', description: '', owner: '', targeting: base.use.targeting, range: 8, ap: base.use.ap, cooldown: 0, effects: base.use.effects, rankBonus: 0, maxRank: 1, tags: [], fx: 'none', tune: 1 };
    const pseudo = { dpa: refDpa(r, item.level), pct: {} } as unknown as StatBlock;
    for (const e of base.use.effects) {
      const l = effectLine(r, e, fake, 1, pseudo);
      if (l) lines.push(l);
    }
    if (base.use.tool === 'disarm') lines.push('Disarms a spotted trap');
    if (base.use.tool === 'unlock') lines.push('Opens a lock');
    if (base.use.tool === 'recall') lines.push(`Returns you to the last ${r.terminology.town} visited`);
    if (base.use.ap && !base.use.tool) lines.push(`${base.use.ap} ${r.terminology.actionPoints} in combat`);
  }
  return lines;
}

export function itemPrice(r: Ruleset, item: ItemLike & { qty?: number }): number {
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  if (!base || base.price <= 0) return 0;
  const rar = ix.rarity.get(item.rarityId);
  const lvl = base.category === 'equipment' ? 1 + (item.level - 1) * 0.3 : 1 + (item.level - 1) * 0.12;
  let p = base.price * lvl * (rar?.priceMult ?? 1) * r.economy.priceMult;
  p *= 1 + item.affixes.length * 0.25 + (item.upgrade ?? 0) * 0.2;
  return Math.max(1, Math.round(p));
}
