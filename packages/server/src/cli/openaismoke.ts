/**
 * Quick checks of the configured cloud models with timings and cost: a world concept (structured output),
 * image prompts for a few assets, and the art checker on images with known quality.
 *
 *   tsx src/cli/openaismoke.ts [worldIdForImages]
 */
import fs from 'node:fs';
import path from 'node:path';
import { genai } from '../genai/service';
import { openaiCost, openaiUsage } from '../genai/providers';
import { qualityCheck } from '../genai/images';
import { ConceptSchema } from '../worldgen/schemas';
import { conceptPrompt, SYSTEM } from '../worldgen/prompts';
import { loadWorld, worldAssetDir } from '../storage';
import { planAssets, writeImagePrompts } from '../worldgen/art';

const g = genai();
const t = () => performance.now();
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

let t0 = t();
const concept = await g.structured('world.design', {
  system: SYSTEM,
  prompt: conceptPrompt({ setting: 'A sunken lighthouse city where the tide never goes out; bell-ringers keep the drowned spirits asleep.', size: 'small', length: 'short', communication: 2, combatMode: 'party_npc', art: 'full' }),
  schema: ConceptSchema,
  name: 'world_concept',
  maxTokens: 4000,
});
console.log(`concept (${secs(t0)}): "${concept.title}" — ${concept.pitch}\n  art style: ${concept.artStyle}\n  player: ${concept.playerRole}`);

const worldId = process.argv[2] ?? 'w_livemvd05zun';
const w = loadWorld(worldId);
if (w) {
  const plan = planAssets({ ...w, assets: {} }, 'full').filter((r) => !r.ref).filter((_, i) => i % 40 === 0).slice(0, 6);
  t0 = t();
  await writeImagePrompts(w, plan, () => {});
  console.log(`\nimage prompts (${secs(t0)}):`);
  for (const r of plan) console.log(`- ${r.key}: ${(r.imagePrompt ?? '(none)').slice(0, 220)}…`);

  const dir = worldAssetDir(w.id);
  for (const key of ['spr_npc_n_brenda_kowalski_0', 'tex_ts_d0_0_water', 'obj_ts_t0_0_sign']) {
    const a = w.assets[key];
    if (!a?.file || !fs.existsSync(path.join(dir, a.file))) continue;
    t0 = t();
    const r = await qualityCheck(fs.readFileSync(path.join(dir, a.file)), a.kind, a.prompt);
    console.log(`\ncheck ${key} (${secs(t0)}): score ${r?.score.toFixed(1)} ${r?.problems.join('; ') || 'no problems'}`);
  }
}
console.log(`\nusage: ${JSON.stringify(openaiUsage)}  ≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
