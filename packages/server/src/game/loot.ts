/** Item rolling: loot drops, chest contents, merchant stock and quest rewards. */
import {
  AFFIXES, DAMAGE_TYPES, ITEM_BASE, ITEM_BASES, MERCHANT_STOCK, RARITIES, RARITY_INFO, RARITY_ORDER, Rng, affixValue, uid,
  type DamageType, type ItemBase, type ItemInstance, type MerchantKind, type Rarity, type WorldDefinition,
} from '@gd/shared';

export function systemAllows(w: WorldDefinition, base: ItemBase): boolean {
  if (!base.requiresSystem) return true;
  return !!w.systems[base.requiresSystem];
}

export function rollRarity(rng: Rng, lootFind = 0, min: Rarity = 'common'): Rarity {
  const bonus = 1 + lootFind / 100;
  const r = rng.pickWeighted([...RARITIES], (x) => RARITY_INFO[x].weight * (x === 'common' ? 1 : bonus * (1 + RARITY_ORDER[x] * 0.1 * (bonus - 1))));
  return RARITY_ORDER[r] < RARITY_ORDER[min] ? min : r;
}

export function makeItem(w: WorldDefinition, rng: Rng, baseId: string, level: number, rarity: Rarity, qty = 1): ItemInstance {
  const base = ITEM_BASE[baseId]!;
  const item: ItemInstance = { id: uid('it'), baseId, level: Math.max(1, Math.min(w.maxLevel, level)), rarity: base.slot ? rarity : 'common', affixes: [], qty };
  if (base.weapon?.damageType === 'element') item.element = rng.pick(['fire', 'frost', 'shock', 'poison', 'psychic', 'radiant'] as DamageType[]);
  if (base.slot) {
    const [lo, hi] = RARITY_INFO[item.rarity].affixes;
    const n = rng.int(lo, hi);
    const pool = AFFIXES.filter((a) => a.slots === 'any' || a.slots.includes(base.slot!));
    const taken = new Set<string>();
    for (let i = 0; i < n && pool.length; i++) {
      const a = rng.pickWeighted(pool.filter((p) => !taken.has(p.id)), (p) => p.weight);
      if (!a) break;
      taken.add(a.id);
      item.affixes.push({ stat: a.id, value: affixValue(a.id, item.level, rng.next()) });
    }
  }
  if (baseId === 'c_skillbook') {
    const skills = Object.keys(w.skills);
    item.skillId = rng.pick(skills);
  }
  return item;
}

/** Make an instance of a world-defined unique item. */
export function makeUnique(w: WorldDefinition, uniqueId: string, level: number): ItemInstance | null {
  const u = w.uniqueItems[uniqueId];
  if (!u) return null;
  return { id: uid('it'), baseId: u.baseId, level: Math.max(1, level), rarity: u.rarity, affixes: u.affixes ?? [], qty: 1, uniqueId, bound: !!u.questItem, element: u.element };
}

const DROP_POOL = (w: WorldDefinition) => ITEM_BASES.filter((b) => b.dropWeight > 0 && systemAllows(w, b));

export function rollRandomItem(w: WorldDefinition, rng: Rng, level: number, lootFind = 0, opts: { minRarity?: Rarity; category?: string } = {}): ItemInstance {
  const pool = DROP_POOL(w).filter((b) => !opts.category || b.category === opts.category || (opts.category === 'armor' && b.category === 'shield'));
  const base = rng.pickWeighted(pool, (b) => b.dropWeight);
  const rarity = base.slot ? rollRarity(rng, lootFind, opts.minRarity) : 'common';
  const qty = base.stackable ? (base.category === 'material' ? rng.int(1, 3) : 1) : 1;
  return makeItem(w, rng, base.id, level + rng.int(-1, 0), rarity, qty);
}

export function rollLoot(w: WorldDefinition, rng: Rng, level: number, opts: { lootFind?: number; boss?: boolean; elite?: boolean; chest?: boolean }): { items: ItemInstance[]; gold: number } {
  const lf = opts.lootFind ?? 0;
  const items: ItemInstance[] = [];
  const gold = Math.round((rng.chance(opts.chest ? 0.9 : 0.55) ? rng.int(2, 6) + level * rng.int(2, 5) : 0) * (opts.boss ? 6 : opts.elite ? 2 : 1) * (1 + lf / 100));
  const n = opts.boss ? rng.int(2, 3) : opts.chest ? rng.int(1, 3) : opts.elite ? rng.int(1, 2) : rng.chance(0.32) ? 1 : 0;
  for (let i = 0; i < n; i++) items.push(rollRandomItem(w, rng, level, lf, { minRarity: opts.boss && i === 0 ? 'rare' : opts.elite && i === 0 ? 'uncommon' : undefined }));
  if (w.systems.crafting && rng.chance(opts.chest ? 0.5 : 0.25)) {
    const mats = ITEM_BASES.filter((b) => b.category === 'material');
    items.push(makeItem(w, rng, rng.pickWeighted(mats, (b) => b.dropWeight).id, level, 'common', rng.int(1, 2)));
  }
  return { items: mergeStacks(items), gold };
}

export function merchantStock(w: WorldDefinition, rng: Rng, kind: MerchantKind, level: number): ItemInstance[] {
  const ids = MERCHANT_STOCK[kind].filter((id) => ITEM_BASE[id] && systemAllows(w, ITEM_BASE[id]!));
  const out: ItemInstance[] = [];
  for (const id of ids) {
    const base = ITEM_BASE[id]!;
    if (base.slot) {
      const n = kind === 'general' ? 1 : rng.int(1, 2);
      for (let i = 0; i < n; i++) out.push(makeItem(w, rng, id, level + rng.int(-1, 1), rng.pick(['common', 'common', 'uncommon', 'uncommon', 'rare'] as Rarity[])));
    } else out.push(makeItem(w, rng, id, level, 'common', base.stackable ? rng.int(3, 8) : 1));
  }
  return out;
}

/** Quest reward specs: unique id or "base:<baseId>:<rarity>". */
export function rewardItems(w: WorldDefinition, rng: Rng, specs: string[], level: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const s of specs) {
    if (s.startsWith('base:')) {
      const [, baseId, rarity] = s.split(':');
      if (baseId && ITEM_BASE[baseId]) out.push(makeItem(w, rng, baseId, level, (rarity as Rarity) ?? 'uncommon', ITEM_BASE[baseId]!.stackable ? 2 : 1));
    } else {
      const u = makeUnique(w, s, level);
      if (u) out.push(u);
    }
  }
  return out;
}

export function mergeStacks(items: ItemInstance[]): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const it of items) {
    const base = ITEM_BASE[it.baseId];
    const same = base?.stackable ? out.find((o) => o.baseId === it.baseId && o.level === it.level && !o.uniqueId && !it.uniqueId && o.skillId === it.skillId) : undefined;
    if (same) same.qty += it.qty;
    else out.push(it);
  }
  return out;
}

/** Add items to an inventory, stacking where possible. */
export function addToInventory(inv: ItemInstance[], items: ItemInstance[]) {
  for (const it of items) {
    const base = ITEM_BASE[it.baseId];
    const same = base?.stackable && !it.uniqueId ? inv.find((o) => o.baseId === it.baseId && Math.abs(o.level - it.level) <= 0 && !o.uniqueId) : undefined;
    if (same) same.qty += it.qty;
    else inv.push(it);
  }
}

export function removeFromInventory(inv: ItemInstance[], itemId: string, qty = 1): ItemInstance | null {
  const i = inv.findIndex((x) => x.id === itemId);
  if (i < 0) return null;
  const it = inv[i]!;
  if (it.qty > qty) {
    it.qty -= qty;
    return { ...it, id: uid('it'), qty };
  }
  inv.splice(i, 1);
  return it;
}

export { DAMAGE_TYPES };
