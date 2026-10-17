/** Generate one world end to end with the configured models: npx tsx src/cli/genlive.ts "<setting>" [art=essential|full|none] */
import { WorldGenJob, runGeneration } from '../worldgen/pipeline';

const setting = process.argv[2] ?? 'A fog-bound coastal barony where drowned bells ring under the tide and smugglers bargain with things from the deep.';
const art = (process.argv[3] ?? 'essential') as 'none' | 'essential' | 'full';
const id = `w_live${Date.now().toString(36)}`;
const job = new WorldGenJob(id, { setting, size: 'small', length: 'short', communication: 2, combatMode: 'party_manual', art }, { id: 'cli', name: 'CLI' });
const t0 = Date.now();
try {
  await runGeneration(job);
  console.log(`DONE ${id} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
} catch (e) {
  console.error('FAILED', e);
  process.exitCode = 1;
}
