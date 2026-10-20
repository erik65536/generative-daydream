/** Scratch: compile a default ruleset, run sample fights and a quick balance pass. npx tsx src/cli/simtest.ts [genre] [mode] [quick|full] */
import { Rng } from '@gd/shared';
import { compileRuleset } from '../rules/compile';
import { defaultIntent } from '../rules/defaults';
import { buildPack } from '../rules/encounters';
import { makeParty, runFight } from '../rules/sim';
import { balanceRuleset } from '../rules/balance';
import type { Genre } from '../rules/genre';

const genre = (process.argv[2] ?? 'fantasy') as Genre;
const mode = (process.argv[3] ?? 'party_manual') as 'solo' | 'party_manual' | 'party_npc';
const quick = (process.argv[4] ?? 'quick') === 'quick';
const r = compileRuleset(defaultIntent(genre), { genre, maxLevel: 8 });
console.log(`ruleset "${r.name}": ${r.classes.length} classes, ${r.skills.length} skills, ${r.items.length} items, ${r.affixes.length} affixes, ${r.statuses.length} statuses`);
for (const c of r.classes) console.log(`  ${c.name} (${c.role}) start: ${c.startingSkills.join(', ')}; nodes ${c.nodes.length}`);
const t0 = Date.now();
for (const level of [1, 4, 8]) {
  let wins = 0, hp = 0, rounds = 0;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const rng = new Rng(`t${level}:${i}`);
    const classes = mode === 'solo' ? [r.classes[i % r.classes.length]!.id] : Array.from({ length: 4 }, (_, j) => r.classes[(i + j) % r.classes.length]!.id);
    const party = makeParty(r, { classes, level, rng });
    const pack = buildPack(r, rng, { mode, level, kind: 'normal' });
    const res = runFight(r, { party, pack, potions: 0, difficulty: 'normal', seed: `s${level}${i}` });
    wins += res.win ? 1 : 0;
    hp += res.hpLost;
    rounds += res.rounds;
  }
  console.log(`level ${level}: win ${wins}/${n}, hp lost ${(hp / n).toFixed(2)}, rounds ${(rounds / n).toFixed(1)}`);
}
console.log(`fights took ${Date.now() - t0} ms`);
const rep = balanceRuleset(r, { mode, seed: 'bal', quick, budgetMs: quick ? 120_000 : 15 * 60_000, onProgress: (m, f) => console.log(`  [${Math.round(f * 100)}%] ${m}`) });
console.log(rep.notes.join('\n'));
for (const s of rep.scenarios) console.log(`${s.ok ? 'OK ' : 'OFF'} ${s.label}: win ${s.winRate}, hp ${s.hpLost}, rounds ${s.rounds}`);
console.log('monsterHp', JSON.stringify(r.curves.monsterHp), 'monsterDmg', JSON.stringify(r.curves.monsterDmg));
console.log('elite', r.elite, 'boss', r.boss, 'outliers', rep.outliers);
console.log(`balance took ${(rep.durationMs / 1000).toFixed(1)}s, ${rep.fights} fights`);
