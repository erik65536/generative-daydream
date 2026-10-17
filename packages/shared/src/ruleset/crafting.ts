/** Costs shared by the server (which charges them) and the client (which shows them). */
import { rx } from './stats';
import type { ItemBaseDef, Ruleset } from './types';

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
