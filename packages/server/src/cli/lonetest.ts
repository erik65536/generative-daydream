/** Dev check: how a lone hero fares against packs fitted from a companions-world design. */
import { Rng } from '@gd/shared';
import { compileRuleset } from '../rules/compile';
import { defaultIntent } from '../rules/defaults';
import { balanceRuleset } from '../rules/balance';
import { buildPack, fittedPack } from '../rules/encounters';
import { makeParty, runFight } from '../rules/sim';

const r = compileRuleset(defaultIntent('fantasy'), { genre: 'fantasy', maxLevel: 8 });
balanceRuleset(r, { mode: 'party_npc', seed: 'npc', quick: true, budgetMs: 30_000 });
for (const size of [1, 2]) for (const fit of [false, true]) {
  let wins = 0, hp = 0;
  const n = 30;
  for (let i = 0; i < n; i++) {
    const rng = new Rng(`lone:${size}:${i}`);
    const party = makeParty(r, { classes: Array.from({ length: size }, (_, j) => r.classes[(i + j) % r.classes.length]!.id), level: 4, rng });
    const base = buildPack(r, rng, { mode: 'party_npc', level: 4, kind: 'normal' });
    const pack = fit ? fittedPack(r, base, { mode: 'party_npc', partySize: size, difficulty: 'normal', rng }) : base;
    const res = runFight(r, { party, pack, potions: 0, difficulty: 'normal', seed: `l${i}` });
    if (res.win) wins++;
    hp += res.hpLost;
  }
  console.log(`party ${size} ${fit ? 'fitted' : 'unfitted'}: win ${(wins / n).toFixed(2)} hpLost ${(hp / n).toFixed(2)}`);
}
