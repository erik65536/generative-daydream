/** Costs shared by the server (which charges them) and the client (which shows them). */
import { rx } from './stats';
import type { ItemBaseDef, RecipeDef, Ruleset } from './types';

/** How close (tiles) the party leader must stand to a workbench to use it. */
export const STATION_REACH = 3;

/**
 * Field recipes (remedies and simple tools) can be made anywhere out of combat; everything else — gear,
 * improving and enchanting — needs a workbench.
 */
export function fieldRecipe(r: Ruleset, rec: RecipeDef): boolean {
  if (!('itemId' in rec.output)) return false;
  const cat = rx(r).item.get(rec.output.itemId)?.category;
  return cat === 'potion' || cat === 'tool';
}

/** Whether a point stands within reach of one of these features' workbenches. */
export function nearStation(features: { kind: string; x: number; y: number }[], at: { x: number; y: number } | undefined): boolean {
  return !!at && features.some((f) => f.kind === 'craft_station' && Math.hypot(f.x - at.x, f.y - at.y) <= STATION_REACH + 0.5);
}

export interface CraftCost {
  gold: number;
  material?: ItemBaseDef;
  qty: number;
}

/** Inventory slot capacity after `upgrades` bag upgrades. */
export function inventoryCapacity(r: Ruleset, p: { inventoryUpgrades?: number }): number {
  return r.inventory.slots + Math.min(r.inventory.upgrades, p.inventoryUpgrades ?? 0) * r.inventory.slotsPerUpgrade;
}

/** Slots used: quest items never take space. */
export function inventoryUsed(p: { inventory: { bound?: boolean }[] }): number {
  return p.inventory.filter((i) => !i.bound).length;
}

export function bagUpgradeCost(r: Ruleset, p: { inventoryUpgrades?: number }): number {
  return Math.round(r.inventory.upgradeCost * Math.pow(1 + (p.inventoryUpgrades ?? 0), 1.6));
}

function upgradeMaterial(r: Ruleset): ItemBaseDef | undefined {
  const up = r.crafting.upgrades;
  return up.materialId ? rx(r).item.get(up.materialId) : r.items.find((i) => i.category === 'material' && (i.tier ?? 1) === 2) ?? r.items.find((i) => i.category === 'material');
}

function enchantMaterial(r: Ruleset): ItemBaseDef | undefined {
  const en = r.crafting.enchanting;
  return en.materialId ? rx(r).item.get(en.materialId) : [...r.items].filter((i) => i.category === 'material').sort((a, b) => (b.tier ?? 1) - (a.tier ?? 1))[0];
}

/** Cost of the next upgrade level, or null when the item is maxed or cannot be upgraded. */
export function upgradeCost(r: Ruleset, item: { baseId: string; level: number; upgrade?: number }): CraftCost | null {
  const up = r.crafting.upgrades;
  const lvl = item.upgrade ?? 0;
  if (!up.enabled || lvl >= up.maxLevel || rx(r).item.get(item.baseId)?.category !== 'equipment') return null;
  return { gold: Math.round(up.gold * (lvl + 1) * (1 + item.level * 0.15)), material: upgradeMaterial(r), qty: lvl + 1 };
}

/** Cost of rerolling one affix, or null when the item cannot be enchanted. */
export function enchantCost(r: Ruleset, item: { baseId: string; level: number; uniqueId?: string }): CraftCost | null {
  const en = r.crafting.enchanting;
  const base = rx(r).item.get(item.baseId);
  if (!en.enabled || item.uniqueId || base?.category !== 'equipment' || !base.slotId) return null;
  return { gold: Math.round(en.gold * (1 + item.level * 0.2)), material: enchantMaterial(r), qty: 1 };
}

// ------------------------------------------------------------------------------------ stacks

/** Default maximum stack size per category (an item base can override it with `maxStack`). */
export const MAX_STACK: Partial<Record<ItemBaseDef['category'], number>> = { potion: 20, tool: 10, material: 50, valuable: 25 };

/** How many fit in one inventory slot (1 for gear, story items and uniques). */
export function maxStack(r: Ruleset, item: { baseId: string; uniqueId?: string; bound?: boolean }): number {
  if (item.uniqueId || item.bound) return 1;
  const base = rx(r).item.get(item.baseId);
  if (!base?.stackable) return 1;
  return Math.max(1, base.maxStack ?? MAX_STACK[base.category] ?? 20);
}

/** Two items share a stack when they are the same stackable thing (level does not matter for stackables). */
export function sameStack(r: Ruleset, a: { baseId: string; uniqueId?: string; bound?: boolean }, b: { baseId: string; uniqueId?: string; bound?: boolean }): boolean {
  return a.baseId === b.baseId && maxStack(r, a) > 1 && maxStack(r, b) > 1;
}
