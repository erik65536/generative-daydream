import { describe, expect, it } from 'vitest';
import { BARRIER_DEPTH_M, EXIT_GAP_M, PAINT_PXM, TILE_RANGE, fitTiles, mapPixels } from '../src/worldgen/mapdraw';
import { fixMap } from '../src/worldgen/mapfix';
import { CELL, type Grid } from '../src/worldgen/mapgrid';
import { fuseDoors, ontoWalk } from '../src/worldgen/mapspots';

describe('painted maps', () => {
  it('are sized in tiles and read at PAINT_PXM pixels per metre', () => {
    const m = mapPixels([3, 2]);
    expect([m.W, m.H]).toEqual([3072, 2048]);
    expect(m.X).toBeCloseTo(3072 / PAINT_PXM);
  });

  it('keep each kind of place within its sizes, never over 4 × 4 tiles', () => {
    expect(fitTiles('town', [9, 1])).toEqual([3, 2]);
    expect(fitTiles('wilderness', [5, 4])).toEqual([4, 4]);
    expect(fitTiles('dungeon', [1, 1])).toEqual([2, 1]);
    expect(fitTiles('dungeon')).toEqual(TILE_RANGE.dungeon.usual);
    for (const r of Object.values(TILE_RANGE)) expect(Math.max(...r.max)).toBeLessThanOrEqual(4);
  });
});

/** A 20 × 12 m map, open everywhere unless drawn otherwise. */
function map() {
  const g: Grid = { cols: 80, rows: 48 };
  const open = new Uint8Array(g.cols * g.rows).fill(1);
  const rect = (c0: number, r0: number, c1: number, r1: number, v: number) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) open[r * g.cols + c] = v;
  };
  return { g, open, rect, at: (m: Uint8Array, r: number, c: number) => m[r * g.cols + c] };
}
const band = Math.ceil(BARRIER_DEPTH_M / CELL), gap = EXIT_GAP_M / CELL;

describe('making a read map usable', () => {
  it('blocks the barrier band except at the ways out, and keeps those reachable', async () => {
    const { g, open, at } = map();
    const f = await fixMap(open, g, [{ side: 'top', at: 0.5 }, { side: 'left', at: 0.25 }], band, gap);
    expect(at(f.walk, 24, 40)).toBe(1);
    expect(at(f.walk, 0, 20)).toBe(0);
    expect(at(f.walk, 24, 79)).toBe(0);
    expect(at(f.walk, 1, 40)).toBe(1);
    expect(at(f.walk, 12, 1)).toBe(1);
  });

  it('joins a cut-off area through a thin wall, but not through a thick one', async () => {
    const thin = map();
    // A wall across the map 0.5 m thick: the right side is cut off, then joined by a carved passage.
    thin.rect(50, 0, 51, 47, 0);
    const f = await fixMap(thin.open, thin.g, [], band, gap);
    expect(f.joined).toBe(1);
    expect(at(f.walk, 24, 65)).toBe(1);
    const thick = map();
    thick.rect(40, 0, 59, 47, 0);
    const t = await fixMap(thick.open, thick.g, [], band, gap);
    expect(t.joined).toBe(0);
    expect(at(t.walk, 24, 70)).toBe(0);
    function at(m: Uint8Array, r: number, c: number) {
      return m[r * 80 + c];
    }
  });

  it('leaves out a cut-off area Luna rejects, even when the narrower clearance would join it', async () => {
    const { g, open, rect, at } = map();
    // A strip walled off except for a neck 0.5 m wide: joined by the one-cell clearance alone, unless rejected.
    rect(50, 0, 51, 47, 0);
    rect(50, 23, 51, 24, 1);
    const kept = await fixMap(open, g, [], band, gap, async () => true);
    expect(at(kept.walk, 24, 65)).toBe(1);
    const dropped = await fixMap(open, g, [], band, gap, async () => false);
    expect(dropped.left).toBe(1);
    expect(at(dropped.walk, 24, 65)).toBe(0);
  });

  it('cleans specks: a tiny blocked dot inside open ground opens', async () => {
    const { g, open, at } = map();
    open[24 * g.cols + 40] = 0;
    const f = await fixMap(open, g, [], band, gap);
    expect(at(f.open, 24, 40)).toBe(1);
  });
});

describe('placing spots', () => {
  it('moves each entrance onto the nearest unclaimed door mark within 3 m, closest pairs first', () => {
    const pxm = 40;
    const spots = [{ x: 100, y: 100, label: 'a' }, { x: 160, y: 100, label: 'b' }, { x: 1000, y: 1000, label: 'c' }];
    const marks = [{ x: 150, y: 110 }, { x: 600, y: 600 }];
    const f = fuseDoors(spots, marks, pxm);
    // b is closer to the mark than a, so b takes it; a stays; c has no mark within 3 m.
    expect(f.map((s) => [s.label, s.x, s.y])).toEqual([['a', 100, 100], ['b', 150, 110], ['c', 1000, 1000]]);
  });

  it('stands spots on the nearest walkable ground, and drops those with none near', () => {
    const { g, open, rect } = map();
    rect(30, 10, 45, 20, 0);
    // A spot on the roof (picture 10 px per cell) moves just outside it; one far inside a big block is dropped.
    const [s] = ontoWalk([{ x: 37 * 10 + 5, y: 19 * 10 + 5, label: 'roof' }], open, g, 800, 480);
    expect(s!.y).toBeGreaterThan(20 * 10);
    rect(0, 0, 79, 47, 0);
    expect(ontoWalk([{ x: 400, y: 240, label: 'x' }], open, g, 800, 480)).toHaveLength(0);
  });
});
