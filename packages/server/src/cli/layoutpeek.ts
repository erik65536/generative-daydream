/** Dev check: ASCII view of a generated layout. Usage: tsx src/cli/layoutpeek.ts <town|wilderness|dungeon> ['<plan json>'] */
import { GROUND, OBJ, Rng } from '@gd/shared';
import { generateDungeon, generateTown, generateWilderness, resolvePlan } from '../worldgen/layout';

const [kind = 'wilderness', json] = process.argv.slice(2);
const plan = resolvePlan(kind as 'town' | 'wilderness' | 'dungeon', json ? JSON.parse(json) : undefined);
console.log(JSON.stringify(plan));
const rng = new Rng('peek');
const lay = kind === 'town'
  ? generateTown(rng, { size: 50, buildingCount: 6, edges: ['n', 'e'], plan })
  : kind === 'dungeon'
    ? generateDungeon(rng, { size: 54, caves: plan.structure === 'caves' })
    : generateWilderness(rng, { size: 62, edges: ['n', 'w'], internalExits: 1, style: 'stone', plan });
const m = lay.map;
const ch: Record<number, string> = { [OBJ.tree]: 'T', [OBJ.rock]: 'o', [OBJ.plant]: ',', [OBJ.light]: '*', [OBJ.furniture]: 'F', [OBJ.rubble]: '.', [OBJ.pillar]: 'I' };
for (let y = 0; y < m.h; y++) {
  let row = '';
  for (let x = 0; x < m.w; x++) {
    const o = m.o(x, y), g = m.g(x, y);
    row += o ? ch[o] ?? '?' : g === GROUND.wall ? '#' : g === GROUND.water ? '~' : g === GROUND.path ? '=' : g === GROUND.floorAlt ? '-' : ' ';
  }
  console.log(row);
}
