/**
 * Pre-set item bases and affixes. Worlds name them; costs and stats are fixed by these tables.
 */
import { RARITY_INFO, type AttributeId, type DamageType, type Rarity } from './core';
import { powerAtLevel } from './progression';

export type EquipSlot = 'mainhand' | 'offhand' | 'head' | 'chest' | 'hands' | 'feet' | 'ring' | 'amulet';
export const EQUIP_SLOTS: EquipSlot[] = ['mainhand', 'offhand', 'head', 'chest', 'hands', 'feet', 'ring', 'amulet'];

export type ItemCategory = 'weapon' | 'shield' | 'armor' | 'trinket' | 'consumable' | 'material' | 'valuable' | 'quest' | 'key' | 'tool';

export type ConsumableEffect =
  | { kind: 'heal'; mult: number }
  | { kind: 'restore'; pool: 'stamina' | 'focus'; fraction: number }
  | { kind: 'cleanse' }
  | { kind: 'bomb'; damage: DamageType; mult: number; radius: number }
  | { kind: 'recall' }
  | { kind: 'buff'; status: 'empowered' | 'fortified' | 'hasted' | 'regenerating'; turns: number }
  | { kind: 'disarm' }
  | { kind: 'unlock' }
  | { kind: 'skillbook' };

export interface ItemBase {
  id: string;
  category: ItemCategory;
  defaultName: string;
  slot?: EquipSlot;
  twoHanded?: boolean;
  /** Weapon properties. */
  weapon?: { range: number; damageMult: number; scaling: AttributeId; damageType: DamageType | 'element'; apCost: number };
  /** Armor values relative to the level's armor budget. */
  armor?: { phys: number; mag: number };
  consumable?: ConsumableEffect;
  basePrice: number;
  stackable?: boolean;
  /** Usable in combat (costs AP). */
  combatUse?: number;
  icon: string;
  /** Item drops are weighted by this. 0 = never drops randomly. */
  dropWeight: number;
  /** Crafting system only. */
  requiresCrafting?: boolean;
  requiresSystem?: 'traps' | 'lockpicking' | 'crafting';
}

const B = (b: ItemBase) => b;

export const ITEM_BASES: ItemBase[] = [
  // Weapons
  B({ id: 'w_blade', category: 'weapon', defaultName: 'Sword', slot: 'mainhand', weapon: { range: 1.6, damageMult: 1.0, scaling: 'might', damageType: 'physical', apCost: 2 }, basePrice: 40, icon: 'sword', dropWeight: 10 }),
  B({ id: 'w_heavy', category: 'weapon', defaultName: 'Greataxe', slot: 'mainhand', twoHanded: true, weapon: { range: 1.6, damageMult: 1.45, scaling: 'might', damageType: 'physical', apCost: 2 }, basePrice: 55, icon: 'axe', dropWeight: 7 }),
  B({ id: 'w_dagger', category: 'weapon', defaultName: 'Dagger', slot: 'mainhand', weapon: { range: 1.6, damageMult: 0.85, scaling: 'finesse', damageType: 'physical', apCost: 2 }, basePrice: 35, icon: 'dagger', dropWeight: 8 }),
  B({ id: 'w_bow', category: 'weapon', defaultName: 'Bow', slot: 'mainhand', twoHanded: true, weapon: { range: 12, damageMult: 1.1, scaling: 'finesse', damageType: 'physical', apCost: 2 }, basePrice: 50, icon: 'bow', dropWeight: 8 }),
  B({ id: 'w_staff', category: 'weapon', defaultName: 'Staff', slot: 'mainhand', twoHanded: true, weapon: { range: 9, damageMult: 1.05, scaling: 'intellect', damageType: 'element', apCost: 2 }, basePrice: 50, icon: 'staff', dropWeight: 7 }),
  B({ id: 'w_wand', category: 'weapon', defaultName: 'Wand', slot: 'mainhand', weapon: { range: 8, damageMult: 0.8, scaling: 'intellect', damageType: 'element', apCost: 2 }, basePrice: 40, icon: 'wand', dropWeight: 6 }),
  B({ id: 's_shield', category: 'shield', defaultName: 'Shield', slot: 'offhand', armor: { phys: 0.55, mag: 0.25 }, basePrice: 35, icon: 'shield', dropWeight: 6 }),
  B({ id: 's_focus', category: 'shield', defaultName: 'Tome', slot: 'offhand', armor: { phys: 0.1, mag: 0.45 }, basePrice: 35, icon: 'book', dropWeight: 4 }),
  // Armor (heavy / light variants)
  B({ id: 'a_head_heavy', category: 'armor', defaultName: 'Helm', slot: 'head', armor: { phys: 0.45, mag: 0.1 }, basePrice: 28, icon: 'helm', dropWeight: 5 }),
  B({ id: 'a_head_light', category: 'armor', defaultName: 'Hood', slot: 'head', armor: { phys: 0.12, mag: 0.4 }, basePrice: 28, icon: 'hood', dropWeight: 5 }),
  B({ id: 'a_chest_heavy', category: 'armor', defaultName: 'Breastplate', slot: 'chest', armor: { phys: 1.0, mag: 0.25 }, basePrice: 48, icon: 'chest', dropWeight: 5 }),
  B({ id: 'a_chest_light', category: 'armor', defaultName: 'Robe', slot: 'chest', armor: { phys: 0.3, mag: 0.9 }, basePrice: 48, icon: 'robe', dropWeight: 5 }),
  B({ id: 'a_hands_heavy', category: 'armor', defaultName: 'Gauntlets', slot: 'hands', armor: { phys: 0.3, mag: 0.08 }, basePrice: 20, icon: 'gloves', dropWeight: 4 }),
  B({ id: 'a_hands_light', category: 'armor', defaultName: 'Gloves', slot: 'hands', armor: { phys: 0.1, mag: 0.28 }, basePrice: 20, icon: 'gloves', dropWeight: 4 }),
  B({ id: 'a_feet_heavy', category: 'armor', defaultName: 'Greaves', slot: 'feet', armor: { phys: 0.32, mag: 0.08 }, basePrice: 22, icon: 'boots', dropWeight: 4 }),
  B({ id: 'a_feet_light', category: 'armor', defaultName: 'Boots', slot: 'feet', armor: { phys: 0.12, mag: 0.28 }, basePrice: 22, icon: 'boots', dropWeight: 4 }),
  // Trinkets (stats only through affixes)
  B({ id: 't_ring', category: 'trinket', defaultName: 'Ring', slot: 'ring', basePrice: 45, icon: 'ring', dropWeight: 3 }),
  B({ id: 't_amulet', category: 'trinket', defaultName: 'Amulet', slot: 'amulet', basePrice: 55, icon: 'amulet', dropWeight: 3 }),
  // Consumables
  B({ id: 'c_heal', category: 'consumable', defaultName: 'Healing Potion', consumable: { kind: 'heal', mult: 2.4 }, basePrice: 15, stackable: true, combatUse: 1, icon: 'potion_red', dropWeight: 14 }),
  B({ id: 'c_stamina', category: 'consumable', defaultName: 'Stamina Tonic', consumable: { kind: 'restore', pool: 'stamina', fraction: 0.6 }, basePrice: 12, stackable: true, combatUse: 1, icon: 'potion_green', dropWeight: 7 }),
  B({ id: 'c_focus', category: 'consumable', defaultName: 'Focus Draught', consumable: { kind: 'restore', pool: 'focus', fraction: 0.6 }, basePrice: 12, stackable: true, combatUse: 1, icon: 'potion_blue', dropWeight: 7 }),
  B({ id: 'c_antidote', category: 'consumable', defaultName: 'Antidote', consumable: { kind: 'cleanse' }, basePrice: 10, stackable: true, combatUse: 1, icon: 'potion_white', dropWeight: 5 }),
  B({ id: 'c_bomb_fire', category: 'consumable', defaultName: 'Fire Bomb', consumable: { kind: 'bomb', damage: 'fire', mult: 1.2, radius: 2 }, basePrice: 18, stackable: true, combatUse: 1, icon: 'bomb', dropWeight: 5 }),
  B({ id: 'c_bomb_frost', category: 'consumable', defaultName: 'Frost Bomb', consumable: { kind: 'bomb', damage: 'frost', mult: 1.1, radius: 2 }, basePrice: 18, stackable: true, combatUse: 1, icon: 'bomb_blue', dropWeight: 4 }),
  B({ id: 'c_elixir', category: 'consumable', defaultName: 'Elixir of Might', consumable: { kind: 'buff', status: 'empowered', turns: 3 }, basePrice: 30, stackable: true, combatUse: 1, icon: 'potion_orange', dropWeight: 3 }),
  B({ id: 'c_recall', category: 'consumable', defaultName: 'Recall Scroll', consumable: { kind: 'recall' }, basePrice: 25, stackable: true, icon: 'scroll', dropWeight: 3 }),
  B({ id: 'c_food', category: 'consumable', defaultName: 'Ration', consumable: { kind: 'buff', status: 'regenerating', turns: 3 }, basePrice: 5, stackable: true, combatUse: 1, icon: 'food', dropWeight: 8 }),
  B({ id: 'c_skillbook', category: 'consumable', defaultName: 'Skill Book', consumable: { kind: 'skillbook' }, basePrice: 120, icon: 'book', dropWeight: 1 }),
  // Tools
  B({ id: 'tool_trapkit', category: 'tool', defaultName: 'Trap Kit', consumable: { kind: 'disarm' }, basePrice: 20, stackable: true, icon: 'tools', dropWeight: 4, requiresSystem: 'traps' }),
  B({ id: 'tool_lockpick', category: 'tool', defaultName: 'Lockpick', consumable: { kind: 'unlock' }, basePrice: 12, stackable: true, icon: 'lockpick', dropWeight: 4, requiresSystem: 'lockpicking' }),
  // Materials (crafting)
  B({ id: 'm_herb', category: 'material', defaultName: 'Herb', basePrice: 4, stackable: true, icon: 'herb', dropWeight: 8, requiresSystem: 'crafting' }),
  B({ id: 'm_ore', category: 'material', defaultName: 'Ore', basePrice: 6, stackable: true, icon: 'ore', dropWeight: 6, requiresSystem: 'crafting' }),
  B({ id: 'm_hide', category: 'material', defaultName: 'Hide', basePrice: 5, stackable: true, icon: 'hide', dropWeight: 6, requiresSystem: 'crafting' }),
  B({ id: 'm_cloth', category: 'material', defaultName: 'Cloth', basePrice: 4, stackable: true, icon: 'cloth', dropWeight: 6, requiresSystem: 'crafting' }),
  B({ id: 'm_essence', category: 'material', defaultName: 'Essence', basePrice: 10, stackable: true, icon: 'essence', dropWeight: 4, requiresSystem: 'crafting' }),
  B({ id: 'm_crystal', category: 'material', defaultName: 'Crystal', basePrice: 18, stackable: true, icon: 'crystal', dropWeight: 2, requiresSystem: 'crafting' }),
  // Valuables
  B({ id: 'v_gem', category: 'valuable', defaultName: 'Gem', basePrice: 40, stackable: true, icon: 'gem', dropWeight: 3 }),
  B({ id: 'v_trinket', category: 'valuable', defaultName: 'Curio', basePrice: 15, stackable: true, icon: 'curio', dropWeight: 6 }),
  // Quest / key placeholders (actual names come from the world)
  B({ id: 'q_item', category: 'quest', defaultName: 'Quest Item', basePrice: 0, icon: 'quest', dropWeight: 0 }),
  B({ id: 'k_key', category: 'key', defaultName: 'Key', basePrice: 0, icon: 'key', dropWeight: 0 }),
];

export const ITEM_BASE: Record<string, ItemBase> = Object.fromEntries(ITEM_BASES.map((b) => [b.id, b]));

// ------------------------------------------------------------------------------- Affixes

export type AffixStat =
  | 'maxHealth' | 'maxStamina' | 'maxFocus' | 'physArmor' | 'magArmor' | 'damagePct' | 'critChance' | 'critDamage'
  | 'attr_might' | 'attr_finesse' | 'attr_intellect' | 'attr_vitality' | 'attr_spirit' | 'attr_wits'
  | 'res_fire' | 'res_frost' | 'res_shock' | 'res_poison' | 'res_psychic'
  | 'healingPct' | 'initiative' | 'movement' | 'lootFind' | 'lifesteal' | 'thorns' | 'regen' | 'apStart'
  | 'onhit_fire' | 'onhit_frost' | 'onhit_shock' | 'onhit_poison';

export interface AffixDef {
  id: AffixStat;
  defaultPrefix: string;
  defaultSuffix: string;
  /** Value at item level 1 and per-level growth. */
  base: number;
  perLevel: number;
  /** Displayed as percentage? */
  pct?: boolean;
  slots: EquipSlot[] | 'any';
  weight: number;
  priceWeight: number;
  label: (v: number) => string;
}

const ALL: EquipSlot[] = EQUIP_SLOTS;
const ARMOR: EquipSlot[] = ['head', 'chest', 'hands', 'feet', 'offhand'];
const JEWEL: EquipSlot[] = ['ring', 'amulet'];
const WEAP: EquipSlot[] = ['mainhand'];

const A = (a: AffixDef) => a;
export const AFFIXES: AffixDef[] = [
  A({ id: 'maxHealth', defaultPrefix: 'Hale', defaultSuffix: 'of Vigor', base: 8, perLevel: 3.5, slots: [...ARMOR, ...JEWEL], weight: 10, priceWeight: 1, label: (v) => `+${v} Health` }),
  A({ id: 'maxStamina', defaultPrefix: 'Tireless', defaultSuffix: 'of Endurance', base: 4, perLevel: 1, slots: ALL, weight: 6, priceWeight: 0.8, label: (v) => `+${v} Stamina` }),
  A({ id: 'maxFocus', defaultPrefix: 'Lucid', defaultSuffix: 'of Clarity', base: 4, perLevel: 1, slots: ALL, weight: 6, priceWeight: 0.8, label: (v) => `+${v} Focus` }),
  A({ id: 'physArmor', defaultPrefix: 'Sturdy', defaultSuffix: 'of the Bulwark', base: 4, perLevel: 2, slots: ARMOR, weight: 8, priceWeight: 1, label: (v) => `+${v} Physical Armor` }),
  A({ id: 'magArmor', defaultPrefix: 'Warded', defaultSuffix: 'of Warding', base: 4, perLevel: 2, slots: ARMOR, weight: 8, priceWeight: 1, label: (v) => `+${v} Magic Armor` }),
  A({ id: 'damagePct', defaultPrefix: 'Cruel', defaultSuffix: 'of Ruin', base: 5, perLevel: 0.6, pct: true, slots: [...WEAP, ...JEWEL], weight: 8, priceWeight: 1.6, label: (v) => `+${v}% Damage` }),
  A({ id: 'critChance', defaultPrefix: 'Keen', defaultSuffix: 'of Precision', base: 3, perLevel: 0.25, pct: true, slots: [...WEAP, 'hands', ...JEWEL], weight: 6, priceWeight: 1.4, label: (v) => `+${v}% Critical Chance` }),
  A({ id: 'critDamage', defaultPrefix: 'Savage', defaultSuffix: 'of Carnage', base: 10, perLevel: 1, pct: true, slots: [...WEAP, ...JEWEL], weight: 4, priceWeight: 1.2, label: (v) => `+${v}% Critical Damage` }),
  A({ id: 'attr_might', defaultPrefix: 'Mighty', defaultSuffix: 'of the Bear', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {might}` }),
  A({ id: 'attr_finesse', defaultPrefix: 'Deft', defaultSuffix: 'of the Fox', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {finesse}` }),
  A({ id: 'attr_intellect', defaultPrefix: 'Wise', defaultSuffix: 'of the Owl', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {intellect}` }),
  A({ id: 'attr_vitality', defaultPrefix: 'Robust', defaultSuffix: 'of the Ox', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {vitality}` }),
  A({ id: 'attr_spirit', defaultPrefix: 'Serene', defaultSuffix: 'of the Dove', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {spirit}` }),
  A({ id: 'attr_wits', defaultPrefix: 'Clever', defaultSuffix: 'of the Raven', base: 1, perLevel: 0.15, slots: ALL, weight: 5, priceWeight: 1.5, label: (v) => `+${v} {wits}` }),
  A({ id: 'res_fire', defaultPrefix: 'Fireproof', defaultSuffix: 'of the Hearth', base: 8, perLevel: 0.8, pct: true, slots: [...ARMOR, ...JEWEL], weight: 3, priceWeight: 0.7, label: (v) => `+${v}% {fire} Resistance` }),
  A({ id: 'res_frost', defaultPrefix: 'Insulated', defaultSuffix: 'of the Thaw', base: 8, perLevel: 0.8, pct: true, slots: [...ARMOR, ...JEWEL], weight: 3, priceWeight: 0.7, label: (v) => `+${v}% {frost} Resistance` }),
  A({ id: 'res_shock', defaultPrefix: 'Grounded', defaultSuffix: 'of the Storm', base: 8, perLevel: 0.8, pct: true, slots: [...ARMOR, ...JEWEL], weight: 3, priceWeight: 0.7, label: (v) => `+${v}% {shock} Resistance` }),
  A({ id: 'res_poison', defaultPrefix: 'Purified', defaultSuffix: 'of the Antidote', base: 8, perLevel: 0.8, pct: true, slots: [...ARMOR, ...JEWEL], weight: 3, priceWeight: 0.7, label: (v) => `+${v}% {poison} Resistance` }),
  A({ id: 'res_psychic', defaultPrefix: 'Steadfast', defaultSuffix: 'of the Iron Mind', base: 8, perLevel: 0.8, pct: true, slots: [...ARMOR, ...JEWEL], weight: 3, priceWeight: 0.7, label: (v) => `+${v}% {psychic} Resistance` }),
  A({ id: 'healingPct', defaultPrefix: 'Blessed', defaultSuffix: 'of Mercy', base: 8, perLevel: 0.6, pct: true, slots: [...WEAP, 'offhand', ...JEWEL], weight: 4, priceWeight: 1.1, label: (v) => `+${v}% Healing` }),
  A({ id: 'initiative', defaultPrefix: 'Alert', defaultSuffix: 'of Readiness', base: 2, perLevel: 0.2, slots: ['head', 'feet', ...JEWEL], weight: 3, priceWeight: 0.6, label: (v) => `+${v} Initiative` }),
  A({ id: 'movement', defaultPrefix: 'Fleet', defaultSuffix: 'of Haste', base: 0.5, perLevel: 0.02, slots: ['feet'], weight: 4, priceWeight: 1.2, label: (v) => `+${v} Movement` }),
  A({ id: 'lootFind', defaultPrefix: 'Lucky', defaultSuffix: 'of Fortune', base: 6, perLevel: 0.5, pct: true, slots: ['head', 'hands', ...JEWEL], weight: 3, priceWeight: 0.9, label: (v) => `+${v}% Loot Find` }),
  A({ id: 'lifesteal', defaultPrefix: 'Vampiric', defaultSuffix: 'of the Leech', base: 3, perLevel: 0.2, pct: true, slots: [...WEAP, 'amulet'], weight: 2, priceWeight: 1.6, label: (v) => `${v}% Lifesteal` }),
  A({ id: 'thorns', defaultPrefix: 'Thorned', defaultSuffix: 'of Thorns', base: 3, perLevel: 1.2, slots: ['chest', 'offhand'], weight: 3, priceWeight: 0.8, label: (v) => `Reflect ${v} damage to attackers` }),
  A({ id: 'regen', defaultPrefix: 'Renewing', defaultSuffix: 'of Renewal', base: 1, perLevel: 0.4, slots: ['chest', ...JEWEL], weight: 3, priceWeight: 0.9, label: (v) => `+${v} Health per turn` }),
  A({ id: 'apStart', defaultPrefix: 'Swift', defaultSuffix: 'of Alacrity', base: 1, perLevel: 0, slots: ['amulet', 'feet'], weight: 0.6, priceWeight: 3, label: (v) => `+${v} AP at the start of combat` }),
  A({ id: 'onhit_fire', defaultPrefix: 'Blazing', defaultSuffix: 'of Embers', base: 3, perLevel: 1.0, slots: WEAP, weight: 3, priceWeight: 1.2, label: (v) => `+${v} {fire} damage on hit` }),
  A({ id: 'onhit_frost', defaultPrefix: 'Frigid', defaultSuffix: 'of Frost', base: 3, perLevel: 1.0, slots: WEAP, weight: 3, priceWeight: 1.2, label: (v) => `+${v} {frost} damage on hit` }),
  A({ id: 'onhit_shock', defaultPrefix: 'Crackling', defaultSuffix: 'of Sparks', base: 3, perLevel: 1.0, slots: WEAP, weight: 3, priceWeight: 1.2, label: (v) => `+${v} {shock} damage on hit` }),
  A({ id: 'onhit_poison', defaultPrefix: 'Venomous', defaultSuffix: 'of Venom', base: 3, perLevel: 1.0, slots: WEAP, weight: 3, priceWeight: 1.2, label: (v) => `+${v} {poison} damage on hit` }),
];

export const AFFIX: Record<string, AffixDef> = Object.fromEntries(AFFIXES.map((a) => [a.id, a]));

export function affixValue(id: AffixStat, level: number, roll: number): number {
  const a = AFFIX[id]!;
  const v = (a.base + a.perLevel * (level - 1)) * (0.75 + roll * 0.5);
  return a.id === 'movement' ? Math.round(v * 10) / 10 : Math.max(1, Math.round(v));
}

// ------------------------------------------------------------------------------- Instances

export interface ItemAffix {
  stat: AffixStat;
  value: number;
}

/** A concrete item owned by someone. All mechanics derive from base + level + rarity + affixes. */
export interface ItemInstance {
  id: string;
  baseId: string;
  level: number;
  rarity: Rarity;
  affixes: ItemAffix[];
  qty: number;
  /** For weapons with 'element' damage, which element. */
  element?: DamageType;
  /** Variant index into the world's names for this base. */
  nameVariant?: number;
  /** World-defined unique item (quest items, keys, legendaries). */
  uniqueId?: string;
  /** For skill books. */
  skillId?: string;
  /** Prevents selling/dropping quest items. */
  bound?: boolean;
}

export function weaponDamage(level: number, base: ItemBase, rarity: Rarity): [number, number] {
  const p = powerAtLevel(level) * (base.weapon?.damageMult ?? 1) * (1 + RARITY_ORDER[rarity] * 0.06);
  return [Math.max(1, Math.round(p * 0.85)), Math.max(2, Math.round(p * 1.15))];
}

export const RARITY_ORDER: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

export function armorValue(level: number, base: ItemBase, rarity: Rarity): { phys: number; mag: number } {
  const budget = (8 + level * 5.5) * (1 + RARITY_ORDER[rarity] * 0.07);
  return { phys: Math.round(budget * (base.armor?.phys ?? 0)), mag: Math.round(budget * (base.armor?.mag ?? 0)) };
}

export function itemPrice(item: ItemInstance): number {
  const base = ITEM_BASE[item.baseId];
  if (!base || base.basePrice <= 0) return 0;
  const levelMult = base.category === 'material' || base.category === 'valuable' ? 1 + item.level * 0.15 : 1 + (item.level - 1) * 0.35;
  let price = base.basePrice * levelMult * RARITY_INFO[item.rarity].priceMult;
  for (const a of item.affixes) price += (AFFIX[a.stat]?.priceWeight ?? 1) * item.level * 3;
  return Math.max(1, Math.round(price));
}

// ------------------------------------------------------------------------------- Crafting

export interface RecipeTemplate {
  id: string;
  inputs: { baseId: string; qty: number }[];
  /** Output: a fixed base, or a random item from a category at the crafter's level. */
  output: { baseId: string; qty: number } | { category: 'weapon' | 'armor' | 'trinket'; rarity: Rarity };
  defaultName: string;
}

export const RECIPES: RecipeTemplate[] = [
  { id: 'r_heal', inputs: [{ baseId: 'm_herb', qty: 2 }], output: { baseId: 'c_heal', qty: 1 }, defaultName: 'Brew Healing Potion' },
  { id: 'r_stamina', inputs: [{ baseId: 'm_herb', qty: 1 }, { baseId: 'm_hide', qty: 1 }], output: { baseId: 'c_stamina', qty: 1 }, defaultName: 'Brew Stamina Tonic' },
  { id: 'r_focus', inputs: [{ baseId: 'm_herb', qty: 1 }, { baseId: 'm_essence', qty: 1 }], output: { baseId: 'c_focus', qty: 1 }, defaultName: 'Brew Focus Draught' },
  { id: 'r_antidote', inputs: [{ baseId: 'm_herb', qty: 1 }, { baseId: 'm_cloth', qty: 1 }], output: { baseId: 'c_antidote', qty: 2 }, defaultName: 'Prepare Antidote' },
  { id: 'r_bomb', inputs: [{ baseId: 'm_ore', qty: 1 }, { baseId: 'm_essence', qty: 1 }], output: { baseId: 'c_bomb_fire', qty: 2 }, defaultName: 'Assemble Fire Bomb' },
  { id: 'r_bomb_frost', inputs: [{ baseId: 'm_crystal', qty: 1 }, { baseId: 'm_ore', qty: 1 }], output: { baseId: 'c_bomb_frost', qty: 2 }, defaultName: 'Assemble Frost Bomb' },
  { id: 'r_trapkit', inputs: [{ baseId: 'm_ore', qty: 1 }, { baseId: 'm_cloth', qty: 1 }], output: { baseId: 'tool_trapkit', qty: 1 }, defaultName: 'Make Trap Kit' },
  { id: 'r_lockpick', inputs: [{ baseId: 'm_ore', qty: 1 }], output: { baseId: 'tool_lockpick', qty: 2 }, defaultName: 'Make Lockpicks' },
  { id: 'r_weapon', inputs: [{ baseId: 'm_ore', qty: 3 }, { baseId: 'm_hide', qty: 1 }], output: { category: 'weapon', rarity: 'uncommon' }, defaultName: 'Forge Weapon' },
  { id: 'r_armor', inputs: [{ baseId: 'm_hide', qty: 2 }, { baseId: 'm_cloth', qty: 2 }], output: { category: 'armor', rarity: 'uncommon' }, defaultName: 'Stitch Armor' },
  { id: 'r_trinket', inputs: [{ baseId: 'm_crystal', qty: 2 }, { baseId: 'v_gem', qty: 1 }], output: { category: 'trinket', rarity: 'rare' }, defaultName: 'Craft Jewelry' },
  { id: 'r_fine_weapon', inputs: [{ baseId: 'm_ore', qty: 4 }, { baseId: 'm_essence', qty: 2 }, { baseId: 'm_crystal', qty: 1 }], output: { category: 'weapon', rarity: 'rare' }, defaultName: 'Forge Masterwork Weapon' },
];
