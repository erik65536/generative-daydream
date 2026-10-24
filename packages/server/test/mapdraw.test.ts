import { describe, expect, it } from 'vitest';
import { BARRIER_DEPTH_M, PAINT_PXM, mapPixels } from '../src/worldgen/mapdraw';
import { CELL } from '../src/worldgen/mapgrid';
import { standInReading } from '../src/worldgen/zones';

describe('painted maps', () => {
  it('are sized in tiles and read at PAINT_PXM pixels per metre', () => {
    const m = mapPixels('town');
    expect([m.W, m.H]).toEqual([3072, 2048]);
    expect(m.X).toBeCloseTo(3072 / PAINT_PXM);
  });

  it('stand-in reading: walkable inside, the barrier band blocked except at the exits', () => {
    const r = standInReading('town', [{ side: 'top', at: 0.5 }, { side: 'left', at: 0.25 }]);
    const { cols, rows } = r.grid;
    const at = (row: number, col: number) => r.walk[row * cols + col];
    const band = Math.ceil(BARRIER_DEPTH_M / CELL);
    expect(at(Math.round(rows / 2), Math.round(cols / 2))).toBe(1);
    // The band: blocked along the edges, open in each exit's gap.
    expect(at(0, Math.round(cols * 0.25))).toBe(0);
    expect(at(Math.round(rows / 2), cols - 1)).toBe(0);
    expect(at(0, Math.round(cols / 2))).toBe(1);
    expect(at(Math.round(rows * 0.25), 0)).toBe(1);
    expect(at(band, Math.round(cols * 0.25))).toBe(1);
    // A way out spot per exit, inside the map near its side.
    expect(r.edges.map((e) => e.label)).toEqual(['top', 'left']);
    expect(r.edges[0]!.y).toBeLessThan(r.height / 4);
    expect(r.edges[1]!.x).toBeLessThan(r.width / 4);
  });
});
