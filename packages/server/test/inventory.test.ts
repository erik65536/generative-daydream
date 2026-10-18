import { describe, expect, it } from 'vitest';
import { Rng, maxStack } from '@gd/shared';
import { compileRuleset } from '../src/rules/compile';
import { defaultIntent } from '../src/rules/defaults';
import { addToInventory, fitsInInventory, makeItem, normalizeInventory } from '../src/game/loot';

describe('inventory stacks', () => {
  const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
  const rng = new Rng('inv');
  const potion = r.items.find((i) => i.category === 'potion')!;
  const sword = r.items.find((i) => i.weapon)!;
  const common = r.rarities[0]!.id;

  it('stacks the same consumable whatever its level, up to the limit', () => {
    const max = maxStack(r, { baseId: potion.id });
    expect(max).toBeGreaterThan(1);
    const inv = [makeItem(r, rng, potion.id, 1, common, max - 2)];
    addToInventory(r, inv, [makeItem(r, rng, potion.id, 5, common, 5)]);
    expect(inv.map((i) => i.qty)).toEqual([max, 3]);
    expect(inv[0]!.level).toBe(5);
  });

  it('never stacks equipment', () => {
    const inv = [makeItem(r, rng, sword.id, 1, common, 1)];
    addToInventory(r, inv, [makeItem(r, rng, sword.id, 1, common, 1)]);
    expect(inv.length).toBe(2);
  });

  it('counts only the stacks that overflow against capacity', () => {
    const max = maxStack(r, { baseId: potion.id });
    const inventory = [makeItem(r, rng, potion.id, 1, common, 1), ...Array.from({ length: r.inventory.slots - 1 }, () => makeItem(r, rng, sword.id, 1, common, 1))];
    const p = { inventory, inventoryUpgrades: 0 };
    expect(fitsInInventory(r, p, [makeItem(r, rng, potion.id, 3, common, max - 1)])).toBe(true);
    expect(fitsInInventory(r, p, [makeItem(r, rng, potion.id, 3, common, max)])).toBe(false);
  });

  it('re-packs old saves that split stacks by level', () => {
    const inv = normalizeInventory(r, [makeItem(r, rng, potion.id, 1, common, 2), makeItem(r, rng, potion.id, 4, common, 3)]);
    expect(inv.length).toBe(1);
    expect(inv[0]!.qty).toBe(5);
  });
});
