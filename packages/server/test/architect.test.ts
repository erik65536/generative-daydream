import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GROUND, PROP_COVER, PROP_COVER_TALL, Rng, findPath, objBlocks, propIndex, type Vec2 } from '@gd/shared';
import { realiseBlueprint, type ArchitectOpts } from '../src/worldgen/architect';
import type { PlaceDesign } from '../src/worldgen/blueprint';

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `floorplan-${name}.json`), 'utf8')) as PlaceDesign;
const TOWN_BUILDINGS = ['The Lucky Kettle', 'The Synergy Supply Store', "Thorne's Shop", "Thorne's Training Hall", "Vane's House", 'The Nap Pod Lounge', 'The Gray Suit Armory'];

function build(d: PlaceDesign, o: Partial<ArchitectOpts>, seed: string) {
  return realiseBlueprint(d.blueprint, new Rng(seed), { kind: 'wilderness', size: 62, edges: ['n', 'w'], internalExits: 1, buildings: [], enclosed: true, props: d.props, surfaces: d.surfaces, ...o });
}

function reachable(lay: ReturnType<typeof build>, to: Vec2) {
  const m = lay.map;
  return !!findPath(lay.entry, to, { width: m.w, height: m.h, passable: (x, y) => m.passable(x, y), stopWithin: 1.5, maxNodes: 80000 });
}

describe('floor plans', () => {
  for (const seed of ['a', 'b', 'c']) {
    it(`town plan seats every building with its door reachable (seed ${seed})`, () => {
      const lay = build(fixture('town'), { kind: 'town', size: 50, buildings: TOWN_BUILDINGS, internalExits: 0, edges: ['e', 's'] }, seed);
      expect(lay.buildings.length).toBe(TOWN_BUILDINGS.length);
      for (const b of lay.buildings) expect(reachable(lay, b.front)).toBe(true);
      for (const e of Object.values(lay.edgeExits)) expect(reachable(lay, e!)).toBe(true);
      expect(lay.plaza).toBeDefined();
    });

    it(`natural plan joins its islands and exits (seed ${seed})`, () => {
      const lay = build(fixture('natural'), { enclosed: false }, seed);
      for (const e of Object.values(lay.edgeExits)) expect(reachable(lay, e!)).toBe(true);
      for (const s of lay.internalExitSpots) expect(reachable(lay, s)).toBe(true);
      expect(lay.packSpots.length).toBeGreaterThanOrEqual(5);
    });

    it(`dungeon plan has an entrance, a boss room and reachable rooms (seed ${seed})`, () => {
      const lay = build(fixture('dungeon'), { kind: 'dungeon', size: 54, edges: [], internalExits: 0 }, seed);
      expect(lay.bossSpot).toBeDefined();
      expect(reachable(lay, lay.bossSpot!)).toBe(true);
      expect(lay.packSpots.length).toBeGreaterThanOrEqual(3);
    });
  }

  it('encodes props consistently (anchors, covers, blocking)', () => {
    const d = fixture('town');
    const lay = build(d, { kind: 'town', size: 50, buildings: TOWN_BUILDINGS, internalExits: 0, edges: ['e'] }, 'codes');
    const m = lay.map;
    let props = 0;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const o = m.o(x, y), pi = propIndex(o);
        if (pi < 0) {
          if (o === PROP_COVER || o === PROP_COVER_TALL) expect(objBlocks(o)).toBe(true);
          continue;
        }
        props++;
        const p = d.props[pi]!;
        expect(p).toBeDefined();
        expect(objBlocks(o)).toBe(p.blocks);
        expect(m.g(x, y)).not.toBe(GROUND.wall);
        // Bigger props cover their whole footprint.
        if (p.size === 2 && p.blocks) expect([m.o(x + 1, y), m.o(x, y + 1), m.o(x + 1, y + 1)].every((c) => c === PROP_COVER || c === PROP_COVER_TALL)).toBe(true);
      }
    expect(props).toBeGreaterThan(20);
  });
});
