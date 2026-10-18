/** Dev check: ASCII view of a floor plan realised by the architect. Usage: tsx src/cli/blueprintpeek.ts <blueprint.json> [kind] [seed] */
import fs from 'node:fs';
import { GROUND, PROP_COVER, PROP_COVER_TALL, Rng, SURFACE_BASE, propIndex, type Blueprint, type GroundDef, type PropDef } from '@gd/shared';
import { realiseBlueprint } from '../worldgen/architect';

const [file, kind = 'wilderness', seed = 'peek'] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(file!, 'utf8')) as { blueprint: Blueprint; props: PropDef[]; surfaces: GroundDef[]; buildings?: string[] };
const lay = realiseBlueprint(spec.blueprint, new Rng(seed), { kind: kind as 'wilderness', size: kind === 'town' ? 50 : 62, edges: ['n', 'w'], internalExits: kind === 'wilderness' ? 1 : 0, buildings: spec.buildings ?? [], enclosed: true, props: spec.props, surfaces: spec.surfaces });
const m = lay.map;
const glyph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const sg = '-+:;';
for (let y = 0; y < m.h; y++) {
  let row = '';
  for (let x = 0; x < m.w; x++) {
    const o = m.o(x, y), g = m.g(x, y);
    const pi = propIndex(o);
    const isExit = lay.internalExitSpots.some((p) => p.x === x && p.y === y) || Object.values(lay.edgeExits).some((p) => p!.x === x && p!.y === y);
    row += isExit ? '@' : x === lay.entry.x && y === lay.entry.y ? 'E' : pi >= 0 ? glyph[pi] : o === PROP_COVER || o === PROP_COVER_TALL ? '%' : o ? 'T' : g === GROUND.wall ? '#' : g === GROUND.water ? '~' : g === GROUND.path ? '=' : g === GROUND.floorAlt ? '.' : g >= SURFACE_BASE ? sg[(g - SURFACE_BASE) % 4] : g === GROUND.void ? ' ' : ' ';
  }
  console.log(row);
}
console.log(spec.props.map((p, i) => `${glyph[i]}=${p.name}`).join('  '));
console.log(lay.rooms.map((r) => `${r.name}@${r.x},${r.y} ${r.w}x${r.h}`).join(' | '));
console.log(`packs ${lay.packSpots.length} chests ${lay.chestSpots.length} traps ${lay.trapSpots.length} npcs ${lay.npcSpots.length} buildings ${lay.buildings.length}`);
