import { describe, expect, it } from 'vitest';
import { SIZE_PROFILES, WORLD_SIZES, buildEstimate } from '@gd/shared';
import { TILE_RANGE } from '../src/worldgen/mapdraw';

describe('world sizes', () => {
  it('give every size room for its places at their smallest, and grow with the size', () => {
    for (const s of WORLD_SIZES) {
      const p = SIZE_PROFILES[s];
      const smallest = p.towns * TILE_RANGE.town.min[0] * TILE_RANGE.town.min[1] + p.wilds * TILE_RANGE.wilderness.min[0] * TILE_RANGE.wilderness.min[1] + p.dungeons * TILE_RANGE.dungeon.min[0] * TILE_RANGE.dungeon.min[1];
      expect(p.tiles).toBeGreaterThanOrEqual(smallest);
    }
    const e = WORLD_SIZES.map((s) => buildEstimate(s, 'short', 'party_npc'));
    for (let i = 1; i < e.length; i++) {
      expect(e[i]!.buildHours).toBeGreaterThan(e[i - 1]!.buildHours);
      expect(e[i]!.usd).toBeGreaterThan(e[i - 1]!.usd);
    }
  });
});
