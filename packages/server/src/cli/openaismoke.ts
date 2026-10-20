/**
 * Quick checks of the configured cloud models with timings and cost: a world concept (structured output),
 * and image prompts (with their backdrops and views) for a few assets.
 *
 *   tsx src/cli/openaismoke.ts [worldIdForImages]
 */
import { genai } from '../genai/service';
import { openaiCost, openaiUsage } from '../genai/providers';
import { ConceptSchema } from '../worldgen/schemas';
import { conceptPrompt, SYSTEM } from '../worldgen/prompts';
import { loadWorld } from '../storage';
import { planAssets, writeImagePrompts } from '../worldgen/art';

const g = genai();
const t = () => performance.now();
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

let t0 = t();
const concept = await g.structured('world.design', {
  system: SYSTEM,
  prompt: conceptPrompt({ setting: 'A sunken lighthouse city where the tide never goes out; bell-ringers keep the drowned spirits asleep.', size: 'small', length: 'short', communication: 2, combatMode: 'party_npc' }),
  schema: ConceptSchema,
  name: 'world_concept',
  maxTokens: 4000,
});
console.log(`concept (${secs(t0)}): "${concept.title}" — ${concept.pitch}\n  art style: ${concept.artStyle}\n  player: ${concept.playerRole}`);

const worldId = process.argv[2] ?? 'w_livemvd05zun';
const w = loadWorld(worldId);
if (w) {
  const plan = planAssets({ ...w, assets: {} }, 'full').filter((_, i) => i % 40 === 0).slice(0, 6);
  t0 = t();
  await writeImagePrompts(w, plan, () => {});
  console.log(`\nimage prompts (${secs(t0)}):`);
  for (const r of plan) console.log(`- ${r.key} [${r.backdrop ?? '?'}${r.view ? `, ${r.view}` : ''}]: ${(r.imagePrompt ?? '(none)').slice(0, 220)}…`);

}
console.log(`
usage: ${JSON.stringify(openaiUsage)}  ≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
