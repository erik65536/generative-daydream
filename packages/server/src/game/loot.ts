/** Item rolling on the world's ruleset: loot drops, chests, merchant stock, crafting outputs, uniques, inventory. */
import {
  curve, rx, uid,
  type ItemBaseDef, type ItemInstance, type MerchantKind, type PlayerState, type Rng, type Ruleset, type SlotKind, type UniqueItemDef,
} from '@gd/shared';

const slotKind = (r: Ruleset, base: ItemBaseDef): SlotKind | undefined => (base.slotId ? rx(r).slot.get(base.slotId)?.kind : undefined);

export function rollRarity(r: Ruleset, rng: Rng, lootFind = 0, minIndex = 0): string {
  const bonus = 1 + lootFind / 100;
  const idx = rng.pickWeighted(r.rarities.map((_, i) => i), (i) => r.rarities[i]!.weight * (i === 0 ? 1 : bonus * (1 + i * 0.1 * (bonus - 1))));
  return r.rarities[Math.max(minIndex, idx)]!.id;
}

/** Affix value at an item level (percentage stats grow a little with level; scaled stats grow through the curves). */
export function affixValue(r: Ruleset, affixId: string, level: number, rarityId: string, roll: number): number {
  const a = rx(r).affix.get(affixId)!;
  const budget = rx(r).rarity.get(rarityId)?.budget ?? 1;
  let v = (a.value + a.perLevel * (level - 1)) * budget * (0.8 + roll * 0.4);
  if (a.cap !== undefined) v = Math.min(a.cap, v);
  return a.stat.startsWith('attr:') ? Math.max(1, Math.round(v)) : Math.round(v * 1000) / 1000;
}

export function makeItem(r: Ruleset, rng: Rng, baseId: string, level: number, rarityId: string, qty = 1): ItemInstance {
  const ix = rx(r);
  const base = ix.item.get(baseId)!;
  const equip = base.category === 'equipment';
  const rid = equip ? rarityId : r.rarities[0]!.id;
  const item: ItemInstance = { id: uid('it'), baseId, level: Math.max(1, Math.min(r.progression.maxLevel, level)), rarityId: rid, affixes: [], qty };
  if (equip) {
    const kind = slotKind(r, base);
    const [lo, hi] = ix.rarity.get(rid)?.affixes ?? [0, 0];
    const n = rng.int(lo, hi);
    const pool = r.affixes.filter((a) => kind && a.slotKinds.includes(kind));
    // A stat the base already grants is never rolled again as an affix (it would read as a duplicate line).
    const taken = new Set<string>((base.implicit ?? []).map((m) => m.stat));
    if (base.defense) for (const t of Object.keys(base.defense)) taken.add(`mit:${t}`);
    for (let i = 0; i < n && pool.length; i++) {
      const choices = pool.filter((p) => !taken.has(p.stat));
      if (!choices.length) break;
      const a = rng.pickWeighted(choices, (p) => p.weight);
      taken.add(a.stat);
      item.affixes.push({ affixId: a.id, value: affixValue(r, a.id, item.level, rid, rng.next()) });
    }
  }
  return item;
}

/** An instance of a world-defined unique item. */
export function makeUnique(r: Ruleset, def: UniqueItemDef, level: number): ItemInstance {
  return { id: uid('it'), baseId: rx(r).item.has(def.baseId) ? def.baseId : 'quest_item', level: Math.max(1, level), rarityId: def.rarityId ?? r.rarities[4]!.id, affixes: [], qty: 1, uniqueId: def.id, uniqueMods: def.mods ?? [], bound: !!def.questItem };
}

const dropPool = (r: Ruleset) => r.items.filter((b) => b.dropWeight > 0 && b.category !== 'quest' && b.category !== 'key');

export function rollRandomItem(r: Ruleset, rng: Rng, level: number, lootFind = 0, opts: { minRarity?: number; slotKind?: SlotKind } = {}): ItemInstance {
  let pool = dropPool(r);
  if (opts.slotKind) pool = pool.filter((b) => b.category === 'equipment' && slotKind(r, b) === opts.slotKind);
  if (!pool.length) pool = dropPool(r);
  const base = rng.pickWeighted(pool, (b) => b.dropWeight);
  const rarity = base.category === 'equipment' ? rollRarity(r, rng, lootFind, opts.minRarity ?? 0) : r.rarities[0]!.id;
  const qty = base.stackable ? (base.category === 'material' ? rng.int(1, 3) : 1) : 1;
  return makeItem(r, rng, base.id, level + rng.int(-1, 0), rarity, qty);
}

export function rollLoot(r: Ruleset, rng: Rng, level: number, opts: { lootFind?: number; boss?: boolean; elite?: boolean; chest?: boolean; mult?: number }): { items: ItemInstance[]; gold: number } {
  const lf = opts.lootFind ?? 0;
  const m = opts.mult ?? 1;
  const items: ItemInstance[] = [];
  const goldBase = curve(r.economy.goldPerKill, level);
  const gold = Math.round((rng.chance(opts.chest ? 0.9 : 0.55) ? goldBase * (0.6 + rng.next() * 0.8) * (opts.chest ? 2.5 : 1) : 0) * (opts.boss ? 6 : opts.elite ? 2 : 1) * (1 + lf / 100) * m);
  const n = opts.boss ? rng.int(2, 3) : opts.chest ? rng.int(1, 3) : opts.elite ? rng.int(1, 2) : rng.chance(0.3 * m) ? 1 : 0;
  for (let i = 0; i < n; i++) items.push(rollRandomItem(r, rng, level, lf, { minRarity: opts.boss && i === 0 ? 2 : opts.elite && i === 0 ? 1 : 0 }));
  const mats = r.items.filter((b) => b.category === 'material');
  if (mats.length && rng.chance(opts.chest ? 0.5 : 0.22)) items.push(makeItem(r, rng, rng.pickWeighted(mats, (b) => b.dropWeight).id, level, r.rarities[0]!.id, rng.int(1, 2)));
  return { items: mergeStacks(r, items), gold };
}

/** Merchant stock by shop kind, drawn from the ruleset's items. */
export function merchantStock(r: Ruleset, rng: Rng, kind: MerchantKind, level: number): ItemInstance[] {
  const ix = rx(r);
  const out: ItemInstance[] = [];
  const equip = (k: SlotKind | 'any', n: number) => {
    const bases = r.items.filter((b) => b.category === 'equipment' && (k === 'any' || slotKind(r, b) === k));
    for (let i = 0; i < n && bases.length; i++) out.push(makeItem(r, rng, rng.pick(bases).id, level + rng.int(-1, 1), r.rarities[rng.pick([0, 0, 1, 1, 2])]!.id));
  };
  const stack = (cat: ItemBaseDef['category'], filter: (b: ItemBaseDef) => boolean = () => true) => {
    for (const b of r.items.filter((x) => x.category === cat && filter(x))) out.push(makeItem(r, rng, b.id, level, r.rarities[0]!.id, b.stackable ? rng.int(3, 8) : 1));
  };
  switch (kind) {
    case 'weapons': equip('weapon', 5); equip('offhand', 2); break;
    case 'armor': equip('armor', 7); equip('offhand', 2); break;
    case 'alchemy': stack('potion'); stack('material', (b) => (b.tier ?? 1) <= 2); break;
    case 'magic': equip('accessory', 4); equip('weapon', 2); stack('potion', (b) => !!b.use?.effects.some((e) => e.kind === 'restore')); break;
    case 'materials': stack('material'); break;
    default:
      stack('potion', (b) => !!b.use?.effects.some((e) => e.kind === 'heal' || e.kind === 'restore'));
      stack('tool');
      equip('any', 3);
  }
  void ix;
  return out;
}

export function mergeStacks(r: Ruleset, items: ItemInstance[]): ItemInstance[] {
  const out: ItemInstance[] = [];
  addToInventory(r, out, items);
  return out;
}

import { inventoryCapacity, maxStack, sameStack } from '@gd/shared';
export { inventoryCapacity };

/** Stacks `items` would add to `inv` once poured into partly filled stacks first. */
function newStacksNeeded(r: Ruleset, inv: ItemInstance[], items: ItemInstance[]): number {
  const room = new Map<string, number>();
  for (const o of inv) if (maxStack(r, o) > 1) room.set(o.baseId, (room.get(o.baseId) ?? 0) + Math.max(0, maxStack(r, o) - o.qty));
  let stacks = 0;
  for (const it of items) {
    if (it.bound) continue;
    const max = maxStack(r, it);
    if (max <= 1) {
      stacks++;
      continue;
    }
    let left = it.qty;
    const free = room.get(it.baseId) ?? 0;
    const used = Math.min(free, left);
    left -= used;
    room.set(it.baseId, free - used);
    while (left > 0) {
      stacks++;
      const put = Math.min(max, left);
      left -= put;
      room.set(it.baseId, (room.get(it.baseId) ?? 0) + (max - put));
    }
  }
  return stacks;
}

/** Whether `items` fit (filling existing stacks is free; story items always fit). */
export function fitsInInventory(r: Ruleset, p: Pick<PlayerState, 'inventory' | 'inventoryUpgrades'>, items: ItemInstance[]): boolean {
  const used = p.inventory.filter((i) => !i.bound).length;
  return used + newStacksNeeded(r, p.inventory, items) <= inventoryCapacity(r, p);
}

/** Add items, topping up existing stacks to their limit and opening new stacks for the rest. */
export function addToInventory(r: Ruleset, inv: ItemInstance[], items: ItemInstance[]) {
  for (const it of items) {
    const max = maxStack(r, it);
    if (max <= 1) {
      inv.push(it);
      continue;
    }
    // Stackables don't depend on level: keep one level per stack (the higher).
    let left = it.qty;
    for (const o of inv) {
      if (left <= 0) break;
      if (!sameStack(r, o, it) || o.qty >= max) continue;
      const put = Math.min(max - o.qty, left);
      o.qty += put;
      o.level = Math.max(o.level, it.level);
      left -= put;
    }
    let first = true;
    while (left > 0) {
      const put = Math.min(max, left);
      inv.push({ ...it, id: first ? it.id : uid('it'), qty: put });
      first = false;
      left -= put;
    }
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

/** Quest reward specs: unique id or "base:<baseId>:<rarityIndex>" or "slot:<slotKind>:<rarityIndex>". */
export function rewardItems(r: Ruleset, uniques: Record<string, UniqueItemDef>, rng: Rng, specs: string[], level: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const s of specs) {
    if (s.startsWith('base:')) {
      const [, baseId, rar] = s.split(':');
      const base = baseId ? rx(r).item.get(baseId) : undefined;
      if (base) out.push(makeItem(r, rng, base.id, level, r.rarities[Math.min(4, Number(rar) || 1)]!.id, base.stackable ? 2 : 1));
    } else if (s.startsWith('slot:')) {
      const [, kind, rar] = s.split(':');
      out.push(rollRandomItem(r, rng, level, 0, { slotKind: kind as SlotKind, minRarity: Math.min(4, Number(rar) || 1) }));
    } else if (uniques[s]) out.push(makeUnique(r, uniques[s]!, level));
  }
  return out;
}
