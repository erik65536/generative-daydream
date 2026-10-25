/**
 * Generate one world end to end with the configured models:
 *   npx tsx src/cli/genlive.ts "<theme>" [--prompt <topic> "..."]... [--size small|medium|large] [--length short|medium|long|epic]
 *     [--mode solo|party_manual|party_npc] [--fast-travel] [--owner <userId> <name>] [--resume <worldId> <seed>]
 * (topics: story, places, people, monsters, rules, art)
 */
import { PROMPT_TOPICS, type GameLength, type PromptTopic, type WorldSize } from '@gd/shared';
import { WorldGenJob, runGeneration } from '../worldgen/pipeline';
import { openaiCost, openaiUsage } from '../genai/providers';

const args = process.argv.slice(2);
const opt = (name: string, n = 1) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.slice(i + 1, i + 1 + n) : undefined;
};
const theme = args[0] && !args[0].startsWith('--') ? args[0] : 'A fog-bound coastal barony where drowned bells ring under the tide and smugglers bargain with things from the deep.';
const prompts = args.flatMap((a, i) => (a === '--prompt' && PROMPT_TOPICS.includes(args[i + 1] as PromptTopic) && args[i + 2] ? [{ topic: args[i + 1] as PromptTopic, text: args[i + 2]! }] : []));
const [ownerId, ownerName] = opt('owner', 2) ?? ['cli', 'CLI'];
const mode = (opt('mode')?.[0] ?? 'party_manual') as 'solo' | 'party_manual' | 'party_npc';
// --resume <worldId> <seed> continues a build that stopped (every finished step is kept).
const [resumeId, resumeSeed] = opt('resume', 2) ?? [];
const id = resumeId ?? `w_live${Date.now().toString(36)}`;
const input = {
  theme, prompts, size: (opt('size')?.[0] ?? 'small') as WorldSize, length: (opt('length')?.[0] ?? 'short') as GameLength, communication: 2 as const, combatMode: mode,
  rules: args.includes('--fast-travel') ? { fastTravel: true } : undefined,
};
const job = new WorldGenJob(id, input, { id: ownerId!, name: ownerName ?? 'CLI' });
const t0 = Date.now();
let lastPhase = '';
const timer = setInterval(() => {
  // Stages run side by side: show every active one, and the overall progress.
  const active = job.phases.filter((p) => p.status === 'active').map((p) => `${p.label}${p.total ? ` ${p.done ?? 0}/${p.total}` : ''}`);
  const label = `${Math.round(job.progress * 100)}% ${active.join(' · ') || job.step}`;
  if (label !== lastPhase) console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] >> ${label}`);
  lastPhase = label;
}, 5000);
try {
  await runGeneration(job, resumeSeed);
  console.log(`DONE ${id} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`OpenAI usage: ${JSON.stringify(openaiUsage)} ≈ $${openaiCost().toFixed(3)}`);
} catch (e) {
  console.error('FAILED', e);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
