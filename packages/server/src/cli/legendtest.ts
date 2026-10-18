/** Forge a few legendary items for a daydream and print them: tsx src/cli/legendtest.ts <worldId> [n] */
import { Rng, itemLines } from '@gd/shared';
import { loadWorld } from '../storage';
import { rollRandomItem } from '../game/loot';
import { forgeLegend } from '../game/legends';
import { openaiCost } from '../genai/providers';

const [worldId, n = '3'] = process.argv.slice(2);
const w = loadWorld(worldId!)!;
const r = w.ruleset;
const rng = new Rng('legend');
for (let i = 0; i < Number(n); i++) {
  const item = rollRandomItem(r, rng, 4, 0, { minRarity: r.rarities.length - 1 });
  const t0 = performance.now();
  const made = await forgeLegend(r, item, { world: w.concept, place: w.zones[i % w.zones.length]!.name, source: w.bosses[0] ? `${w.bosses[0].name}, ${w.bosses[0].title}` : 'a sealed chest' });
  if (!made) { console.log('no legend'); continue; }
  item.uniqueId = made.def.id;
  item.uniqueMods = made.mods;
  console.log(`\n${made.def.name} (${((performance.now() - t0) / 1000).toFixed(1)}s)\n  ${made.def.description}\n  ${itemLines(r, item).join(' · ')}`);
}
console.log(`\n≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
