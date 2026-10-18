/**
 * Generate one world end to end with the configured models:
 *   npx tsx src/cli/genlive.ts "<setting>" [none|essential|full] [--story "..."] [--notes "..."] [--owner <userId> <name>] [--mode solo|party_manual|party_npc]
 */
import { WorldGenJob, runGeneration } from '../worldgen/pipeline';
import { openaiCost, openaiUsage } from '../genai/providers';

const args = process.argv.slice(2);
const opt = (name: string, n = 1) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.slice(i + 1, i + 1 + n) : undefined;
};
const setting = args[0] && !args[0].startsWith('--') ? args[0] : 'A fog-bound coastal barony where drowned bells ring under the tide and smugglers bargain with things from the deep.';
const art = (args[1] && !args[1].startsWith('--') ? args[1] : 'essential') as 'none' | 'essential' | 'full';
const [ownerId, ownerName] = opt('owner', 2) ?? ['cli', 'CLI'];
const mode = (opt('mode')?.[0] ?? 'party_manual') as 'solo' | 'party_manual' | 'party_npc';
const id = `w_live${Date.now().toString(36)}`;
const job = new WorldGenJob(id, { setting, story: opt('story')?.[0], notes: opt('notes')?.[0], size: 'small', length: 'short', communication: 2, combatMode: mode, art }, { id: ownerId!, name: ownerName ?? 'CLI' });
const t0 = Date.now();
let lastPhase = '';
const timer = setInterval(() => {
  const active = job.phases.find((p) => p.status === 'active');
  const label = active ? `${active.label}${active.total ? ` ${active.done ?? 0}/${active.total}` : ''}` : job.step;
  if (label !== lastPhase) console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] >> ${label}`);
  lastPhase = label;
}, 5000);
try {
  await runGeneration(job);
  console.log(`DONE ${id} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`OpenAI usage: ${JSON.stringify(openaiUsage)} ≈ $${openaiCost().toFixed(3)}`);
} catch (e) {
  console.error('FAILED', e);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
