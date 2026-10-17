/** Turns mechanical ids into world-flavored display text. Shared by server prompts and client UI. */
import type { Terminology } from './core';
import { AFFIX, ITEM_BASE, RARITY_ORDER, armorValue, itemPrice, weaponDamage, type ItemInstance } from './items';
import { getSkill } from './skills';

export interface NamingContext {
  terminology: Terminology;
  itemNames: Record<string, { names: string[]; description: string }>;
  affixNames: Record<string, { prefix: string; suffix: string }>;
  uniqueItems: Record<string, { name: string; description: string }>;
  skills: Record<string, { name: string; description: string }>;
  maxLevel: number;
}

export function fillTerms(text: string, t: Terminology): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const attr = (t.attributes as Record<string, string>)[k];
    if (attr) return attr;
    const dmg = (t.damageTypes as Record<string, string>)[k];
    if (dmg) return dmg;
    const v = (t as unknown as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : m;
  });
}

export function baseItemName(ctx: NamingContext, baseId: string, level: number, variant?: number): string {
  const entry = ctx.itemNames[baseId];
  const base = ITEM_BASE[baseId];
  if (!entry || !entry.names.length) return base?.defaultName ?? baseId;
  if (variant !== undefined) return entry.names[variant % entry.names.length]!;
  const tier = Math.min(entry.names.length - 1, Math.floor(((level - 1) / Math.max(1, ctx.maxLevel)) * entry.names.length));
  return entry.names[Math.max(0, tier)]!;
}

export function skillName(ctx: Pick<NamingContext, 'skills'>, skillId: string): string {
  return ctx.skills[skillId]?.name ?? getSkill(skillId)?.defaultName ?? skillId;
}

export function itemName(ctx: NamingContext, item: ItemInstance): string {
  if (item.uniqueId && ctx.uniqueItems[item.uniqueId]) return ctx.uniqueItems[item.uniqueId]!.name;
  const base = baseItemName(ctx, item.baseId, item.level, item.nameVariant);
  if (item.baseId === 'c_skillbook' && item.skillId) return `${base}: ${skillName(ctx, item.skillId)}`;
  if (!item.affixes.length) return base;
  const first = item.affixes[0]!;
  const prefix = ctx.affixNames[first.stat]?.prefix ?? AFFIX[first.stat]?.defaultPrefix ?? '';
  if (item.affixes.length === 1 || RARITY_ORDER[item.rarity] < 2) return `${prefix} ${base}`.trim();
  const second = item.affixes[1]!;
  const suffix = ctx.affixNames[second.stat]?.suffix ?? AFFIX[second.stat]?.defaultSuffix ?? '';
  return `${prefix} ${base} ${suffix}`.trim();
}

export function itemDescription(ctx: NamingContext, item: ItemInstance): string {
  if (item.uniqueId && ctx.uniqueItems[item.uniqueId]) return ctx.uniqueItems[item.uniqueId]!.description;
  return ctx.itemNames[item.baseId]?.description ?? '';
}

/** Mechanical lines for tooltips. */
export function itemStatLines(ctx: NamingContext, item: ItemInstance): string[] {
  const base = ITEM_BASE[item.baseId];
  if (!base) return [];
  const t = ctx.terminology;
  const lines: string[] = [];
  if (base.weapon) {
    const [mn, mx] = weaponDamage(item.level, base, item.rarity);
    const type = base.weapon.damageType === 'element' ? item.element ?? 'fire' : base.weapon.damageType;
    lines.push(`${mn}-${mx} ${t.damageTypes[type]} damage`);
    lines.push(base.weapon.range > 2 ? `Range ${base.weapon.range}` : 'Melee');
    lines.push(`Scales with ${t.attributes[base.weapon.scaling]}`);
    if (base.twoHanded) lines.push('Two-handed');
  }
  if (base.armor) {
    const a = armorValue(item.level, base, item.rarity);
    if (a.phys) lines.push(`+${a.phys} ${t.physArmor}`);
    if (a.mag) lines.push(`+${a.mag} ${t.magArmor}`);
  }
  for (const a of item.affixes) {
    const def = AFFIX[a.stat];
    if (def) lines.push(fillTerms(def.label(a.value), t));
  }
  const c = base.consumable;
  if (c) {
    if (c.kind === 'heal') lines.push(`Restores ${t.health}`);
    if (c.kind === 'restore') lines.push(`Restores ${Math.round(c.fraction * 100)}% ${c.pool === 'stamina' ? t.stamina : t.focus}`);
    if (c.kind === 'cleanse') lines.push('Removes harmful effects');
    if (c.kind === 'bomb') lines.push(`Throw: ${t.damageTypes[c.damage]} damage in an area`);
    if (c.kind === 'recall') lines.push(`Return to the last ${t.town} visited`);
    if (c.kind === 'buff') lines.push(`Grants ${t.statuses[c.status]} for ${c.turns} turns`);
    if (c.kind === 'disarm') lines.push('Disarms a detected trap');
    if (c.kind === 'unlock') lines.push('Opens a lock');
    if (c.kind === 'skillbook' && item.skillId) lines.push(`Teaches ${skillName(ctx, item.skillId)}`);
    if (base.combatUse) lines.push(`${base.combatUse} AP in combat`);
  }
  return lines;
}

export function itemValue(item: ItemInstance): number {
  return itemPrice(item) * item.qty;
}
