import { describe, expect, it } from 'vitest';
import { genWorld } from './helpers';
import { instances } from '../src/game/manager';
import { Combat } from '../src/game/combat';
import { CharActor, MonsterActor } from '../src/game/actors';
import { grantXp } from '../src/game/characters';
import type { WorldDefinition } from '@gd/shared';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fight(w: WorldDefinition, seed: number, origins: string[], level: number, zoneKind: 'wilderness' | 'dungeon') {
  const inst = instances.create(w, `u${seed}`, 'Sim', `sim ${seed}`, origins.map((o, i) => ({ name: `Hero${i}`, originId: o })));
  inst.join({ userId: `u${seed}`, send: () => {} });
  const p = inst.state.players[`u${seed}`]!;
  for (const ch of p.party) {
    if (level > 1) grantXp(ch, [0, 0, 160, 466, 964, 1700][level] ?? 0, w);
    ch.npcId = 'sim'; // let the AI drive the heroes too
    ch.attributes[ch.originId === 'o_mage' || ch.originId === 'o_occultist' ? 'intellect' : ch.originId === 'o_cleric' ? 'spirit' : ch.originId === 'o_ranger' || ch.originId === 'o_rogue' ? 'finesse' : 'might'] += ch.unspentAttributes;
    ch.unspentAttributes = 0;
  }
  const zone = w.zones.filter((z) => z.kind === zoneKind && z.levelRange[0] <= level + 1)[seed % 2] ?? w.zones.find((z) => z.kind === zoneKind)!;
  inst.transfer(p, zone.id);
  const live = inst._live(zone.id);
  const monsters = [...live.actors.values()].filter((a): a is MonsterActor => a instanceof MonsterActor && a.alive() && !a.boss);
  const target = monsters[seed % monsters.length]!;
  const heroes = inst._charActors(`u${seed}`);
  heroes.forEach((h, i) => {
    h.x = Math.round(target.x) + 4 + (i % 2);
    h.y = Math.round(target.y) + (i > 1 ? 1 : 0);
  });
  const combat = inst.startCombat(live as never, target, heroes[0]!, false)!;
  const pack = combat.participants().filter((a) => a instanceof MonsterActor).length;
  for (let i = 0; i < 3000 && !combat.ended; i++) await wait(1);
  const enemiesLeft = combat.participants().filter((a) => a instanceof MonsterActor && a.alive()).length;
  const win = combat.ended && enemiesLeft === 0;
  const hpFrac = win ? heroes.reduce((s, h: CharActor) => s + (h.alive() ? h.hp / h.stats().maxHp : 0), 0) / heroes.length : 0;
  const res = { win, rounds: combat.round, pack, hpFrac, level: target.level };
  inst.leave({ userId: `u${seed}`, send: () => {} } as never);
  instances.drop(inst.state.id);
  return res;
}

describe('combat balance', () => {
  it('solo heroes usually win early fights, but not trivially', async () => {
    Combat.instant = true;
    const w = await genWorld('A misty kingdom of dragons and ruined castles', 'small', 'solo');
    const results = [];
    const origins = ['o_warrior', 'o_ranger', 'o_mage', 'o_cleric', 'o_rogue', 'o_occultist'];
    for (let i = 0; i < 18; i++) results.push(await fight(w, i, [origins[i % origins.length]!], 1, 'wilderness'));
    const wins = results.filter((r) => r.win).length;
    const avgRounds = results.reduce((s, r) => s + r.rounds, 0) / results.length;
    const avgHp = results.filter((r) => r.win).reduce((s, r) => s + r.hpFrac, 0) / Math.max(1, wins);
    console.log(`[balance] solo L1: ${wins}/${results.length} wins, avg rounds ${avgRounds.toFixed(1)}, avg hp left ${(avgHp * 100).toFixed(0)}%, packs ${results.map((r) => r.pack).join(',')}`);
    console.log(`[balance] by origin: ${origins.map((o, i) => `${o}:${results.filter((_, j) => j % 6 === i && results[j]!.win).length}/3`).join(' ')}`);
    // The AI plays both sides and never drinks potions, so this is a floor, not the target experience.
    expect(wins / results.length).toBeGreaterThanOrEqual(0.4);
    expect(avgRounds).toBeGreaterThan(2);
  }, 120000);

  it('a party of four handles a dungeon pack', async () => {
    Combat.instant = true;
    const w = await genWorld('A misty kingdom of dragons and ruined castles', 'small', 'party_manual');
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await fight(w, 100 + i, ['o_warrior', 'o_ranger', 'o_mage', 'o_cleric'], 3, 'dungeon'));
    const wins = results.filter((r) => r.win).length;
    console.log(`[balance] party L3 dungeon: ${wins}/${results.length} wins, avg rounds ${(results.reduce((s, r) => s + r.rounds, 0) / results.length).toFixed(1)}, packs ${results.map((r) => r.pack).join(',')}`);
    expect(wins / results.length).toBeGreaterThanOrEqual(0.6);
  }, 120000);
});
